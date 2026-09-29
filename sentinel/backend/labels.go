package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// The labeler says who was in each motion event: a person, a cat, a dog, or nobody
// (plain motion). It never watches video: when something moves it looks at a handful of
// frames of the recording, so it costs a few seconds of CPU per event, at low priority.
//
// A label needs two independent yeses:
//  1. the fast model sees it, in two frames (or very clearly in one), big enough to
//     judge and outside the camera's ignored areas; when the whole picture shows nobody,
//     it looks again zoomed in on where the picture changed (small, distant cats);
//  2. the big model, looking again at a zoomed-in crop of that spot in full quality,
//     agrees on what it is. It must be surer for things cut off by the picture's edge,
//     and surer again in a spot where lookalikes fooled detection before (laundry, see
//     hotspots.go) or for something that was already there before the motion and hasn't
//     moved (a coat, a statue, someone sitting still). If it sees a different animal, its
//     answer wins; if it sees nothing, there's no label and the spot is remembered.
// Events it can't check (no footage) say so instead of guessing.

var watchLabels = []string{"person", "cat", "dog"}

const (
	scanFound  = 0.35 // fast model: worth a closer look
	scanClear  = 0.60 // fast model: clear enough in a single frame
	minBoxArea = 0.0004
	maxVerify  = 5 // second opinions per label per event
)

// verifyMin is how sure the big model must be.
var verifyMin = map[string]float64{"person": 0.55, "cat": 0.5, "dog": 0.5}

// Frames looked at, as offsets from the start of the event; after these, one every
// longFrameGap while the event lasts, up to maxFrames. After emptyFrames frames in a row
// with nothing at all in them (leaves, light, rain), only one every longFrameGap.
var scanOffsets = []time.Duration{800 * time.Millisecond, 2200 * time.Millisecond, 4 * time.Second, 7 * time.Second, 11 * time.Second, 16 * time.Second}

const (
	longFrameGap = 8 * time.Second
	maxFrames    = 12
	busyFrames   = 4 // when events queue up
	emptyFrames  = 3
)

type LabelerStatus struct {
	Enabled   bool   `json:"enabled"`
	Error     string `json:"error,omitempty"`
	Backlog   int    `json:"backlog"`    // finished events not checked yet
	Scanned   int    `json:"scanned"`    // events checked since start
	Found     int    `json:"found"`      // of which with a person or animal
	AvgMs     int64  `json:"avg_ms"`     // CPU time per event (average)
	Scanning  string `json:"scanning"`   // event being checked now
	LastFound int64  `json:"last_found"` // unix ms
}

type Labeler struct {
	app  *App
	wake chan struct{}
	hot  *Hotspots

	mu       sync.Mutex
	live     []Event // events that just started, first come first served
	inFlight int     // live events being checked
	status   LabelerStatus
	total    time.Duration
	warned   time.Time
}

func newLabeler(app *App) *Labeler {
	return &Labeler{app: app, wake: make(chan struct{}, 1), hot: loadHotspots(filepath.Join(app.media, "events", "hotspots.json"))}
}

