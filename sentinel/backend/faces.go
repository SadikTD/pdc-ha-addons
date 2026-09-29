package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Faces: who a person is. After an event gets the "person" label, a few of its frames
// are looked at again in full quality: every person the detector finds is cropped, the
// face in the top of that crop (if any, and if it's clear enough) gets a fingerprint,
// and the fingerprint is compared with the faces of the people the user has named.
// Faces nobody has named yet are grouped (same person, most likely) so naming one group
// names them all; every face the user confirms makes that person easier to recognise.
//
// Cameras that look down from the ceiling rarely see a face, so each person crop also
// keeps the colours of their clothes: a sighting without a usable face, the same day and
// in daylight, whose clothes clearly match one named person's, is that person "by
// clothing" (shown as such, it's the weaker kind of evidence).
//
// Everything stays on the Pi: /media/sentinel/faces holds the people, the sightings with
// their fingerprints (as long as the events they belong to) and small face pictures.

const (
	faceMatch   = 0.42 // a named person's faces must be this alike (mean of the closest three)
	faceMargin  = 0.07 // ...and clearly more alike than anyone else's
	faceLearn   = 0.55 // a match this sure is kept as one of the person's faces
	faceGroup   = 0.42 // unknown faces this alike are shown together
	faceSuggest = 0.32 // an unknown group this alike to someone is shown as "Is this …?"
	faceJunk    = 0.5  // like a "not a face": not a face either
	faceMinQ    = 0.3  // worse faces are kept, but not matched or shown
	lookMatch   = 0.78 // clothes: histogram overlap
	lookMargin  = 0.08
	lookWindow  = 6 * time.Hour
	galleryMax  = 300 // faces kept per person
)

// Who is someone recognised in an event.
type Who struct {
	Person string `json:"person"`
	Name   string `json:"name"`
	By     string `json:"by"` // "face" or "clothing"
}

type Person struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Created int64  `json:"created"`
}

// Seen is one person in one frame of an event.
type Seen struct {
	ID     string   `json:"id"`
	Cam    string   `json:"cam"`
	Event  string   `json:"event"`
	T      int64    `json:"t"`
	Box    Rect     `json:"box"`              // the person, in the frame
	Night  bool     `json:"night,omitempty"`  // infrared picture: no colours
	Look   string   `json:"look,omitempty"`   // clothing colours
	Face   *Rect    `json:"face,omitempty"`   // the face, in the frame
	Q      float64  `json:"q,omitempty"`      // face quality 0..1
	Emb    string   `json:"emb,omitempty"`    // face fingerprint
	Person string   `json:"person,omitempty"` // who it is
	By     string   `json:"by,omitempty"`     // "you" (named by the user) or "face" (recognised)
	Sim    float64  `json:"sim,omitempty"`    // how alike, when recognised
	Not    []string `json:"not,omitempty"`    // people the user said it isn't
	Junk   bool     `json:"junk,omitempty"`   // the user said it's not a face

	emb  []float32
	look []float32
}

func (s *Seen) hasFace() bool { return s.emb != nil && !s.Junk }

type Faces struct {
	app  *App
	root string
	wake chan struct{}

	mu     sync.Mutex
	people []Person
	seen   map[string]*Seen // id -> sighting
	dirty  map[string]bool  // days to save
	status FaceStatus
}

type FaceStatus struct {
	Enabled bool   `json:"enabled"`
	Error   string `json:"error,omitempty"`
	Backlog int    `json:"backlog"`
	Done    int    `json:"done"` // events looked at since start
	Faces   int    `json:"faces"`
}

func newFaces(app *App) *Faces {
	f := &Faces{app: app, root: filepath.Join(app.media, "faces"), wake: make(chan struct{}, 1), seen: map[string]*Seen{}, dirty: map[string]bool{}}
	_ = os.MkdirAll(filepath.Join(f.root, "img"), 0o755)
	_ = os.MkdirAll(filepath.Join(f.root, "seen"), 0o755)
	if b, err := os.ReadFile(filepath.Join(f.root, "people.json")); err == nil {
		_ = json.Unmarshal(b, &f.people)
	}
	files, _ := filepath.Glob(filepath.Join(f.root, "seen", "*.json"))
	for _, p := range files {
		var list []*Seen
		if b, err := os.ReadFile(p); err == nil && json.Unmarshal(b, &list) == nil {
			for _, s := range list {
				s.emb, s.look = decodeVec(s.Emb), decodeVec(s.Look)
				f.seen[s.ID] = s
			}
		}
	}
	return f
}

