package main

import (
	"slices"
	"sort"
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
	whoSure      = 0.80 // from who_thresholds.json "sure"
	whoOutfit    = 0.70 // "outfit"
	whoMargin    = 0.08 // "margin": clearly more alike than anyone else
	whoGroup     = 0.70 // unknown people this alike are shown together (= whoOutfit)
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
			if a.Person == "" || b.Person == "" || a.Person == b.Person || abs64(a.T-b.T) > 2000 || iou(a.Box, b.Box) < 0.3 {
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
	var out []string
	for _, s := range ss {
		if s.Person != "" && !bad[s] && !slices.Contains(out, s.Person) {
			out = append(out, s.Person)
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