// Start queues an event that has just begun (checked while it happens, so Home
// Assistant hears about a person within seconds).
func (l *Labeler) Start(e Event) {
	l.mu.Lock()
	l.live = append(l.live, e)
	l.mu.Unlock()
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

// Poke: there may be events to check (e.g. after Rescan).
func (l *Labeler) Poke() {
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

func (l *Labeler) Status() LabelerStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.status
	st.Enabled = l.app.detector.Available()
	st.Backlog = len(l.app.events.Unscanned(time.Now().Add(-backfillWindow).UnixMilli(), 100000))
	if st.Scanned > 0 {
		st.AvgMs = l.total.Milliseconds() / int64(st.Scanned)
	}
	return st
}

// backfillWindow: older events without labels are checked when there's nothing new.
const backfillWindow = 8 * 24 * time.Hour

// Run checks events as they happen, several at once (checking one mostly means waiting
// for its footage to reach the disk, so a long event on one camera must not hold up
// another's), and catches up on older events, one at a time, when nothing is happening.
func (l *Labeler) Run(ctx context.Context) {
	var wg sync.WaitGroup
	defer wg.Wait()
	backfilling := false
	for ctx.Err() == nil {
		if !l.app.detector.Available() {
			sleepCtx(ctx, time.Minute)
			continue
		}
		l.mu.Lock()
		if len(l.live) > 0 && l.inFlight < maxLive {
			l.mu.Unlock()
			l.startLive(ctx, &wg)
			continue
		}
		idle := len(l.live) == 0 && l.inFlight == 0 && !backfilling
		l.mu.Unlock()
		if idle {
			// Nothing happening: catch up on older events, newest first.
			if old := l.app.events.Unscanned(time.Now().Add(-backfillWindow).UnixMilli(), 1); len(old) > 0 {
				e := old[0]
				began := time.Now()
				l.app.events.SetScan(e.Cam, e.ID, "scanning", nil, nil, false) // not picked twice
				backfilling = true
				done := make(chan struct{})
				wg.Add(1)
				go func() {
					defer wg.Done()
					defer close(done)
					l.label(ctx, e, false, false)
				}()
				// Wait for it, but start live events that come in meanwhile.
				for waiting := true; waiting; {
					select {
					case <-done:
						waiting = false
					case <-l.wake:
						l.startLive(ctx, &wg)
					case <-ctx.Done():
						waiting = false
					}
				}
				backfilling = false
				// Background work: rest twice as long as it took, so catching up never
				// takes more than a third of the time (live events aren't held back).
				for rest := time.After(2 * time.Since(began)); ; {
					select {
					case <-l.wake:
						l.startLive(ctx, &wg) // live events don't wait for the rest to end
						continue
					case <-rest:
					case <-ctx.Done():
					}
					break
				}
				continue
			}
		}
		select {
		case <-l.wake:
		case <-ctx.Done():
		case <-time.After(time.Minute):
		}
	}
}

// startLive starts checking waiting live events (up to maxLive at once).
func (l *Labeler) startLive(ctx context.Context, wg *sync.WaitGroup) {
	for {
		l.mu.Lock()
		if len(l.live) == 0 || l.inFlight >= maxLive {
			l.mu.Unlock()
			return
		}
		e := l.live[0]
		l.live = l.live[1:]
		l.inFlight++
		busy := l.inFlight+len(l.live) > 3
		l.mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.label(ctx, e, true, busy)
			l.mu.Lock()
			l.inFlight--
			l.mu.Unlock()
			l.Poke()
		}()
	}
}

// maxLive: events checked at the same time while they happen.
const maxLive = 4

// sighting is one detection by the fast model, in one frame. hot: in a spot where
// lookalikes fooled detection before; pre: something was already there before the motion.
type sighting struct {
	t   time.Time
	d   Detection
	hot bool
	pre bool
}

// suspicious: could be a lookalike (unless the thing is seen moving).
func (s sighting) suspicious(moves bool) bool { return !moves && (s.hot || s.pre) }

func (l *Labeler) label(ctx context.Context, e Event, live, busy bool) {
	a := l.app
	began := time.Now()
	l.mu.Lock()
	l.status.Scanning = e.ID
	l.mu.Unlock()
	// Marked while checked, so a Rescan meanwhile leaves it (and its picture) alone.
	a.events.SetScan(e.Cam, e.ID, "scanning", nil, nil, false)
	objs, rejected, snap, checked := l.scan(ctx, e, scanOpts{live: live, busy: busy})
	scan := "done"
	if checked == 0 {
		scan = "none"
	}
	if ctx.Err() != nil {
		scan = "" // shutting down: check it again next time
	}
	a.events.SetScan(e.Cam, e.ID, scan, objs, rejected, snap)
	l.hot.Save()
	l.mu.Lock()
	l.status.Scanning = ""
	if checked > 0 {
		l.status.Scanned++
		l.total += time.Since(began)
		if len(objs) > 0 {
			l.status.Found++
			l.status.LastFound = e.Start
		}
	}
	l.mu.Unlock()
}

// scanOpts: live = the event is happening now (wait for its footage, tell Home Assistant
// at once); busy = events are queuing up (look at fewer frames); dry = only explain
// (nothing saved, nothing learned); trace receives every step when explaining.
type scanOpts struct {
	live, busy, dry bool
	trace           func(format string, args ...any)
}

