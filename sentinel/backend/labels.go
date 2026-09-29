package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"
)

// The labeler says who was in each motion event: a person, a cat, a dog, or nobody
// (plain motion). It never watches video: when something moves it looks at a handful of
// frames of the recording, so it costs a few seconds of CPU per event, at low priority.
//
// Being wrong is worse than saying nothing, so a label needs two independent yeses:
//  1. the fast model sees it, in two frames (or very clearly in one), big enough to
//     judge, outside the camera's ignored areas, not where something person-like already
//     was before the motion (laundry, a coat, a statue), and not in a spot where
//     lookalikes keep fooling it (see hotspots.go);
//  2. the big model, looking again at a zoomed-in crop of that spot in full quality,
//     agrees on what it is (surer for things cut off by the picture's edge). If it sees
//     a different animal, its answer wins; if it sees nothing, there's no label.
// Events it can't check (no footage) say so instead of guessing.

var watchLabels = []string{"person", "cat", "dog"}

const (
	scanFound  = 0.35 // fast model: worth a closer look
	scanClear  = 0.60 // fast model: clear enough in a single frame
	minBoxArea = 0.0004
	maxVerify  = 3 // second opinions per label per event
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

	mu     sync.Mutex
	live   []Event // events that just started, first come first served
	status LabelerStatus
	total  time.Duration
	warned time.Time
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

func (l *Labeler) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if !l.app.detector.Available() {
			sleepCtx(ctx, time.Minute)
			continue
		}
		l.mu.Lock()
		var e Event
		live := len(l.live) > 0
		if live {
			e = l.live[0]
			l.live = l.live[1:]
		}
		busy := len(l.live) > 2
		l.mu.Unlock()
		if !live {
			// Nothing happening: catch up on older events, newest first.
			old := l.app.events.Unscanned(time.Now().Add(-backfillWindow).UnixMilli(), 1)
			if len(old) == 0 {
				select {
				case <-l.wake:
				case <-ctx.Done():
				case <-time.After(time.Minute):
				}
				continue
			}
			e = old[0]
		}
		l.label(ctx, e, live, busy)
		if !live {
			sleepCtx(ctx, 200*time.Millisecond) // background work: leave room
		}
	}
}

// sighting is one detection by the fast model, in one frame.
type sighting struct {
	t time.Time
	d Detection
}