func (f *Faces) Poke() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

func (f *Faces) enabled() bool { return f.app.settings.Get().FaceRecognition }

// ---- storage ----

func dayOf(ms int64) string { return time.UnixMilli(ms).In(time.Local).Format("20060102") }

func (f *Faces) savePeopleLocked() {
	b, _ := json.MarshalIndent(f.people, "", " ")
	_ = writeFileAtomic(filepath.Join(f.root, "people.json"), b, 0o644)
}

// saveLocked writes the days that changed.
func (f *Faces) saveLocked() {
	if len(f.dirty) == 0 {
		return
	}
	byDay := map[string][]*Seen{}
	for _, s := range f.seen {
		if d := dayOf(s.T); f.dirty[d] {
			byDay[d] = append(byDay[d], s)
		}
	}
	for d := range f.dirty {
		p := filepath.Join(f.root, "seen", d+".json")
		list := byDay[d]
		if len(list) == 0 {
			_ = os.Remove(p)
			continue
		}
		sort.Slice(list, func(i, j int) bool { return list[i].T < list[j].T })
		b, _ := json.Marshal(list)
		_ = writeFileAtomic(p, b, 0o644)
	}
	f.dirty = map[string]bool{}
}

func (f *Faces) touchLocked(s *Seen) { f.dirty[dayOf(s.T)] = true }

func (f *Faces) imgPath(id string) string { return filepath.Join(f.root, "img", id+".jpg") }

func encodeVec(v []float32) string {
	if v == nil {
		return ""
	}
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(x))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func decodeVec(s string) []float32 {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 || len(b)%4 != 0 {
		return nil
	}
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
	}
	return v
}

func dot(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	var s float64
	for i := range a {
		s += float64(a[i]) * float64(b[i])
	}
	return s
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Cleanup drops sightings whose events are gone (retention), except the faces the user
// named: they are what recognition learns from (at most galleryMax per person, the best).
func (f *Faces) Cleanup() {
	f.mu.Lock()
	defer f.mu.Unlock()
	perPerson := map[string][]*Seen{}
	for id, s := range f.seen {
		if s.By == "you" && s.Person != "" {
			perPerson[s.Person] = append(perPerson[s.Person], s)
			continue
		}
		if _, ok := f.app.events.Get(s.Cam, s.Event); !ok {
			delete(f.seen, id)
			_ = os.Remove(f.imgPath(id))
			f.touchLocked(s)
		}
	}
	for _, list := range perPerson {
		if len(list) <= galleryMax {
			continue
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Q > list[j].Q })
		for _, s := range list[galleryMax:] {
			delete(f.seen, s.ID)
			_ = os.Remove(f.imgPath(s.ID))
			f.touchLocked(s)
		}
	}
	f.saveLocked()
}

// ---- recognition ----

// galleriesLocked: each named person's known faces (named by the user, or recognised
// surely enough), and the faces the user said aren't faces.
func (f *Faces) galleriesLocked() (map[string][][]float32, [][]float32) {
	g := map[string][][]float32{}
	var junk [][]float32
	for _, s := range f.seen {
		switch {
		case s.Junk && s.emb != nil:
			junk = append(junk, s.emb)
		case s.hasFace() && s.Person != "" && (s.By == "you" || s.By == "face" && s.Sim >= faceLearn):
			g[s.Person] = append(g[s.Person], s.emb)
		}
	}
	return g, junk
}