func (o scanOpts) log(format string, args ...any) {
	if o.trace != nil {
		o.trace(format, args...)
	}
}

// Why a sighting was not counted (kept with the event, for review).
const (
	whyIgnoredArea = "in an ignored area"
	whyDisagree    = "the closer look disagreed"
	whyUnsure      = "not sure enough for a lookalike spot"
)

// scan looks at the event's frames. checked is how many frames could be looked at;
// rejected is what the fast model saw but didn't pass the checks (kept for review).
//
// Nothing the fast model sees is thrown away unchecked: a sighting in a spot where
// lookalikes fooled it before (laundry), or of something that was already there before
// the motion and hasn't moved (a coat, a statue, someone sitting still), only needs the
// big model to be clearly sure on its closer look. Something that moves between frames is
// never a lookalike.
func (l *Labeler) scan(ctx context.Context, e Event, o scanOpts) (objs, rejected []Object, snap bool, checked int) {
	a := l.app
	cam := cameraConfig(a.settings.Get(), e.Cam)
	size, err := a.detector.Size(modelScan)
	if err != nil {
		l.fail(e.Cam, err)
		return nil, nil, false, 0
	}
	start := time.UnixMilli(e.Start)
	ctx = lowPriority(ctx)

	// The scene before the motion: what was already there (for "hasn't moved") and a
	// small greyscale picture (to find where it moved, for a zoomed-in look). Only
	// decoded when needed (most events are leaves, light and shadows).
	var bgDets []Detection
	bgDone := false
	before := func() {
		if bgDone {
			return
		}
		bgDone = true
		for _, back := range []time.Duration{3 * time.Second, 12 * time.Second} {
			if f, err := a.decodeRGB(ctx, e.Cam, start.Add(-back), fullFrame, size); err == nil {
				if ds, err := a.detectIn(ctx, modelScan, f); err == nil {
					bgDets = append(bgDets, ds...)
				}
			}
		}
		o.log("scene before the motion: %s", fmtDets(bgDets))
	}
	var bgGray []byte
	grayDone := false
	mask := maskGrid(cam, shotW, shotH)
	masked := func(b Rect) bool {
		cx, cy := int((b.X+b.W/2)*shotW), int((b.Y+b.H/2)*shotH)
		return mask[min(max(cy, 0), shotH-1)*shotW+min(max(cx, 0), shotW-1)]
	}

	seen := map[string][]sighting{} // candidates per group ("person", "animal")
	tried := map[string][]time.Time{}
	triedBest := map[string]float64{}
	done := map[string]bool{}
	limit := maxFrames
	if o.busy {
		limit = busyFrames
	}
	reject := func(label string, s sighting, why string, hits float64) {
		rejected = append(rejected, Object{Label: label, Score: s.d.Score, Box: s.d.Box, T: s.t.UnixMilli(), Why: why})
		if hits > 0 && !o.dry {
			l.hot.Add(e.Cam, s.d.Box, hits)
		}
	}

	confirm := func(obj Object, t time.Time) {
		o.log("CONFIRMED %s %.2f at %s", obj.Label, obj.Score, t.Format("15:04:05.0"))
		if i := slices.IndexFunc(objs, func(x Object) bool { return x.Label == obj.Label }); i >= 0 {
			if obj.Score > objs[i].Score {
				objs[i] = obj
			}
		} else {
			objs = append(objs, obj)
		}
		sortObjects(objs)
		if o.dry {
			return
		}
		// The picture shows the most important thing seen (a person over an animal).
		if objs[0].T == obj.T && objs[0].Label == obj.Label {
			if l.saveSnap(ctx, e, t) {
				snap = true
			}
		}
		if o.live {
			ev, _ := a.events.SetScan(e.Cam, e.ID, "scanning", objs, nil, snap)
			a.ObjectSeen(ev, obj.Label)
		}
	}

	// People and animals are decided separately. Cats and dogs are one "animal": which
	// of the two it is, is voted on by the big model over up to three frames, so one
	// frame where a cat looks like a dog doesn't decide (and one animal never gets both).
	votes := map[string]float64{} // animal: summed big-model scores per label
	bestAnimal := map[string]Object{}
	animalChecks := 0
	decideAnimal := func(final bool) {
		if done["animal"] || animalChecks == 0 {
			return
		}
		win, lose := "cat", "dog"
		if votes["dog"] > votes["cat"] {
			win, lose = "dog", "cat"
		}
		clear := animalChecks >= 2 && votes[win] >= 1.5*votes[lose] ||
			animalChecks == 1 && votes[lose] == 0 && bestAnimal[win].Score >= 0.75 ||
			final && votes[win] >= votes[lose] // sure it's an animal: the likelier one
		if !clear || bestAnimal[win].Label == "" {
			return
		}
		done["animal"] = true
		confirm(bestAnimal[win], time.UnixMilli(bestAnimal[win].T))
	}

	// decide asks the big model about whatever has enough evidence; it reports whether it
	// asked anything. final: no more frames are coming, so a single clear-ish sighting is
	// enough to ask.
	decide := func(final bool) bool {
		asked := false
		for _, g := range []string{"person", "animal"} {
			ss := seen[g]
			if done[g] || len(ss) == 0 || len(tried[g]) >= maxVerify || ctx.Err() != nil {
				continue
			}
			moves := moved(ss)
			best := bestUntried(ss, tried[g], moves)
			if best == nil {
				continue
			}
			edge := atEdge(best.d.Box)
			switch {
			case len(tried[g]) > 0 && best.d.Score >= triedBest[g]+0.1: // clearly better than what was asked about
			case len(tried[g]) > 0 && len(tried[g]) < 3: // already asked: keep asking about new frames
			case len(ss) >= 2 && !edge:
			case len(ss) >= 2 && edge && best.d.Score >= scanClear:
			case len(ss) == 1 && !edge && best.d.Score >= scanClear:
			case final && len(ss) == 1 && !edge && best.d.Score >= 0.45:
			case final && len(ss) == 1 && edge && best.d.Score >= scanClear:
			default:
				continue // not enough yet
			}
			tried[g] = append(tried[g], best.t)
			triedBest[g] = max(triedBest[g], best.d.Score)
			asked = true
			suspicious := best.suspicious(moves)
			v := l.verifyScores(ctx, cam, best.t, best.d.Box)
			o.log("  big model in %s: %s", fmtBox(verifyRect(best.d.Box, a.frameAspect(cam.ID))), fmtDets(v.raw))
			need := func(label string) float64 { return needScore(label, edge, suspicious) }
			person := v.score["person"]
			animal := max(v.score["cat"], v.score["dog"])
			o.log("closer look at %s %.2f %s (%s%s%s): person %.2f (needs %.2f), cat %.2f, dog %.2f (need %.2f)",
				best.d.Label, best.d.Score, fmtBox(best.d.Box), when(edge, "at the edge ", ""), when(best.hot, "in a lookalike spot ", ""),
				when(best.pre && !moves, "was already there", when(moves, "moving", "")), person, need("person"), v.score["cat"], v.score["dog"], need("cat"))
			switch {
			case person >= need("person") && person >= animal && (g == "person" || person >= 0.7):
				// A person (the big model is surer than the fast one's animal guess).
				if !done["person"] {
					done["person"] = true
					confirm(v.object("person", best.t), best.t)
				}
			case animal >= need("cat") && !done["animal"]:
				animalChecks++
				for _, lb := range []string{"cat", "dog"} {
					votes[lb] += v.score[lb]
					if ob := v.object(lb, best.t); ob.Score > bestAnimal[lb].Score {
						bestAnimal[lb] = ob
					}
				}
				decideAnimal(false)
			case suspicious && max(person, animal) >= verifyMin[best.d.Label]:
				// Probably real, but in a lookalike spot or not moving: not sure enough.
				// Not learned from: the big model half agreed.
				reject(best.d.Label, *best, whyUnsure, 0)
			default:
				reject(best.d.Label, *best, whyDisagree, 1) // the big model disagrees: remember the spot
			}
		}
		return asked
	}

	// look adds what the fast model sees in part r of frame f (r = the whole frame, or a
	// zoomed-in part) as candidates; it reports whether there were any.
	look := func(t time.Time, dets []Detection, zoom *zoomLook) bool {
		found := false
		for _, d := range dets {
			if done[group(d.Label)] || d.Score < scanFound || d.Box.W*d.Box.H < minBoxArea {
				continue
			}
			if zoom != nil && overlapOfSmaller(d.Box, zoom.changed) < 0.25 {
				o.log("  (%s %.2f is not where the picture changed)", d.Label, d.Score)
				continue
			}
			s := sighting{t: t, d: d}
			if masked(d.Box) {
				reject(d.Label, s, whyIgnoredArea, 0)
				continue
			}
			s.hot = l.hot.Suspect(e.Cam, d.Box)
			before()
			wasThere := func(b Detection) bool { return iou(b.Box, d.Box) >= 0.4 }
			s.pre = slices.ContainsFunc(bgDets, wasThere) || zoom != nil && slices.ContainsFunc(zoom.before, wasThere)
			seen[group(d.Label)] = append(seen[group(d.Label)], s)
			found = true
		}
		return found
	}

	empty, zooms := 0, 0
	var off time.Duration
	for i := 0; i < limit && ctx.Err() == nil; i++ {
		switch {
		case empty >= emptyFrames:
			off += longFrameGap
		case i < len(scanOffsets):
			off = scanOffsets[i]
		default:
			off += longFrameGap
		}
		t := start.Add(off)
		end := e.End
		if cur, ok := a.events.Get(e.Cam, e.ID); ok {
			end = cur.End
		}
		if end != 0 && t.UnixMilli() > end+500 {
			if checked >= 2 || e.Start+off.Milliseconds() > end+scanOffsets[1].Milliseconds() && checked >= 1 {
				break
			}
			t = time.UnixMilli(max(end-300, e.Start)) // a short event: its last moment
		}
		if o.live && !l.waitFootage(ctx, e.Cam, t) {
			continue
		}
		f, err := a.decodeRGB(ctx, e.Cam, t, fullFrame, size)
		if err != nil {
			continue
		}
		dets, err := a.detectIn(ctx, modelScan, f)
		if err != nil {
			l.fail(e.Cam, err)
			break
		}
		checked++
		o.log("frame +%.1fs: %s", t.Sub(start).Seconds(), fmtDets(dets))
		found := look(t, dets, nil)
		// Nothing recognised: look again, zoomed in where the picture changed since before
		// the motion (a cat far down a corridor is only a few pixels in the whole frame).
		if !found && zooms < maxZooms && !(done["person"] && done["animal"]) {
			if !grayDone {
				grayDone = true
				bgGray, _ = a.decodeGray(ctx, e.Cam, start.Add(-3*time.Second), shotW, shotH)
			}
			if bgGray != nil {
				if g, err := a.decodeGray(ctx, e.Cam, t, shotW, shotH); err == nil {
					b := biggestChange(g, bgGray, mask, shotW, shotH)
					if r := frameRect(b.box); b.size >= minShotBlob && b.changed < 0.5 && r.W*r.H < 0.6 {
						zooms++
						if zd, err := a.detectAt(ctx, e.Cam, t, r, modelScan); err == nil {
							o.log("  zoomed in on %s (changed %s): %s", fmtBox(r), fmtBox(b.box), fmtDets(zd))
							if len(zd) > 0 {
								// What was there before, seen at the same zoom (a gate in a
								// bright doorway looks like a person only up close).
								zb, _ := a.detectAt(ctx, e.Cam, start.Add(-3*time.Second), r, modelScan)
								o.log("  before, same zoom: %s", fmtDets(zb))
								found = look(t, zd, &zoomLook{changed: b.box, before: zb})
							}
						}
					}
				}
			}
		}
		if found {
			empty = 0
		} else {
			empty++
		}
		if empty >= 2*emptyFrames && checked >= 2*emptyFrames {
			break // a long event with nobody in it (wind, rain, light)
		}
		decide(false)
		if done["person"] && done["animal"] {
			break
		}
	}
	// No more frames: ask about what's left, then settle the animal vote.
	for i := 0; i < 2*maxVerify && decide(true); i++ {
	}
	decideAnimal(true)
	if !done["animal"] && animalChecks > 0 {
		rejected = append(rejected, Object{Label: "animal", Score: max(votes["cat"], votes["dog"]), Why: "cat or dog unclear"})
	}
	return objs, rejected, snap, checked
}