func (l *Labeler) label(ctx context.Context, e Event, live, busy bool) {
	a := l.app
	began := time.Now()
	l.mu.Lock()
	l.status.Scanning = e.ID
	l.mu.Unlock()
	// Marked while checked, so a Rescan meanwhile leaves it (and its picture) alone.
	a.events.SetScan(e.Cam, e.ID, "scanning", nil, nil, false)
	objs, rejected, snap, checked := l.scan(ctx, e, live, busy)
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

// scan looks at the event's frames. checked is how many frames could be looked at;
// rejected is what the fast model saw but didn't pass the checks (kept for review).
func (l *Labeler) scan(ctx context.Context, e Event, live, busy bool) (objs, rejected []Object, snap bool, checked int) {
	a := l.app
	cam := cameraConfig(a.settings.Get(), e.Cam)
	size, err := a.detector.Size(modelScan)
	if err != nil {
		l.fail(e.Cam, err)
		return nil, nil, false, 0
	}
	start := time.UnixMilli(e.Start)
	ctx = lowPriority(ctx)

	// The scene before the motion, at two moments: whatever person-like thing was already
	// there (laundry, a coat, a statue, a sleeping cat) doesn't count. Only decoded once
	// something is found (most events are leaves, light and shadows).
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
	}
	mask := maskGrid(cam, shotW, shotH)
	seen := map[string][]sighting{} // sightings that passed the checks
	tried := map[string][]time.Time{}
	done := map[string]bool{}
	limit := maxFrames
	if busy {
		limit = busyFrames
	}
	reject := func(label string, s sighting, hits float64) {
		rejected = append(rejected, Object{Label: label, Score: s.d.Score, Box: s.d.Box, T: s.t.UnixMilli()})
		if hits > 0 {
			l.hot.Add(e.Cam, s.d.Box, hits)
		}
	}

	confirm := func(o Object, t time.Time) {
		if i := slices.IndexFunc(objs, func(x Object) bool { return x.Label == o.Label }); i >= 0 {
			if o.Score > objs[i].Score {
				objs[i] = o
			}
		} else {
			objs = append(objs, o)
		}
		sortObjects(objs)
		// The picture shows the most important thing seen (a person over an animal).
		if objs[0].T == o.T && objs[0].Label == o.Label {
			if l.saveSnap(ctx, e, t) {
				snap = true
			}
		}
		if live {
			ev, _ := a.events.SetScan(e.Cam, e.ID, "scanning", objs, nil, snap)
			a.ObjectSeen(ev, o.Label)
		}
	}

	// decide asks the big model about labels with enough evidence. final: no more frames
	// are coming, so a single clear-ish sighting is enough to ask.
	decide := func(final bool) {
		for _, label := range watchLabels {
			ss := seen[label]
			if done[label] || len(ss) == 0 || len(tried[label]) >= maxVerify || ctx.Err() != nil {
				continue
			}
			best := bestUntried(ss, tried[label])
			if best == nil {
				continue
			}
			edge := atEdge(best.d.Box)
			switch {
			case len(ss) >= 2 && !edge:
			case len(ss) >= 2 && edge && best.d.Score >= scanClear:
			case len(ss) == 1 && !edge && best.d.Score >= scanClear:
			case final && len(ss) == 1 && !edge && best.d.Score >= 0.45:
			default:
				continue // not enough yet
			}
			tried[label] = append(tried[label], best.t)
			v, ok := l.verify(ctx, cam, best.t, best.d.Box, edge)
			if !ok {
				reject(label, *best, 1) // the big model disagrees: remember the spot
				continue
			}
			if done[v.Label] {
				continue
			}
			done[v.Label] = true // the big model's answer wins (it may be another animal)
			confirm(v, best.t)
		}
	}

	empty := 0
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
		if live && !l.waitFootage(ctx, e.Cam, t) {
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
		found := false
		for _, d := range dets {
			if done[d.Label] || d.Score < scanFound || d.Box.W*d.Box.H < minBoxArea {
				continue
			}
			found = true
			cx, cy := int((d.Box.X+d.Box.W/2)*shotW), int((d.Box.Y+d.Box.H/2)*shotH)
			if mask[min(max(cy, 0), shotH-1)*shotW+min(max(cx, 0), shotW-1)] {
				continue // in an area the camera ignores
			}
			s := sighting{t, d}
			if l.hot.Suspect(e.Cam, d.Box) {
				reject(d.Label, s, 0) // a known lookalike spot
				continue
			}
			before()
			if slices.ContainsFunc(bgDets, func(b Detection) bool { return iou(b.Box, d.Box) >= 0.4 }) {
				reject(d.Label, s, 0.5) // already there before the motion
				continue
			}
			seen[d.Label] = append(seen[d.Label], s)
		}
		if found {
			empty = 0
		} else {
			empty++
		}
		decide(false)
		if len(done) == len(watchLabels) {
			break
		}
	}
	decide(true)
	return objs, rejected, snap, checked
}

// atEdge: the box touches the picture's border (only part of it is visible, which is
// where lookalikes fool detection most).
func atEdge(b Rect) bool {
	return b.X < 0.01 || b.Y < 0.01 || b.X+b.W > 0.99 || b.Y+b.H > 0.99
}

func bestUntried(ss []sighting, tried []time.Time) *sighting {
	var best *sighting
	for i := range ss {
		if slices.ContainsFunc(tried, ss[i].t.Equal) {
			continue
		}
		if best == nil || ss[i].d.Score > best.d.Score {
			best = &ss[i]
		}
	}
	return best
}

// verify asks the big model about the spot box at t, zoomed in from the full-quality
// recording. It answers with what it sees there, if it's sure enough (surer for
// something cut off by the picture's edge).
func (l *Labeler) verify(ctx context.Context, cam Camera, t time.Time, box Rect, edge bool) (Object, bool) {
	a := l.app
	dets, err := a.detectAt(ctx, cam.ID, t, verifyRect(box, a.frameAspect(cam.ID)), modelVerify)
	if err != nil {
		return Object{}, false
	}
	var best *Detection
	for i := range dets {
		d := &dets[i]
		if iou(d.Box, box) < 0.3 && overlapOfSmaller(d.Box, box) < 0.6 {
			continue // something else in the crop
		}
		if best == nil || d.Score > best.Score {
			best = d
		}
	}
	need := 0.0
	if best != nil {
		need = verifyMin[best.Label]
		if edge {
			need += 0.15
		}
	}
	if best == nil || best.Score < need {
		return Object{}, false
	}
	return Object{Label: best.Label, Score: best.Score, Box: best.Box, T: t.UnixMilli()}, true
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