// closeness: how alike v is to a person's faces (the mean of the three most alike, so
// one lookalike picture doesn't decide).
func closeness(v []float32, faces [][]float32) float64 {
	best := [3]float64{-1, -1, -1}
	for _, e := range faces {
		s := dot(v, e)
		if s > best[0] {
			best[0] = s
			sort.Float64s(best[:])
		}
	}
	n, sum := 0, 0.0
	for _, b := range best {
		if b > -1 {
			sum += b
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

// bestMatch: the person v most looks like, how much, and the runner-up's score.
func bestMatch(v []float32, g map[string][][]float32, not []string) (string, float64, float64) {
	best, bs, second := "", 0.0, 0.0
	for p, faces := range g {
		if slices.Contains(not, p) {
			continue
		}
		s := closeness(v, faces)
		if s > bs {
			best, bs, second = p, s, bs
		} else if s > second {
			second = s
		}
	}
	return best, bs, second
}

func isJunk(v []float32, junk [][]float32) bool {
	for _, j := range junk {
		if dot(v, j) >= faceJunk {
			return true
		}
	}
	return false
}

// matchLocked (re)decides who each face not named by the user is.
func (f *Faces) matchLocked(list []*Seen) {
	g, junk := f.galleriesLocked()
	for _, s := range list {
		if !s.hasFace() || s.By == "you" {
			continue
		}
		p, sim := "", 0.0
		if s.Q >= faceMinQ && !isJunk(s.emb, junk) {
			if best, bs, second := bestMatch(s.emb, g, s.Not); bs >= faceMatch && bs-second >= faceMargin {
				p, sim = best, bs
			}
		}
		if p != s.Person || math.Abs(sim-s.Sim) > 0.005 {
			s.Person, s.Sim = p, sim
			s.By = map[bool]string{true: "face", false: ""}[p != ""]
			f.touchLocked(s)
		}
	}
}

func (f *Faces) nameOfLocked(id string) string {
	for _, p := range f.people {
		if p.ID == id {
			return p.Name
		}
	}
	return ""
}

// whoLocked works out who was in each event of the sightings' days (names by face, then
// by clothing), and stores it on the events.
func (f *Faces) whoLocked(days map[string]bool) {
	byDay := map[string][]*Seen{}
	for _, s := range f.seen {
		if d := dayOf(s.T); days == nil || days[d] {
			byDay[d] = append(byDay[d], s)
		}
	}
	type key struct{ cam, event string }
	for _, list := range byDay {
		named := []*Seen{}
		for _, s := range list {
			if s.Person != "" && s.look != nil && !s.Night {
				named = append(named, s)
			}
		}
		events := map[key][]*Seen{}
		for _, s := range list {
			events[key{s.Cam, s.Event}] = append(events[key{s.Cam, s.Event}], s)
		}
		for k, ss := range events {
			var who []Who
			add := func(p, by string) {
				if i := slices.IndexFunc(who, func(w Who) bool { return w.Person == p }); i >= 0 {
					if by == "face" {
						who[i].By = "face"
					}
					return
				}
				if name := f.nameOfLocked(p); name != "" {
					who = append(who, Who{Person: p, Name: name, By: by})
				}
			}
			for _, s := range ss {
				if s.Person != "" {
					add(s.Person, "face")
				}
			}
			for _, s := range ss {
				if s.Person != "" || s.Night || s.look == nil {
					continue
				}
				if p := clothesMatch(s, named); p != "" {
					add(p, "clothing")
				}
			}
			sort.SliceStable(who, func(i, j int) bool { return who[i].By == "face" && who[j].By != "face" })
			f.app.events.SetWho(k.cam, k.event, who)
		}
	}
}

// clothesMatch: the named person whose clothes (the same day, within lookWindow, in
// colour) clearly match s's, if one does.
func clothesMatch(s *Seen, named []*Seen) string {
	best := map[string]float64{}
	for _, n := range named {
		if n.Event == s.Event && n.Cam == s.Cam && n.T == s.T {
			continue
		}
		if d := time.Duration(abs64(n.T-s.T)) * time.Millisecond; d > lookWindow {
			continue
		}
		if sim := histOverlap(s.look, n.look); sim > best[n.Person] {
			best[n.Person] = sim
		}
	}
	p, bs, second := "", 0.0, 0.0
	for id, v := range best {
		if v > bs {
			p, bs, second = id, v, bs
		} else if v > second {
			second = v
		}
	}
	if bs >= lookMatch && bs-second >= lookMargin {
		return p
	}
	return ""
}

func histOverlap(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	s := 0.0
	for i := range a {
		s += float64(min(a[i], b[i]))
	}
	return s
}

// ---- looking at events ----

// Run looks at person events, newest first: the ones that just happened at once, older
// ones (e.g. after an update) at most half the time, so recording and live view come first.
func (f *Faces) Run(ctx context.Context) {
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	f.Cleanup()
	for ctx.Err() == nil {
		if !f.enabled() || !f.app.detector.Available() || !f.app.detector.HasModel(modelFaces) {
			f.setStatus(func(st *FaceStatus) {
				st.Enabled = false
				if f.enabled() && f.app.detector.Available() {
					st.Error = "the face models are not installed"
				}
			})
			select {
			case <-ctx.Done():
			case <-f.wake:
			case <-time.After(5 * time.Minute):
			}
			continue
		}
		todo := f.app.events.ForFaces(time.Now().Add(-backfillWindow).UnixMilli(), 100000)
		f.setStatus(func(st *FaceStatus) { st.Enabled, st.Error, st.Backlog = true, "", len(todo) })
		if len(todo) == 0 {
			select {
			case <-ctx.Done():
			case <-f.wake:
			case <-tick.C:
				f.Cleanup()
			}
			continue
		}
		e := todo[0]
		began := time.Now()
		if err := f.process(ctx, e); err != nil && ctx.Err() == nil {
			f.setStatus(func(st *FaceStatus) { st.Error = err.Error() })
			sleepCtx(ctx, 30*time.Second)
			continue
		}
		f.setStatus(func(st *FaceStatus) { st.Done++ })
		// Older events: rest as long as it took (at most half the time).
		if time.Since(time.UnixMilli(e.End)) > 10*time.Minute {
			select {
			case <-ctx.Done():
			case <-time.After(time.Since(began)):
			}
		}
	}
}

func (f *Faces) setStatus(fn func(*FaceStatus)) {
	f.mu.Lock()
	fn(&f.status)
	f.mu.Unlock()
}

func (f *Faces) Status() FaceStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := f.status
	for _, s := range f.seen {
		if s.hasFace() {
			st.Faces++
		}
	}
	return st
}

// Moments looked at: when the person was seen (from the labeler), and a little around it.
func faceMoments(e Event) []int64 {
	var ts []int64
	for _, o := range e.Objects {
		if o.Label == "person" && o.T > 0 {
			ts = append(ts, o.T)
		}
	}
	if len(ts) == 0 {
		ts = append(ts, e.Start+1500)
	}
	base := ts[0]
	for _, d := range []int64{-1500, 1500, 3000, 5000} {
		ts = append(ts, base+d)
	}
	var out []int64
	for _, t := range ts {
		if t < e.Start-500 || e.End != 0 && t > e.End+1000 || slices.ContainsFunc(out, func(x int64) bool { return abs64(x-t) < 700 }) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// process looks for faces (and clothes) of the people in an event, then says who it was.
func (f *Faces) process(ctx context.Context, e Event) error {
	a := f.app
	ctx = lowPriority(ctx)
	size, err := a.detector.Size(modelScan)
	if err != nil {
		return err
	}
	var found []*Seen
	for _, ms := range faceMoments(e) {
		t := time.UnixMilli(ms)
		small, err := a.decodeRGB(ctx, e.Cam, t, fullFrame, size)
		if err != nil {
			continue
		}
		dets, err := a.detectIn(ctx, modelScan, small)
		if err != nil {
			return err
		}
		var people []Detection
		for _, d := range dets {
			if d.Label == "person" && d.Score >= 0.45 && d.Box.W*d.Box.H >= minBoxArea {
				people = append(people, d)
			}
		}
		if len(people) == 0 {
			continue
		}
		if len(people) > 4 {
			people = people[:4]
		}
		// The whole frame in full quality, to crop each person from.
		full, err := a.decodeRGB(ctx, e.Cam, t, fullFrame, 8192)
		if err != nil {
			continue
		}
		for _, p := range people {
			s := &Seen{ID: newID(), Cam: e.Cam, Event: e.ID, T: ms, Box: p.Box}
			s.look, s.Night = clothes(full, p.Box)
			if face, q, emb, thumb := f.face(ctx, full, p.Box); emb != nil {
				s.Face, s.Q, s.emb = &face, q, emb
				if thumb != nil {
					_ = writeFileAtomic(f.imgPath(s.ID), thumb, 0o644)
				}
			}
			found = append(found, s)
		}
	}
	// Keep the best faces (a person standing still gives many of the same), and one
	// clothes-only sighting per frame and person is plenty.
	sort.SliceStable(found, func(i, j int) bool { return found[i].Q > found[j].Q })
	if len(found) > 10 {
		for _, s := range found[10:] {
			_ = os.Remove(f.imgPath(s.ID))
		}
		found = found[:10]
	}
	f.mu.Lock()
	for _, s := range found {
		s.Emb, s.Look = encodeVec(s.emb), encodeVec(s.look)
		f.seen[s.ID] = s
		f.touchLocked(s)
	}
	f.matchLocked(found)
	f.whoLocked(map[string]bool{dayOf(e.Start): true})
	f.saveLocked()
	f.mu.Unlock()
	a.events.SetFacesDone(e.Cam, e.ID)
	return nil
}

// face finds the face of the person in box (in the top part of their crop), if it's
// clear enough to recognise: its place in the frame, quality, fingerprint and picture.
func (f *Faces) face(ctx context.Context, full frameRGB, box Rect) (Rect, float64, []float32, []byte) {
	// Head and shoulders, with some room either side.
	r := Rect{X: box.X - box.W*0.15, Y: box.Y - box.H*0.08, W: box.W * 1.3, H: box.H * 0.62}
	r = clampRect(r)
	x0, y0 := int(r.X*float64(full.w)), int(r.Y*float64(full.h))
	x1, y1 := int((r.X+r.W)*float64(full.w)), int((r.Y+r.H)*float64(full.h))
	cw, ch := x1-x0, y1-y0
	if cw < 16 || ch < 16 {
		return Rect{}, 0, nil, nil
	}
	// Fit into the model's 640x640, enlarging small crops (a face far away is only a few
	// dozen pixels) up to 3x.
	scale := min(640/float64(cw), 640/float64(ch), 3)
	dw, dh := max(int(float64(cw)*scale), 1), max(int(float64(ch)*scale), 1)
	rgb := resizeRGB(full.rgb, full.w, full.h, x0, y0, x1, y1, dw, dh)
	rows, err := f.app.detector.Raw(ctx, modelFaces, rgb, dw, dh)
	if err != nil {
		return Rect{}, 0, nil, nil
	}
	var best []float64
	for _, row := range rows {
		if len(row) < 17+128 {
			continue
		}
		score := row[0]
		// The face must be in the top of this person's box, inside it sideways.
		fx := r.X + (row[1]+row[3]/2)*r.W
		fy := r.Y + (row[2]+row[4]/2)*r.H
		if fx < box.X-box.W*0.1 || fx > box.X+box.W*1.1 || fy > box.Y+box.H*0.45 || fy < box.Y-box.H*0.1 {
			continue
		}
		if best == nil || score > best[0] {
			best = row
		}
	}
	if best == nil {
		return Rect{}, 0, nil, nil
	}
	score, sharp, frontal := best[0], best[15], best[16]
	px := best[4] * float64(ch) // face height in the recording's pixels
	// Not clear enough to say who it is: too small, blurred, side on, or (very sharp and
	// flat) a texture like wood grain.
	if score < 0.72 || px < 28 || sharp < 10 || sharp > 1500 || frontal < 0.2 {
		return Rect{}, 0, nil, nil
	}
	q := 0.4*unit(score, 0.72, 0.95) + 0.35*unit(px, 28, 90) + 0.25*unit(frontal, 0.2, 0.9)
	emb := make([]float32, len(best)-17)
	for i := range emb {
		emb[i] = float32(best[17+i])
	}
	face := Rect{X: r.X + best[1]*r.W, Y: r.Y + best[2]*r.H, W: best[3] * r.W, H: best[4] * r.H}
	return face, q, emb, faceThumb(full, face)
}

func unit(v, lo, hi float64) float64 { return min(max((v-lo)/(hi-lo), 0), 1) }

func clampRect(r Rect) Rect {
	x0, y0 := max(r.X, 0), max(r.Y, 0)
	x1, y1 := min(r.X+r.W, 1), min(r.Y+r.H, 1)
	return Rect{X: x0, Y: y0, W: max(x1-x0, 0), H: max(y1-y0, 0)}
}

// faceThumb: the face with some room around it, 128x128 JPEG.
func faceThumb(full frameRGB, face Rect) []byte {
	cx, cy := (face.X+face.W/2)*float64(full.w), (face.Y+face.H/2)*float64(full.h)
	side := max(face.W*float64(full.w), face.H*float64(full.h)) * 1.6
	x0, y0 := int(max(cx-side/2, 0)), int(max(cy-side/2, 0))
	x1, y1 := int(min(cx+side/2, float64(full.w))), int(min(cy+side/2, float64(full.h)))
	if x1-x0 < 8 || y1-y0 < 8 {
		return nil
	}
	rgb := resizeRGB(full.rgb, full.w, full.h, x0, y0, x1, y1, 128, 128)
	img := image.NewRGBA(image.Rect(0, 0, 128, 128))
	for i := 0; i < 128*128; i++ {
		img.Pix[4*i], img.Pix[4*i+1], img.Pix[4*i+2], img.Pix[4*i+3] = rgb[3*i], rgb[3*i+1], rgb[3*i+2], 255
	}
	var buf bytes.Buffer
	if jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}) != nil {
		return nil
	}
	return buf.Bytes()
}

// resizeRGB scales the part [x0,x1)x[y0,y1) of a w-wide RGB picture to dw x dh (bilinear).
func resizeRGB(src []byte, w, h, x0, y0, x1, y1, dw, dh int) []byte {
	out := make([]byte, dw*dh*3)
	sx := float64(x1-x0) / float64(dw)
	sy := float64(y1-y0) / float64(dh)
	for y := 0; y < dh; y++ {
		fy := float64(y0) + (float64(y)+0.5)*sy - 0.5
		iy := min(max(int(fy), 0), h-2)
		ty := min(max(fy-float64(iy), 0), 1)
		for x := 0; x < dw; x++ {
			fx := float64(x0) + (float64(x)+0.5)*sx - 0.5
			ix := min(max(int(fx), 0), w-2)
			tx := min(max(fx-float64(ix), 0), 1)
			i00, i10 := (iy*w+ix)*3, (iy*w+ix+1)*3
			i01, i11 := ((iy+1)*w+ix)*3, ((iy+1)*w+ix+1)*3
			for c := 0; c < 3; c++ {
				v := float64(src[i00+c])*(1-tx)*(1-ty) + float64(src[i10+c])*tx*(1-ty) + float64(src[i01+c])*(1-tx)*ty + float64(src[i11+c])*tx*ty
				out[(y*dw+x)*3+c] = byte(v + 0.5)
			}
		}
	}
	return out
}

// clothes: the colours of a person's clothes (torso and legs, away from the edges of
// their box), as a histogram of 8 hues x 3 saturations x 3 brightnesses plus 3 greys.
// night: the picture has no colour (infrared), so clothes can't be compared.
func clothes(full frameRGB, box Rect) ([]float32, bool) {
	x0, x1 := box.X+box.W*0.25, box.X+box.W*0.75
	y0, y1 := box.Y+box.H*0.3, box.Y+box.H*0.85
	hist := make([]float32, 8*3*3+3)
	n, satSum := 0, 0.0
	for gy := 0; gy < 40; gy++ {
		for gx := 0; gx < 20; gx++ {
			px := int((x0 + (x1-x0)*(float64(gx)+0.5)/20) * float64(full.w))
			py := int((y0 + (y1-y0)*(float64(gy)+0.5)/40) * float64(full.h))
			if px < 0 || py < 0 || px >= full.w || py >= full.h {
				continue
			}
			i := (py*full.w + px) * 3
			hh, ss, vv := hsv(full.rgb[i], full.rgb[i+1], full.rgb[i+2])
			satSum += ss
			n++
			vb := min(int(vv*3), 2)
			if ss < 0.2 || vv < 0.12 {
				hist[72+vb]++
				continue
			}
			hist[(min(int(hh/45), 7)*3+min(int(ss*3), 2))*3+vb]++
		}
	}
	if n == 0 {
		return nil, false
	}
	for i := range hist {
		hist[i] /= float32(n)
	}
	return hist, satSum/float64(n) < 0.06
}

func hsv(r, g, b byte) (h, s, v float64) {
	rf, gf, bf := float64(r)/255, float64(g)/255, float64(b)/255
	mx, mn := max(rf, gf, bf), min(rf, gf, bf)
	v = mx
	if mx == 0 {
		return 0, 0, 0
	}
	s = (mx - mn) / mx
	if mx == mn {
		return 0, s, v
	}
	switch mx {
	case rf:
		h = 60 * math.Mod((gf-bf)/(mx-mn), 6)
	case gf:
		h = 60 * ((bf-rf)/(mx-mn) + 2)
	default:
		h = 60 * ((rf-gf)/(mx-mn) + 4)
	}
	if h < 0 {
		h += 360
	}
	return h, s, v
}

// ---- what the pages ask for ----

type PersonInfo struct {
	Person
	Faces     int       `json:"faces"`     // known faces (named by you or recognised surely)
	Sightings int       `json:"sightings"` // events with them in the last week
	Last      *LastSeen `json:"last,omitempty"`
	Cover     string    `json:"cover,omitempty"` // face id for the picture
	Best      float64   `json:"-"`
}

type LastSeen struct {
	Cam   string `json:"cam"`
	Event string `json:"event"`
	T     int64  `json:"t"`
}

func (f *Faces) People() []Person {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.people)
}

func (f *Faces) PeopleInfo() []PersonInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []PersonInfo{}
	for _, p := range f.people {
		pi := PersonInfo{Person: p}
		events := map[string]bool{}
		for _, s := range f.seen {
			if s.Person != p.ID {
				continue
			}
			if s.hasFace() && (s.By == "you" || s.Sim >= faceLearn) {
				pi.Faces++
				if s.Q > pi.Best {
					pi.Best, pi.Cover = s.Q, s.ID
				}
			}
			events[s.Cam+"/"+s.Event] = true
			if pi.Last == nil || s.T > pi.Last.T {
				pi.Last = &LastSeen{s.Cam, s.Event, s.T}
			}
		}
		pi.Sightings = len(events)
		out = append(out, pi)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

type FaceInfo struct {
	ID     string  `json:"id"`
	Cam    string  `json:"cam"`
	Event  string  `json:"event"`
	T      int64   `json:"t"`
	Q      float64 `json:"q"`
	By     string  `json:"by,omitempty"`
	Sim    float64 `json:"sim,omitempty"`
	Person string  `json:"person,omitempty"`
}

func faceInfo(s *Seen) FaceInfo {
	return FaceInfo{ID: s.ID, Cam: s.Cam, Event: s.Event, T: s.T, Q: math.Round(s.Q*100) / 100, By: s.By, Sim: math.Round(s.Sim*100) / 100, Person: s.Person}
}

// PersonFaces: the faces taken for someone, surest first (to spot wrong ones).
func (f *Faces) PersonFaces(id string, limit int) []FaceInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	var list []*Seen
	for _, s := range f.seen {
		if s.Person == id && s.hasFace() {
			list = append(list, s)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if (list[i].By == "you") != (list[j].By == "you") {
			return list[i].By == "you"
		}
		return list[i].T > list[j].T
	})
	out := []FaceInfo{}
	for _, s := range list {
		if len(out) >= limit {
			break
		}
		out = append(out, faceInfo(s))
	}
	return out
}

type FaceGroup struct {
	Faces   []FaceInfo `json:"faces"` // the clearest first (up to 12)
	Size    int        `json:"size"`  // all faces in the group
	IDs     []string   `json:"ids"`   // all of them, to name at once
	Suggest *Who       `json:"suggest,omitempty"`
}

// Unknown groups the faces nobody has named yet: most likely the same person in each
// group, biggest groups first (the people seen most).
func (f *Faces) Unknown(limit int) []FaceGroup {
	f.mu.Lock()
	defer f.mu.Unlock()
	g, junk := f.galleriesLocked()
	var list []*Seen
	for _, s := range f.seen {
		if s.hasFace() && s.Person == "" && s.Q >= faceMinQ && !isJunk(s.emb, junk) {
			list = append(list, s)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Q > list[j].Q })
	type cluster struct {
		sum     []float64
		members []*Seen
	}
	var cs []*cluster
	for _, s := range list {
		var best *cluster
		bs := faceGroup
		for _, c := range cs {
			var d, norm float64
			for i, x := range c.sum {
				d += x * float64(s.emb[i])
				norm += x * x
			}
			if norm > 0 {
				if sim := d / math.Sqrt(norm); sim > bs {
					best, bs = c, sim
				}
			}
		}
		if best == nil {
			best = &cluster{sum: make([]float64, len(s.emb))}
			cs = append(cs, best)
		}
		for i, x := range s.emb {
			best.sum[i] += float64(x)
		}
		best.members = append(best.members, s)
	}
	sort.SliceStable(cs, func(i, j int) bool { return len(cs[i].members) > len(cs[j].members) })
	out := []FaceGroup{}
	for _, c := range cs {
		if len(out) >= limit {
			break
		}
		fg := FaceGroup{Size: len(c.members)}
		for _, s := range c.members {
			fg.IDs = append(fg.IDs, s.ID)
			if len(fg.Faces) < 12 {
				fg.Faces = append(fg.Faces, faceInfo(s))
			}
		}
		// Like someone already named, but not enough to say so: ask.
		cen := make([]float32, len(c.sum))
		var norm float64
		for _, x := range c.sum {
			norm += x * x
		}
		for i, x := range c.sum {
			cen[i] = float32(x / math.Sqrt(norm))
		}
		if p, bs, _ := bestMatch(cen, g, nil); p != "" && bs >= faceSuggest {
			fg.Suggest = &Who{Person: p, Name: f.nameOfLocked(p)}
		}
		out = append(out, fg)
	}
	return out
}

// ---- what the user says ----

var errNoPerson = errors.New("no such person")

// Name says these faces are the person id (or a new person called name).
func (f *Faces) Name(ids []string, id, name string) (Person, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var p *Person
	name = strings.TrimSpace(name)
	for i := range f.people {
		if f.people[i].ID == id || id == "" && name != "" && strings.EqualFold(f.people[i].Name, name) {
			p = &f.people[i]
		}
	}
	if p == nil {
		if name == "" {
			return Person{}, errNoPerson
		}
		f.people = append(f.people, Person{ID: newID(), Name: name, Created: time.Now().UnixMilli()})
		p = &f.people[len(f.people)-1]
		f.savePeopleLocked()
	}
	for _, fid := range ids {
		if s, ok := f.seen[fid]; ok && s.emb != nil {
			s.Person, s.By, s.Sim, s.Junk = p.ID, "you", 1, false
			s.Not = slices.DeleteFunc(s.Not, func(x string) bool { return x == p.ID })
			f.touchLocked(s)
		}
	}
	f.relearnLocked()
	return *p, nil
}

// NotPerson says these faces aren't that person (they may still be someone else).
func (f *Faces) NotPerson(ids []string, person string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, fid := range ids {
		if s, ok := f.seen[fid]; ok {
			if !slices.Contains(s.Not, person) {
				s.Not = append(s.Not, person)
			}
			if s.Person == person {
				s.Person, s.By, s.Sim = "", "", 0
			}
			f.touchLocked(s)
		}
	}
	f.relearnLocked()
}

// Junk says these aren't faces (a pattern, a poster): similar ones are ignored too.
func (f *Faces) Junk(ids []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, fid := range ids {
		if s, ok := f.seen[fid]; ok {
			s.Junk, s.Person, s.By, s.Sim = true, "", "", 0
			f.touchLocked(s)
		}
	}
	f.relearnLocked()
}

func (f *Faces) Rename(id, name string) (Person, error) {
	name = strings.TrimSpace(name)
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.people {
		if f.people[i].ID == id {
			if name != "" {
				f.people[i].Name = name
				f.savePeopleLocked()
				f.whoLocked(nil)
			}
			return f.people[i], nil
		}
	}
	return Person{}, errNoPerson
}

// Forget removes a person: their faces become unknown again.
func (f *Faces) Forget(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.people = slices.DeleteFunc(f.people, func(p Person) bool { return p.ID == id })
	f.savePeopleLocked()
	for _, s := range f.seen {
		if s.Person == id {
			s.Person, s.By, s.Sim = "", "", 0
			f.touchLocked(s)
		}
		s.Not = slices.DeleteFunc(s.Not, func(x string) bool { return x == id })
	}
	f.relearnLocked()
}

// relearnLocked: after the user taught something, decide every face again and update
// who was in every event.
func (f *Faces) relearnLocked() {
	all := make([]*Seen, 0, len(f.seen))
	for _, s := range f.seen {
		all = append(all, s)
	}
	// Twice: faces recognised surely in the first pass teach the second.
	f.matchLocked(all)
	f.matchLocked(all)
	f.whoLocked(nil)
	f.saveLocked()
}

// Face returns a sighting (for its picture).
func (f *Faces) Face(id string) (Seen, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.seen[id]
	if !ok {
		return Seen{}, false
	}
	return *s, true
}

// PersonByName finds people named in a search ("mom", "abir").
func (f *Faces) PersonByName(name string) (Person, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.people {
		if strings.EqualFold(p.Name, name) {
			return p, true
		}
	}
	return Person{}, false
}