// zoomLook: a zoomed-in look at where the picture changed, and what was there before.
type zoomLook struct {
	changed Rect
	before  []Detection
}

// maxZooms: zoomed-in second looks per event (each costs one more detection).
const maxZooms = 3

// needScore is how sure the big model must be: surer for something cut off by the
// picture's edge, and surer again for a lookalike spot or something that hasn't moved.
func needScore(label string, edge, suspicious bool) float64 {
	n := verifyMin[label]
	if edge {
		n += 0.15
	}
	if suspicious {
		n += 0.2
	}
	return min(n, 0.9)
}

// moved: the sightings (of one group, across frames) show something that moves. Laundry
// sways in place; a person or a cat goes somewhere.
func moved(ss []sighting) bool {
	for i := range ss {
		for j := i + 1; j < len(ss); j++ {
			a, b := ss[i].d.Box, ss[j].d.Box
			dx := (a.X + a.W/2) - (b.X + b.W/2)
			dy := (a.Y + a.H/2) - (b.Y + b.H/2)
			scale := max(min(a.W, b.W), min(a.H, b.H))
			if math.Hypot(dx, dy) > 0.6*scale && iou(a, b) < 0.4 {
				return true
			}
		}
	}
	return false
}

func when(c bool, a, b string) string {
	if c {
		return a
	}
	return b
}

