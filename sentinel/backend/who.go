package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

// Who model: a small network trained on this home's own footage (D:\sentinel-train\who)
// turns a whole person (head, build, clothes) into a fingerprint, so people are known
// from above, from behind and in infrared too, where faces aren't seen.
//
// Clothes change every day, so the fingerprint names someone only:
//   - surely, when it is very like the pictures the user named (any day), or
//   - by outfit, when it clearly matches someone already known today (named by the user,
//     by face, or surely) within outfitWindow, in the same light (colour or infrared).
//
// Otherwise nobody: a wrong name is worse than none. Thresholds come from eval.py
// (work/who_thresholds.json), measured at ≤1% wrong on days the model never saw.
const (
	whoSure      = 0.98 // from who_thresholds.json "sure" (2026-10-11: by body alone across days only when near certain)
	whoOutfit    = 0.94 // "outfit"
	whoMargin    = 0.04 // "margin": clearly more alike than anyone else
	whoGroup     = 0.94 // unknown people this alike are shown together (= whoOutfit)
	outfitWindow = 12 * time.Hour
	whoDim       = 256
	whoW, whoH   = 128, 256 // the crop the model takes
)

// bodyRef is one example of what someone looked like.
type bodyRef struct {
	person string
	t      int64
	night  bool
	v      []float32
}

// decideWho: who a person's fingerprint v (seen at t) is, and how ("sure"/"outfit").
// today must be sorted by t.
func decideWho(v []float32, t int64, night bool, not []string, long, today []bodyRef) (string, string, float64) {
	if p, s, second := bestRef(v, long, not); p != "" && s >= whoSure && s-second >= whoMargin {
		return p, "sure", s
	}
	if night {
		// ponytail: night (infrared) outfit naming is off: there was no night data to
		// measure it, and at night the memory is often one person, so the margin can't
		// protect a stranger. Turn on once a night eval passes.
		return "", "", 0
	}
	w := outfitWindow.Milliseconds()
	i := sort.Search(len(today), func(i int) bool { return today[i].t >= t-w })
	j := sort.Search(len(today), func(i int) bool { return today[i].t > t+w })
	var near []bodyRef
	for _, r := range today[i:max(i, j)] {
		if r.night == night {
			near = append(near, r)
		}
	}
	if p, s, second := bestRef(v, near, not); p != "" && s >= whoOutfit && s-second >= whoMargin {
		return p, "outfit", s
	}
	return "", "", 0
}

func bestRef(v []float32, refs []bodyRef, not []string) (string, float64, float64) {
	g := map[string][][]float32{}
	for _, r := range refs {
		g[r.person] = append(g[r.person], r.v)
	}
	return bestMatch(v, g, not)
}

// eventPeople: who was in an event. Sightings that are clearly one person (same place
// within 2 s) but carry different names cancel each other, except a name the user gave,
// which always wins.
func eventPeople(ss []*Seen) []string {
	bad := map[*Seen]bool{}
	for i, a := range ss {
		for _, b := range ss[i+1:] {
			if a.Person == "" || b.Person == "" {
				continue
			}
			if a.Person == b.Person {
				// One name on two people seen at the same moment: one of them is wrong.
				if a.T == b.T && iou(a.Box, b.Box) < 0.3 {
					switch {
					case a.By == "you" && b.By != "you":
						bad[b] = true
					case b.By == "you" && a.By != "you":
						bad[a] = true
					case a.By != "you":
						bad[a], bad[b] = true, true
					}
				}
				continue
			}
			if abs64(a.T-b.T) > 2000 || iou(a.Box, b.Box) < 0.3 {
				continue
			}
			switch {
			case a.By == "you" && b.By != "you":
				bad[b] = true
			case b.By == "you" && a.By != "you":
				bad[a] = true
			default:
				bad[a], bad[b] = true, true
			}
		}
	}
	// A name stands if none of its sightings was cancelled, or the user gave it.
	var out []string
	for _, s := range ss {
		if s.Person == "" || bad[s] || slices.Contains(out, s.Person) {
			continue
		}
		cancelled := slices.ContainsFunc(ss, func(x *Seen) bool { return x.Person == s.Person && bad[x] })
		if !cancelled || slices.ContainsFunc(ss, func(x *Seen) bool { return x.Person == s.Person && x.By == "you" && !bad[x] }) {
			out = append(out, s.Person)
		}
	}
	return out
}

// whoModel identifies the who.onnx in use: fingerprints of another (retrained) model
// live in a different space and are redone from their pictures.
var whoModel string

func whoModelIn(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, "who.onnx"))
	if err != nil {
		return ""
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:6])
}

// loadWhoGallery reads who_gallery.json, written next to who.onnx by the training
// (D:\sentinel-train\who\gallery.py): fingerprints of reviewed pictures of each person,
// used like pictures the user named. Missing or unreadable: none.
func loadWhoGallery(path string) []bodyRef {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var list []struct {
		Person string `json:"person"`
		Night  bool   `json:"night"`
		Emb    string `json:"emb"`
	}
	if json.Unmarshal(b, &list) != nil {
		return nil
	}
	var out []bodyRef
	for _, e := range list {
		if v := decodeVec(e.Emb); v != nil && e.Person != "" {
			out = append(out, bodyRef{person: e.Person, night: e.Night, v: v})
		}
	}
	return out
}

// whoBy: how a sighting was named, as events show it ("clothing" = only today's outfit).
func whoBy(by string) string {
	if by == "outfit" {
		return "clothing"
	}
	return "face"
}

// namesWithin: the names for an alert about what ("Person", "2 people"), from fn, if it
// answers within d; otherwise none (the alert says "Person" and isn't held up).
func namesWithin(d time.Duration, what string, fn func() []string) []string {
	if what != "Person" && !strings.HasSuffix(what, " people") {
		return nil
	}
	c := make(chan []string, 1)
	go func() { c <- fn() }()
	select {
	case names := <-c:
		return names
	case <-time.After(d):
		return nil
	}
}