func fmtBox(b Rect) string {
	return fmt.Sprintf("@%.2f,%.2f %.2fx%.2f", b.X, b.Y, b.W, b.H)
}

func fmtDets(ds []Detection) string {
	if len(ds) == 0 {
		return "nothing"
	}
	parts := []string{}
	for _, d := range ds {
		parts = append(parts, fmt.Sprintf("%s %.2f %s", d.Label, d.Score, fmtBox(d.Box)))
	}
	return strings.Join(parts, "; ")
}

// atEdge: the box touches the picture's border (only part of it is visible, which is
// where lookalikes fool detection most).
func atEdge(b Rect) bool {
	return b.X < 0.01 || b.Y < 0.01 || b.X+b.W > 0.99 || b.Y+b.H > 0.99
}

// bestUntried is the clearest sighting not asked about yet, preferring ones that can't be
// a lookalike.
func bestUntried(ss []sighting, tried []time.Time, moves bool) *sighting {
	var best *sighting
	for i := range ss {
		if slices.ContainsFunc(tried, ss[i].t.Equal) {
			continue
		}
		if best == nil {
			best = &ss[i]
			continue
		}
		si, sb := ss[i].suspicious(moves), best.suspicious(moves)
		if si != sb {
			if !si {
				best = &ss[i]
			}
			continue
		}
		if ss[i].d.Score > best.d.Score {
			best = &ss[i]
		}
	}
	return best
}

// verdict is what the big model sees at a spot: its best score for each label there.
type verdict struct {
	score map[string]float64
	box   map[string]Rect
	raw   []Detection // everything it saw in the crop
}

func (v verdict) object(label string, t time.Time) Object {
	return Object{Label: label, Score: v.score[label], Box: v.box[label], T: t.UnixMilli()}
}

// verifyScores asks the big model about the spot box at t, zoomed in from the
// full-quality recording.
func (l *Labeler) verifyScores(ctx context.Context, cam Camera, t time.Time, box Rect) verdict {
	a := l.app
	v := verdict{score: map[string]float64{}, box: map[string]Rect{}}
	dets, err := a.detectAt(ctx, cam.ID, t, verifyRect(box, a.frameAspect(cam.ID)), modelVerify)
	if err != nil {
		return v
	}
	v.raw = dets
	for _, d := range dets {
		if !sameThing(d.Box, box) {
			continue // something else in the crop
		}
		if d.Score > v.score[d.Label] {
			v.score[d.Label], v.box[d.Label] = d.Score, d.Box
		}
	}
	return v
}

// verify (for night alerts) says what the big model sees at the spot, if it's sure
// enough (surer for something cut off by the picture's edge or in a lookalike spot, and
// clearly one animal rather than the other).
func (l *Labeler) verify(ctx context.Context, cam Camera, t time.Time, box Rect, edge, suspicious bool) (Object, bool) {
	v := l.verifyScores(ctx, cam, t, box)
	best := ""
	for _, label := range watchLabels {
		if best == "" || v.score[label] > v.score[best] {
			best = label
		}
	}
	if v.score[best] < needScore(best, edge, suspicious) {
		return Object{}, false
	}
	if best != "person" && v.score["cat"] > 0 && v.score["dog"] > 0 && max(v.score["cat"], v.score["dog"]) < 1.5*min(v.score["cat"], v.score["dog"]) {
		return Object{}, false // cat or dog? unclear
	}
	return v.object(best, t), true
}

// group: people are decided on their own; cats and dogs together.
func group(label string) string {
	if label == "person" {
		return "person"
	}
	return "animal"
}

// verifyRect is a square (in pixels) around the box, about twice its size, so the big
// model sees the thing large and with some surroundings.
func verifyRect(b Rect, aspect float64) Rect {
	if aspect <= 0 {
		aspect = 16.0 / 9
	}
	cx, cy := b.X+b.W/2, b.Y+b.H/2
	side := min(max(max(b.W*aspect, b.H)*2, 0.35), 1) // in frame heights
	w, h := min(side/aspect, 1), side
	x := min(max(cx-w/2, 0), 1-w)
	y := min(max(cy-h/2, 0), 1-h)
	return Rect{X: x, Y: y, W: w, H: h}
}

// sameThing: the two models' boxes are about the same thing (they rarely frame it the
// same way: the fast model often cuts off legs or includes a shadow).
func sameThing(a, b Rect) bool {
	if iou(a, b) >= 0.3 || overlapOfSmaller(a, b) >= 0.6 {
		return true
	}
	cx, cy := a.X+a.W/2, a.Y+a.H/2
	inside := cx >= b.X && cx <= b.X+b.W && cy >= b.Y && cy <= b.Y+b.H
	ratio := (a.W * a.H) / max(b.W*b.H, 1e-6)
	return inside && ratio >= 0.25 && ratio <= 4 && overlapOfSmaller(a, b) >= 0.35
}

func overlapOfSmaller(a, b Rect) float64 {
	x0, y0 := max(a.X, b.X), max(a.Y, b.Y)
	x1, y1 := min(a.X+a.W, b.X+b.W), min(a.Y+a.H, b.Y+b.H)
	if x1 <= x0 || y1 <= y0 {
		return 0
	}
	return (x1 - x0) * (y1 - y0) / min(a.W*a.H, b.W*b.H)
}

// waitFootage waits (up to 25 s) until the recording reaches t: the newest footage gets
// to the disk a few seconds late.
func (l *Labeler) waitFootage(ctx context.Context, cam string, t time.Time) bool {
	for deadline := time.Now().Add(25 * time.Second); ; {
		if _, _, err := l.app.fragmentAt(cam, t, true); err == nil {
			return true
		}
		if time.Now().After(deadline) || !sleepCtx(ctx, 700*time.Millisecond) {
			return false
		}
	}
}

// saveSnap keeps a picture of the moment (for the event list and Home Assistant).
func (l *Labeler) saveSnap(ctx context.Context, e Event, t time.Time) bool {
	a := l.app
	img, err := a.decodeFrame(ctx, e.Cam, t, "scale='min(1280,iw)':-2", 4, true)
	if err != nil {
		return false
	}
	p := a.events.SnapPath(e.Cam, e.ID)
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	return writeFileAtomic(p, img, 0o644) == nil
}

func (l *Labeler) fail(cam string, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.status.Error = err.Error()
	if time.Since(l.warned) > time.Hour {
		l.warned = time.Now()
		l.app.incidents.Add("warn", cam, "Object detection failed, events are shown as plain motion for now: %v", err)
	}
}

// sortObjects puts people first, then the surest.
func sortObjects(objs []Object) {
	sort.SliceStable(objs, func(i, j int) bool {
		pi, pj := objs[i].Label == "person", objs[j].Label == "person"
		if pi != pj {
			return pi
		}
		return objs[i].Score > objs[j].Score
	})
}

// frameAspect is the camera's picture shape (width / height).
func (a *App) frameAspect(cam string) float64 {
	a.mu.Lock()
	r := a.recorders[cam]
	a.mu.Unlock()
	if r != nil {
		if s := r.Status().Stream; s.Width > 0 && s.Height > 0 {
			return float64(s.Width) / float64(s.Height)
		}
	}
	return 16.0 / 9
}
