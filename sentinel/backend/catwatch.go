package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Cat watch: a cat left outside the door. When something moves on a watched camera,
// Sentinel looks at the newest frame every second or so for a cat, and keeps looking
// after the motion stops (a cat sitting at the door hardly moves). Once a cat has been
// seen for MinSeconds, every RepeatSeconds until it has gone: the Echo says so (at
// AlexaVolume, put back afterwards) and a WhatsApp picture is sent. When it's gone for
// catGoneAfter, one last message says so.

const (
	catCheckEvery = 1500 * time.Millisecond
	// A cat counts as staying across misses shorter than this (it turns, a person
	// passes in front of it, the detector misses a frame).
	catGap = 6 * time.Second
	// Sightings this close together are one visit (they add up to MinSeconds): near
	// people, or walking in the shade, a cat can go unrecognised for a few looks (18:30
	// on the 3rd floor replay: seen at :44-:46 and :58-:02, there all along).
	catJoin = 15 * time.Second
	// Gone: no cat for this long, no motion now, and new motion since it was last seen
	// (leaving makes motion; a cat sitting still that the detector misses for a while
	// doesn't). Without new motion, gone only after catLostAfter.
	catGoneAfter = 30 * time.Second
	// Following its blob keeps a cat sitting still in view, so a cat not seen at all
	// for this long has gone even without new motion (on the replay, a visit that
	// should have ended at 18:31 lasted until the cat came back at 18:34).
	catLostAfter = 90 * time.Second
	// Motion with no cat in it stops being watched after this long without motion.
	catIdleAfter = 15 * time.Second
	catLogLimit  = 100
)

// CatVisit is one cat sighting on a watched camera, for the Settings page.
type CatVisit struct {
	ID         string `json:"id"`
	Camera     string `json:"camera"`
	CameraName string `json:"camera_name"`
	From       int64  `json:"from"`             // first seen (unix ms)
	To         int64  `json:"to"`               // last seen
	Alerted    int64  `json:"alerted"`          // when alerts started (0 = left before MinSeconds)
	Alexa      int    `json:"alexa"`            // announcements made
	Pictures   int    `json:"pictures"`         // WhatsApp pictures sent
	Ongoing    bool   `json:"ongoing"`          // still there
	Test       bool   `json:"test,omitempty"`   // from the Test button
	Replay     bool   `json:"replay,omitempty"` // a replay of recorded footage
	Error      string `json:"error,omitempty"`
}

type CatWatcher struct {
	app     *App
	path    string
	mu      sync.Mutex
	active  map[string]bool      // camera -> being watched now
	moved   map[string]time.Time // camera -> when motion last started
	stirred map[string]int       // camera -> frames in a row with a little change
	// camera -> its motion threshold (set when its motion detection starts)
	thresholds sync.Map
	log        []CatVisit // newest last
	fileMu     sync.Mutex
	// The Echo's volume before cat watch raised it, while raised (restored after a
	// restart too: it's saved with the log).
	alexaMu    sync.Mutex
	alexaSaved map[string]float64
	alexaUp    map[string]bool // Echos raised to the cat watch volume (set once a visit)
	// The replay running now, if any.
	replayStop context.CancelFunc
	replayInfo map[string]any
}

type catWatchFile struct {
	Visits     []CatVisit         `json:"visits"`
	AlexaSaved map[string]float64 `json:"alexa_saved,omitempty"`
}

func newCatWatcher(app *App, path string) *CatWatcher {
	cw := &CatWatcher{app: app, path: path, active: map[string]bool{}, moved: map[string]time.Time{}, stirred: map[string]int{}, alexaSaved: map[string]float64{}, alexaUp: map[string]bool{}}
	var f catWatchFile
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &f) == nil {
		cw.log = f.Visits
		for k, v := range f.AlexaSaved {
			cw.alexaSaved[k] = v
		}
	}
	for i := range cw.log {
		cw.log[i].Ongoing = false
	}
	if len(cw.alexaSaved) > 0 {
		// Restarted while a cat was there: put the Echo's volume back.
		go func() {
			if sleepCtx(app.ctx, 20*time.Second) {
				cw.alexaRestore()
			}
		}()
	}
	return cw
}

// watching reports whether cat watch covers cam right now.
func (cw *CatWatcher) watching(s Settings, cam string) bool {
	c := s.CatWatch
	if !c.Enabled || !contains(c.Cameras, cam) {
		return false
	}
	if c.Hours != "" {
		from, to, _ := strings.Cut(c.Hours, "-")
		return inWindow(from, to, time.Now())
	}
	return true
}

// Motion: something moved on cam; start looking for a cat if cat watch covers it.
func (cw *CatWatcher) Motion(cam string) {
	cw.mu.Lock()
	cw.moved[cam] = time.Now()
	cw.mu.Unlock()
	cw.start(cam)
}

// start starts looking for a cat on cam, if cat watch covers it and isn't already.
func (cw *CatWatcher) start(cam string) {
	if !cw.watching(cw.app.settings.Get(), cam) {
		return
	}
	cw.mu.Lock()
	defer cw.mu.Unlock()
	if cw.active[cam] {
		return
	}
	cw.active[cam] = true
	go cw.watch(cw.app.ctx, cam, catFeed{})
}

func (cw *CatWatcher) Status() map[string]any {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	act := []string{}
	for c, on := range cw.active {
		if on {
			act = append(act, c)
		}
	}
	visits := make([]CatVisit, 0, 20)
	for i := len(cw.log) - 1; i >= 0 && len(visits) < 20; i-- {
		visits = append(visits, cw.log[i])
	}
	return map[string]any{"checking": act, "visits": visits, "replay": cw.replayInfo}
}

// catFeed is where a watch's frames and motion come from: the camera now, or (a replay)
// a recording played back in real time as if it were happening now. Alerts are real
// either way.
type catFeed struct {
	replay bool
	offset time.Duration // replay: footage time = now - offset
	until  time.Time     // replay: where the footage ends
	tag    string        // replay: keeps visit ids (and WhatsApp keys) apart
	dry    bool          // replay: no Alexa or WhatsApp, only the log (for checking)
}

// frame is the footage time to look at next: the newest recorded frame, or the replay's
// position. done: the replay is over.
func (cw *CatWatcher) frame(cam string, f catFeed) (t time.Time, ok, done bool) {
	if f.replay {
		t = cw.app.clock.Now().Add(-f.offset)
		if t.After(f.until) {
			return t, false, true
		}
		_, err := cw.app.fragmentRefAt(cam, t, true)
		return t, err == nil, false
	}
	t, ok = cw.newestFrame(cam)
	return t, ok, false
}

// motionOn: is there motion at footage time t?
func (cw *CatWatcher) motionOn(cam string, f catFeed, t time.Time) bool {
	if f.replay {
		for _, e := range cw.app.events.List([]string{cam}, t.UnixMilli(), t.UnixMilli(), 5) {
			if e.End == 0 || e.End+motionHold.Milliseconds() >= t.UnixMilli() {
				return true
			}
		}
		return false
	}
	cw.app.mu.Lock()
	m := cw.app.motion[cam]
	cw.app.mu.Unlock()
	return m != nil && m.Status().Active
}

// movedSince: did new motion start after the cat was last seen (at footage time last,
// wall clock seenAt) and by footage time t?
func (cw *CatWatcher) movedSince(cam string, f catFeed, last, seenAt, t time.Time) bool {
	if f.replay {
		for _, e := range cw.app.events.List([]string{cam}, last.UnixMilli(), t.UnixMilli(), 50) {
			if e.Start > last.UnixMilli() && e.Start <= t.UnixMilli() {
				return true
			}
		}
		return false
	}
	cw.mu.Lock()
	defer cw.mu.Unlock()
	return cw.moved[cam].After(seenAt)
}

// newestFrame is the time of the newest recorded frame (footage reaches the disk a
// couple of seconds late).
func (cw *CatWatcher) newestFrame(cam string) (time.Time, bool) {
	now := cw.app.clock.Now()
	for back := 1500 * time.Millisecond; back <= 12*time.Second; back += 1500 * time.Millisecond {
		t := now.Add(-back)
		if _, err := cw.app.fragmentRefAt(cam, t, true); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// watch looks for a cat on cam until there is none (live), or until the footage ends
// (replay: one cat leaving doesn't end it, another may come).
func (cw *CatWatcher) watch(ctx context.Context, cam string, f catFeed) {
	key := cam
	if f.replay {
		key = "replay:" + cam
	}
	detectorHeld.Add(1) // the detector is cat watch's first
	defer detectorHeld.Add(-1)
	defer func() {
		if p := recover(); p != nil {
			cw.app.incidents.Add("error", cam, "cat watch crashed: %v", p)
		}
		cw.mu.Lock()
		cw.active[key] = false
		cw.mu.Unlock()
	}()
	started, lastMotion := time.Now(), time.Now()
	var (
		first, last, prev time.Time // frame times
		seenAt            time.Time // when the cat was last seen (wall clock)
		hint              Rect      // where the cat was last seen
		detected          time.Time // when the detector last saw it (wall clock)
		tpl               []float32 // what its spot looked like then
		bgGray            []byte    // the empty scene from before it came (grey)
		oldBlobs          []catSpot // blobs that aren't the cat moving (see catBlob)
		sizes             []float64 // the cat's size (part of the picture) when detected
		personAt          time.Time // when a person was last in view (wall clock)
		weakCats          []weakCat // weak cat sightings lately (see above)
		missFrom          time.Time // the first look since the cat was last seen that saw nothing
		lookBack          = []time.Duration{8 * time.Second, 4 * time.Second}
		visit             *CatVisit
		lastAlexa, lastWA time.Time
		alerting          time.Time
		waBusy            = make(chan struct{}, 1)
		alexaBusy         = make(chan struct{}, 1)
		errs              int
	)
	note := ""
	if f.replay {
		note = "\n_Replay test of recorded footage._"
	}
	// reset forgets the cat (a replay carries on watching for the next one).
	reset := func() {
		first, last, seenAt, hint, visit, alerting, bgGray, oldBlobs, sizes, missFrom = time.Time{}, time.Time{}, time.Time{}, Rect{}, nil, time.Time{}, nil, nil, nil, time.Time{}
		started = time.Now()
	}
	end := func(reason string) {
		if visit == nil {
			return
		}
		cw.update(visit.ID, func(v *CatVisit) { v.Ongoing = false; v.To = last.UnixMilli() })
		if visit.Alerted == 0 {
			return
		}
		s := cw.app.settings.Get()
		if s.CatWatch.Alexa && !f.dry {
			alexaBusy <- struct{}{} // wait for an announcement still being made
			cw.alexaRestore()
			<-alexaBusy
		}
		if to := cw.chat(s); s.CatWatch.WhatsApp && !f.dry && to != "" && !strings.HasSuffix(to, "@g.us") {
			waBusy <- struct{}{}
			<-waBusy
			name := cameraName(s, cam)
			msg := fmt.Sprintf("✅ *The cat has gone · %s*\nSeen from %s to %s (%s).%s%s", name, catClock(first), catClock(last), fmtStay(last.Sub(first)), reason, note)
			// The bridge sometimes times out on a send: try again (a new key, or it refuses).
			var err error
			for try := 1; try <= 3; try++ {
				if err = cw.app.alerts.wa.Send(to, msg, fmt.Sprintf("sentinel:cat:%s:end:%d", visit.ID, try)); err == nil || !sleepCtx(cw.app.ctx, 5*time.Second) {
					break
				}
			}
			if err != nil {
				cw.app.incidents.Add("warn", cam, "Cat watch: the 'cat has gone' message failed: %v", err)
			}
		}
		cw.app.incidents.Add("info", cam, "Cat watch: the cat has gone after %s", fmtStay(last.Sub(first)))
	}
	for {
		s := cw.app.settings.Get()
		if !f.replay && !cw.watching(s, cam) {
			end("\n_Cat watch was switched off._")
			return
		}
		t, ok, done := cw.frame(cam, f)
		// The first looks go a little back: watching starts once something moved enough,
		// which for a small cat can be after it has been there for a while.
		if !f.replay && ok && len(lookBack) > 0 {
			if tb := t.Add(-lookBack[0]); tb.After(prev) {
				if _, err := cw.app.fragmentRefAt(cam, tb, true); err == nil {
					t = tb
				}
			}
			lookBack = lookBack[1:]
		}
		if done {
			end("\n_The replay has ended._")
			return
		}
		if cw.motionOn(cam, f, t) {
			lastMotion = time.Now()
		}
		if !ok || !t.After(prev.Add(500*time.Millisecond)) {
			if !f.replay && !ok && time.Since(lastMotion) > catGoneAfter && (last.IsZero() || time.Since(started) > 2*time.Minute) {
				end("\n_The camera stopped recording._")
				return
			}
			if !sleepCtx(ctx, 700*time.Millisecond) {
				end("")
				return
			}
			continue
		}
		prev = t
		tick := time.Now()
		look, weak, err := cw.app.catLook(ctx, cameraConfig(s, cam), t, hint)
		if look.person {
			personAt = time.Now()
		}
		// Two weak cat sightings in about the same place close together count too: a cat
		// walking in the shade can score just under catMin on every look (18:30 on the
		// replay: dog 0.32, then cat 0.30 ten seconds later, there all along).
		if !look.found && (visit == nil || last.IsZero()) {
			for _, d := range weak {
				if d.Label != "cat" && d.Label != "dog" || d.Score < catWeakMin {
					continue
				}
				if slices.ContainsFunc(weakCats, func(w weakCat) bool {
					return t.Sub(w.t) <= catJoin && math.Hypot(w.box.X+w.box.W/2-d.Box.X-d.Box.W/2, w.box.Y+w.box.H/2-d.Box.Y-d.Box.H/2) <= 0.3
				}) {
					look = catSighting{found: true, box: d.Box, score: d.Score}
					break
				}
			}
			weakCats = slices.DeleteFunc(weakCats, func(w weakCat) bool { return t.Sub(w.t) > catJoin })
			for _, d := range weak {
				if (d.Label == "cat" || d.Label == "dog") && d.Score >= catWeakMin {
					weakCats = append(weakCats, weakCat{t, d.Box})
				}
			}
		}
		if err != nil {
			if errs++; errs == 5 {
				cw.app.incidents.Add("warn", cam, "Cat watch can't check frames: %v", err)
			}
		} else {
			errs = 0
		}
		// A cat already seen, only weakly seen now, or not seen but its spot still looks
		// like it: still there.
		// While a cat is being followed: the picture's blobs (patches unlike the empty
		// scene from before it came), for following it where the detector can't see it.
		var g []byte
		var cur []catSpot
		if visit != nil && !last.IsZero() {
			if bgGray == nil {
				bgGray = cw.app.emptyScene(ctx, cam, first)
			}
			if bgGray != nil {
				g = cw.app.grayNear(ctx, cam, t)
				cur = spots(g, bgGray)
			}
		}
		if !look.found && visit != nil && !last.IsZero() {
			// A walking cat gets further the longer it's unseen (about a tenth of the
			// picture a second from the 3rd floor camera).
			reach := min(0.2+0.08*t.Sub(last).Seconds(), 1.5)
			for _, d := range catNearby(weak, hint, catArea(sizes, hint), reach) {
				if g != nil && catNotEmpty(g, bgGray, d.Box) {
					look = catSighting{found: true, box: d.Box, score: d.Score}
					break
				}
			}
			if !look.found && time.Since(detected) < catLostAfter && g != nil && catStill(g, bgGray, hint, tpl) {
				look = catSighting{found: true, box: hint, still: true}
			}
			if !look.found && time.Since(detected) < catBlobTrust && g != nil {
				if b, ok := catBlob(cur, oldBlobs, hint, catArea(sizes, hint), reach, cw.app.frameAspect(cam)); ok {
					look = catSighting{found: true, box: b, still: true}
				}
			}
			if debugCat.Load() {
				bs := []string{}
				for _, b := range cur {
					bs = append(bs, fmt.Sprintf("%s %dpx", fmtBox(b.box), b.n))
				}
				logf("cat watch: reach %.2f from %s, %d weak nearby; blobs: %s", reach, fmtBox(hint), len(catNearby(weak, hint, catArea(sizes, hint), reach)), strings.Join(bs, "; "))
			}
		}
		if look.found && cur != nil {
			oldBlobs = slices.Clone(cur) // what's there with the cat
		} else if time.Since(personAt) <= 15*time.Second {
			oldBlobs = append(oldBlobs, cur...) // someone around: whatever appears is theirs
		}
		if f.replay {
			how := "nothing"
			switch {
			case look.still:
				how = "still there (unseen by the detector) " + fmtBox(look.box)
			case look.found:
				how = fmt.Sprintf("cat %.2f %s", look.score, fmtBox(look.box))
			}
			logf("cat watch replay %s: %s; weak: %s", t.In(time.Local).Format("15:04:05.0"), how, fmtDets(weak))
		}
		// Only the detector starts a visit (or a new one after a gap): following a blob
		// keeps a cat already seen, it never finds one.
		// How long the cat has been looked for and not seen: only looks that saw nothing
		// count, not a stall between two looks (a look can take 20 s while the disk is
		// busy; that split one visit into short ones that never alerted).
		if !look.found && missFrom.IsZero() && !last.IsZero() {
			missFrom = t
		}
		apart := time.Duration(0)
		if !missFrom.IsZero() {
			apart = t.Sub(missFrom)
		}
		if look.still && (visit == nil || last.IsZero() || apart > catJoin && visit.Alerted == 0) {
			look = catSighting{}
		}
		if look.found {
			if !look.still {
				detected = time.Now()
				tpl = cw.app.catTemplate(ctx, cam, t, look.box)
			}
			if last.IsZero() || apart > catJoin {
				if visit != nil && visit.Alerted == 0 {
					cw.update(visit.ID, func(v *CatVisit) { v.Ongoing = false })
					visit = nil
				}
				if visit == nil {
					first, bgGray, oldBlobs, sizes = t, nil, nil, nil
				}
			}
			last, hint, seenAt, missFrom = t, look.box, time.Now(), time.Time{}
			if !look.still {
				sizes = append(sizes, look.box.W*look.box.H)
			}
			if visit == nil {
				v := CatVisit{ID: fmt.Sprintf("%s%s-%d", f.tag, cam, first.UnixMilli()), Camera: cam, CameraName: cameraName(s, cam), From: first.UnixMilli(), To: t.UnixMilli(), Ongoing: true, Replay: f.replay}
				cw.put(v)
				visit = &v
			} else {
				cw.update(visit.ID, func(v *CatVisit) { v.To = t.UnixMilli() })
			}
		}

		// Gone, or nothing here?
		quiet := time.Since(lastMotion)
		left := !last.IsZero() && (cw.movedSince(cam, f, last, seenAt, t) || t.Sub(last) > catLostAfter)
		over := false
		switch {
		case last.IsZero():
			over = !f.replay && quiet > catIdleAfter && time.Since(started) > catIdleAfter // motion without a cat
		case apart > catJoin && visit != nil && visit.Alerted == 0 && quiet > catIdleAfter && left:
			cw.update(visit.ID, func(v *CatVisit) { v.Ongoing = false })
			over = true // passed by, didn't stay
		case t.Sub(last) > catGoneAfter && quiet > catIdleAfter && left:
			end("")
			over = true
		}
		if over {
			if !f.replay {
				return
			}
			reset()
		}

		// Staying: alert.
		c := s.CatWatch
		if visit != nil && alerting.IsZero() && last.Sub(first) >= time.Duration(c.MinSeconds)*time.Second {
			alerting = time.Now()
			cw.update(visit.ID, func(v *CatVisit) { v.Alerted = time.Now().UnixMilli() })
			visit.Alerted = time.Now().UnixMilli()
			replayed := ""
			if f.replay {
				replayed = " (replay)"
			}
			cw.app.incidents.Add("info", cam, "Cat watch: a cat has been on %s for %s%s", cameraName(s, cam), fmtStay(last.Sub(first)), replayed)
		}
		if !alerting.IsZero() && t.Sub(last) <= catGap {
			repeat := time.Duration(c.RepeatSeconds) * time.Second
			if c.Alexa && !f.dry && time.Since(lastAlexa) >= time.Duration(c.AlexaRepeatSeconds)*time.Second-time.Second {
				select {
				case alexaBusy <- struct{}{}:
					lastAlexa = time.Now()
					id := visit.ID
					go func() {
						defer func() { <-alexaBusy }()
						if err := cw.alexaSay(c); err != nil {
							cw.update(id, func(v *CatVisit) { v.Error = "Alexa: " + err.Error() })
							return
						}
						cw.update(id, func(v *CatVisit) { v.Alexa++ })
					}()
				default: // the last announcement is still being made
				}
			}
			waRepeat := repeat
			if c.SlowAfterMinutes > 0 && time.Since(alerting) > time.Duration(c.SlowAfterMinutes)*time.Minute {
				waRepeat = time.Duration(c.SlowSeconds) * time.Second
			}
			if to := cw.chat(s); c.WhatsApp && !f.dry && to != "" && time.Since(lastWA) >= waRepeat-time.Second {
				select {
				case waBusy <- struct{}{}:
					lastWA = time.Now()
					id, at, n := visit.ID, last, visit.Pictures
					name := cameraName(s, cam)
					since := last.Sub(first)
					extra := note
					if waRepeat != repeat {
						extra += fmt.Sprintf("\n_Now one picture every %s (safety cap)._", fmtStay(waRepeat))
					}
					go func() {
						defer func() { <-waBusy }()
						label := fmt.Sprintf("Cat outside · %s so far", fmtStay(since))
						err := cw.app.alerts.deliver(cam, name, at, to, fmt.Sprintf("cat:%s:%d:%d", id, n, at.UnixMilli()), label, extra, 0)
						if err != nil {
							cw.update(id, func(v *CatVisit) { v.Error = "WhatsApp: " + err.Error() })
							return
						}
						cw.update(id, func(v *CatVisit) { v.Pictures++ })
					}()
					visit.Pictures++
				default:
				}
			}
		}
		if !sleepCtx(ctx, catCheckEvery-time.Since(tick)) {
			end("")
			return
		}
	}
}

// Replay plays the footage of cam from..to through cat watch in real time, starting
// now, as if it were happening now: real Alexa announcements and WhatsApp pictures (with
// a note that it's a replay). One replay at a time; StopReplay ends it.
func (cw *CatWatcher) Replay(cam string, from, to time.Time, dry bool) error {
	s := cw.app.settings.Get()
	if cameraConfig(s, cam).MainURL == "" {
		return errors.New("no such camera")
	}
	if !to.After(from) || to.Sub(from) > time.Hour {
		return errors.New("a replay is up to an hour of footage")
	}
	if _, err := cw.app.fragmentRefAt(cam, from, false); err != nil {
		return errors.New("there's no recording at the start of that time")
	}
	cw.mu.Lock()
	defer cw.mu.Unlock()
	if cw.replayStop != nil {
		return errors.New("a replay is already running")
	}
	ctx, cancel := context.WithCancel(cw.app.ctx)
	cw.replayStop = cancel
	cw.replayInfo = map[string]any{"camera": cam, "from": from.UnixMilli(), "to": to.UnixMilli(), "started": time.Now().UnixMilli(), "dry": dry}
	cw.active["replay:"+cam] = true
	f := catFeed{replay: true, offset: cw.app.clock.Now().Sub(from), until: to, dry: dry, tag: fmt.Sprintf("replay%d-", time.Now().Unix())}
	cw.app.incidents.Add("info", cam, "Cat watch: replaying %s–%s as if it were now", from.In(time.Local).Format("15:04:05"), to.In(time.Local).Format("15:04:05"))
	debugCat.Store(true)
	go func() {
		defer func() {
			debugCat.Store(false)
			cancel()
			cw.mu.Lock()
			cw.replayStop, cw.replayInfo = nil, nil
			cw.mu.Unlock()
		}()
		cw.watch(ctx, cam, f)
	}()
	return nil
}

func (cw *CatWatcher) StopReplay() {
	cw.mu.Lock()
	stop := cw.replayStop
	cw.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// chat: where cat watch's WhatsApp pictures go.
func (cw *CatWatcher) chat(s Settings) string {
	if s.CatWatch.WhatsAppTo != "" {
		return s.CatWatch.WhatsAppTo
	}
	return alertChat(s, "Cat")
}

func catClock(t time.Time) string { return t.In(time.Local).Format("3:04:05 PM") }

func fmtStay(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%d s", int(d.Seconds()))
	}
	if d < time.Hour {
		if s := int(d.Seconds()) % 60; s != 0 {
			return fmt.Sprintf("%d min %d s", int(d.Minutes()), s)
		}
		return fmt.Sprintf("%d min", int(d.Minutes()))
	}
	return fmt.Sprintf("%d h %d min", int(d.Hours()), int(d.Minutes())%60)
}

// ---- Alexa (through the Alexa Media Player integration in Home Assistant)

var errEchoUnavailable = errors.New("the Echo is unavailable (switched off?)")

func alexaVolume(entity string) (float64, error) {
	data, err := supervisorRequest("GET", "/core/api/states/"+entity, nil)
	if err != nil {
		return 0, err
	}
	var st struct {
		State      string `json:"state"`
		Attributes struct {
			Volume *float64 `json:"volume_level"`
		} `json:"attributes"`
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return 0, err
	}
	if st.State == "unavailable" || st.State == "off" {
		return 0, errEchoUnavailable
	}
	if st.Attributes.Volume == nil {
		return 0, errors.New("the Echo doesn't report its volume")
	}
	return *st.Attributes.Volume, nil
}

func alexaSetVolume(entity string, v float64) error {
	return callService("media_player.volume_set", map[string]any{"entity_id": entity, "volume_level": v})
}

// alexaSay raises the Echo to the cat watch volume (remembering what it was, the first
// time) and makes the announcement.
func (cw *CatWatcher) alexaSay(c CatWatch) error {
	e := c.AlexaEntity
	if e == "" {
		return errors.New("choose the Echo in Settings")
	}
	want := float64(c.AlexaVolume) / 100
	// Checked every time: the Echo is sometimes switched off. Then the announcement
	// counts as failed (WhatsApp goes on regardless).
	v, err := alexaVolume(e)
	if errors.Is(err, errEchoUnavailable) {
		return err
	}
	cw.alexaMu.Lock()
	_, raised := cw.alexaSaved[e]
	up := cw.alexaUp[e]
	cw.alexaMu.Unlock()
	// The volume is set once a visit: the Echo beeps at every volume change, and a
	// volume change every round was most of what was heard when the speech was dropped.
	// It is only changed when it could be read, so it can always be put back.
	switch {
	case up:
	case err != nil:
		logf("cat watch: can't read %s's volume, leaving it as it is: %v", e, err)
	default:
		if v != want {
			if !raised {
				cw.alexaMu.Lock()
				cw.alexaSaved[e] = v
				cw.alexaMu.Unlock()
				cw.save()
			}
			if err := alexaSetVolume(e, want); err != nil {
				return err
			}
		}
		cw.alexaMu.Lock()
		cw.alexaUp[e] = true
		cw.alexaMu.Unlock()
	}
	return callService("notify.alexa_media", map[string]any{"target": []string{e}, "message": c.AlexaMessage, "data": map[string]any{"type": "announce"}})
}

// alexaRestore puts back the volumes cat watch changed.
func (cw *CatWatcher) alexaRestore() {
	cw.alexaMu.Lock()
	saved := cw.alexaSaved
	cw.alexaSaved = map[string]float64{}
	cw.alexaUp = map[string]bool{}
	cw.alexaMu.Unlock()
	for e, v := range saved {
		// Let the last announcement finish first, or it's cut to the old volume.
		time.Sleep(6 * time.Second)
		if err := alexaSetVolume(e, v); err != nil {
			cw.app.incidents.Add("warn", "", "Cat watch couldn't put %s's volume back to %d%%: %v", e, int(v*100+0.5), err)
			cw.alexaMu.Lock()
			cw.alexaSaved[e] = v
			cw.alexaMu.Unlock()
		}
	}
	cw.save()
}

// ---- Tests (Settings page)

func (cw *CatWatcher) TestAlexa() error {
	c := cw.app.settings.Get().CatWatch
	if err := cw.alexaSay(c); err != nil {
		cw.alexaRestore()
		return err
	}
	go cw.alexaRestore()
	return nil
}

func (cw *CatWatcher) TestWhatsApp() error {
	s := cw.app.settings.Get()
	to := cw.chat(s)
	if to == "" {
		return errors.New("choose a WhatsApp chat first")
	}
	cam := ""
	if len(s.CatWatch.Cameras) > 0 {
		cam = s.CatWatch.Cameras[0]
	}
	if cam == "" {
		return errors.New("choose a camera first")
	}
	name := cameraName(s, cam)
	t := cw.app.clock.Now().Add(-8 * time.Second)
	id := "test-" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	err := cw.app.alerts.deliver(cam, name, t, to, "cat:"+id, "Test · cat watch on "+name, "", 0)
	v := CatVisit{ID: id, Camera: cam, CameraName: name, From: t.UnixMilli(), To: t.UnixMilli(), Test: true}
	if err != nil {
		v.Error = "WhatsApp: " + err.Error()
	} else {
		v.Pictures = 1
	}
	cw.put(v)
	return err
}

// ---- log

func (cw *CatWatcher) put(v CatVisit) {
	cw.mu.Lock()
	cw.log = append(cw.log, v)
	if len(cw.log) > catLogLimit {
		cw.log = cw.log[len(cw.log)-catLogLimit:]
	}
	cw.mu.Unlock()
	go cw.save()
}

func (cw *CatWatcher) update(id string, f func(v *CatVisit)) {
	cw.mu.Lock()
	for i := len(cw.log) - 1; i >= 0; i-- {
		if cw.log[i].ID == id {
			f(&cw.log[i])
			break
		}
	}
	cw.mu.Unlock()
	go cw.save()
}

func (cw *CatWatcher) save() {
	cw.fileMu.Lock()
	defer cw.fileMu.Unlock()
	cw.mu.Lock()
	cw.alexaMu.Lock()
	data, _ := json.Marshal(catWatchFile{Visits: cw.log, AlexaSaved: cw.alexaSaved})
	cw.alexaMu.Unlock()
	cw.mu.Unlock()
	_ = writeFileAtomic(cw.path, data, 0o644)
}

type AlexaDevice struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Volume *float64 `json:"volume,omitempty"`
}

// alexaDevices lists the Echos Home Assistant knows (Alexa Media Player's media players
// have a "last_called" attribute).
func alexaDevices() []AlexaDevice {
	out := []AlexaDevice{}
	data, err := supervisorRequest("GET", "/core/api/states", nil)
	if err != nil {
		return out
	}
	var states []struct {
		ID    string         `json:"entity_id"`
		Attrs map[string]any `json:"attributes"`
	}
	_ = json.Unmarshal(data, &states)
	for _, st := range states {
		if !strings.HasPrefix(st.ID, "media_player.") {
			continue
		}
		if _, alexa := st.Attrs["last_called"]; !alexa {
			continue
		}
		d := AlexaDevice{ID: st.ID, Name: st.ID}
		if n, ok := st.Attrs["friendly_name"].(string); ok && n != "" {
			d.Name = n
		}
		if v, ok := st.Attrs["volume_level"].(float64); ok {
			d.Volume = &v
		}
		out = append(out, d)
	}
	return out
}

// ---- Looking for cats

// catMin is how sure the big model must be that it's a cat (or a dog: from above, the
// models often take a cat for one). Low, because a cat must also be seen again and again
// for MinSeconds before anyone is alerted, and event labels still need the closer look.
// Tuned on 3 days of the 3rd floor camera: 29 of 30 events with a cat found (11 before),
// and no cat watch alert without a cat.
const catMin = 0.35

// catMaxArea: bigger "cats" (part of the picture) were people seen from above (a man in
// a white cap, someone crouching); the cats there were at most 3.2%.
const catMaxArea = 0.04

// catWeakMin: a weak cat sighting, for two of them close together starting a visit.
const catWeakMin = 0.28

type weakCat struct {
	t   time.Time
	box Rect
}

// catPersonMin: an animal that is part of a much bigger person doesn't count (the same
// box called both a cat and a person is a cat).
const catPersonMin = 0.35

// catRegions splits the frame into near-square parts, each looked at by the big model
// on its own, so a small cat is seen about 1.7 times bigger than in the whole frame
// (the model always looks at a 640×640 picture).
func catRegions(aspect float64) []Rect {
	if aspect <= 1.2 {
		return []Rect{fullFrame}
	}
	w := 1 / aspect // a square, in frame widths
	n := int(1/w + 0.999)
	if n < 2 {
		n = 2
	}
	w = min(max(w, 1/float64(n)+0.08), 1) // overlap, so a cat on a seam is whole in one
	out := make([]Rect, n)
	for i := range out {
		out[i] = Rect{X: (1 - w) * float64(i) / float64(n-1), W: w, H: 1}
	}
	return out
}

type catSighting struct {
	found  bool
	box    Rect
	score  float64
	still  bool // not seen by the detector: its spot still looks like the cat
	person bool // someone is in view too
}

// catDets runs the big model over the parts of the frame at t (the part named by hint
// first; with stopEarly, the rest only while no cat is found). People seen from above
// (crouching, a white cap) are often taken for a cat or dog: an animal on a person
// doesn't count. Ignored areas don't either.
func (a *App) catDets(ctx context.Context, cam Camera, t time.Time, hint Rect, stopEarly bool) (cats, weak []Detection, person bool, err error) {
	aspect := a.frameAspect(cam.ID)
	regions := catRegions(aspect)
	if hint != (Rect{}) && len(regions) > 1 {
		cx := hint.X + hint.W/2
		for i, r := range regions {
			if cx >= r.X+0.05 && cx <= r.X+r.W-0.05 {
				regions[0], regions[i] = regions[i], regions[0]
				break
			}
		}
	}
	mask := maskGrid(cam, shotW, shotH)
	var out []Detection
	var lastErr error
	looked := 0
	for _, r := range regions {
		dets, err := a.detectAt(ctx, cam.ID, t, r, modelVerify)
		if err != nil {
			lastErr = err
			continue
		}
		looked++
		for _, d := range dets {
			// Standing people are tall and thin; a cat (even one called a "person") isn't.
			tall := d.Label == "person" && d.Box.H/max(d.Box.W, 1e-6)/aspect >= 1.5
			if d.Label == "person" && d.Score >= 0.5 && (tall || d.Box.W*d.Box.H > catMaxArea) {
				person = true
			}
			if ar := d.Box.W * d.Box.H; ar <= catMaxArea && ar >= minBoxArea && !tall {
				wx, wy := int((d.Box.X+d.Box.W/2)*shotW), int((d.Box.Y+d.Box.H/2)*shotH)
				if !mask[min(max(wy, 0), shotH-1)*shotW+min(max(wx, 0), shotW-1)] {
					weak = append(weak, d) // anything cat-sized, for following a cat already seen
				}
			}
			if d.Label != "cat" && d.Label != "dog" || d.Score < catMin || d.Box.W*d.Box.H < minBoxArea || d.Box.W*d.Box.H > catMaxArea {
				continue
			}
			cx, cy := int((d.Box.X+d.Box.W/2)*shotW), int((d.Box.Y+d.Box.H/2)*shotH)
			if mask[min(max(cy, 0), shotH-1)*shotW+min(max(cx, 0), shotW-1)] {
				continue
			}
			onPerson := false
			for _, p := range dets {
				if p.Label == "person" && p.Score >= catPersonMin && overlapOfSmaller(d.Box, p.Box) >= 0.5 && p.Box.W*p.Box.H >= 2.5*d.Box.W*d.Box.H {
					onPerson = true
					break
				}
			}
			if !onPerson {
				out = append(out, d)
			}
		}
		if stopEarly && len(out) > 0 {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if looked == 0 {
		return nil, nil, false, lastErr
	}
	return out, weak, person, nil
}

// catLook: is there a cat in the frame at t (for cat watch)? weak is everything
// cat-sized the model saw, sure or not.
func (a *App) catLook(ctx context.Context, cam Camera, t time.Time, hint Rect) (catSighting, []Detection, error) {
	dets, weak, person, err := a.catDets(ctx, cam, t, hint, true)
	if len(dets) > 0 {
		return catSighting{found: true, box: dets[0].Box, score: dets[0].Score, person: person}, weak, nil
	}
	return catSighting{person: person}, weak, err
}

// Following a cat already seen. Sitting still and seen from above (facing the camera,
// curled up), a cat is often only a weak "cat", "dog" or even "person" to the model, or
// nothing: on the 3rd floor replay the cat sat by the door for 75 s with only weak or no
// detections. So once a cat has been seen clearly, it counts as still there when
//   - something cat-sized is seen weakly near where it was (catNear), or
//   - its spot still looks like the cat, not like the empty scene from before it came
//     (catStill: there, similarity to the empty floor fell from 1.00 to about 0.77 while
//     the cat sat, and came back to 1.00 seconds after it left).
// The look of the spot alone keeps a cat for at most catLostAfter.

// catNearby lists the weak sightings that could be the cat last seen at box: about its
// usual size (area), within reach (part of the picture; a walking cat goes further),
// nearest first.
func catNearby(weak []Detection, box Rect, area, reach float64) []Detection {
	type cand struct {
		d    Detection
		dist float64
	}
	var cs []cand
	for _, d := range weak {
		r := d.Box.W * d.Box.H / max(area, 1e-6)
		if r < 0.33 || r > 3 {
			continue
		}
		dx := (d.Box.X + d.Box.W/2) - (box.X + box.W/2)
		dy := (d.Box.Y + d.Box.H/2) - (box.Y + box.H/2)
		if dist := math.Sqrt(dx*dx + dy*dy); dist <= reach {
			cs = append(cs, cand{d, dist})
		}
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].dist < cs[j].dist })
	out := make([]Detection, len(cs))
	for i, c := range cs {
		out[i] = c.d
	}
	return out
}

const (
	patchSize        = 24
	patchW, patchH   = 480, 270 // the grey frame patches are cut from
	stillMaxEmptySim = 0.9      // the spot must look this little like the empty scene
	stillMinDiff     = 4.0      // and differ from it this much (mean grey level)
)

// catPatch is the grey picture of box (plus a little around it) in a patchW×patchH frame.
func catPatch(g []byte, box Rect) []float32 {
	x0 := int((box.X - box.W*0.15) * patchW)
	y0 := int((box.Y - box.H*0.15) * patchH)
	x1 := int((box.X + box.W*1.15) * patchW)
	y1 := int((box.Y + box.H*1.15) * patchH)
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, patchW), min(y1, patchH)
	if x1-x0 < 4 || y1-y0 < 4 || len(g) != patchW*patchH {
		return nil
	}
	out := make([]float32, patchSize*patchSize)
	for py := 0; py < patchSize; py++ {
		for px := 0; px < patchSize; px++ {
			ya, yb := y0+py*(y1-y0)/patchSize, y0+(py+1)*(y1-y0)/patchSize
			xa, xb := x0+px*(x1-x0)/patchSize, x0+(px+1)*(x1-x0)/patchSize
			sum, n := 0, 0
			for y := ya; y < max(yb, ya+1); y++ {
				for x := xa; x < max(xb, xa+1); x++ {
					sum += int(g[y*patchW+x])
					n++
				}
			}
			out[py*patchSize+px] = float32(sum) / float32(n)
		}
	}
	return out
}

// patchSim is the normalised correlation of two patches (1 = the same picture, up to
// brightness and contrast) and their mean difference in grey levels.
func patchSim(a, b []float32) (sim, diff float64) {
	if len(a) != len(b) || len(a) == 0 {
		return 1, 0
	}
	var ma, mb float64
	for i := range a {
		ma += float64(a[i])
		mb += float64(b[i])
	}
	ma /= float64(len(a))
	mb /= float64(len(b))
	var ab, aa, bb float64
	for i := range a {
		x, y := float64(a[i])-ma, float64(b[i])-mb
		ab += x * y
		aa += x * x
		bb += y * y
		diff += math.Abs(float64(a[i]) - float64(b[i]))
	}
	return ab / math.Sqrt(aa*bb+1e-6), diff / float64(len(a))
}

// catStill: does the spot box in the grey frame g still look like the cat (tpl) rather
// than the empty scene bg?
func catStill(g, bg []byte, box Rect, tpl []float32) bool {
	if tpl == nil {
		return false
	}
	cur, empty := catPatch(g, box), catPatch(bg, box)
	if cur == nil || empty == nil {
		return false
	}
	simEmpty, diffEmpty := patchSim(cur, empty)
	simCat, _ := patchSim(cur, tpl)
	if debugCat.Load() {
		logf("cat watch: its spot %s: like the empty scene %.2f (difference %.1f), like the cat %.2f", fmtBox(box), simEmpty, diffEmpty, simCat)
	}
	return simEmpty < stillMaxEmptySim && diffEmpty >= stillMinDiff && simCat > simEmpty
}

// catNotEmpty: does the spot box in the grey frame g look different from the empty scene
// bg (something is there that wasn't)? A weak sighting must pass this, so the shoes or
// the shoe rack, seen weakly as a "person", never keep a cat that has gone.
func catNotEmpty(g, bg []byte, box Rect) bool {
	cur, empty := catPatch(g, box), catPatch(bg, box)
	if cur == nil || empty == nil {
		return false
	}
	sim, diff := patchSim(cur, empty)
	if debugCat.Load() {
		logf("cat watch: weak sighting %s: like the empty scene %.2f (difference %.1f)", fmtBox(box), sim, diff)
	}
	return sim < stillMaxEmptySim && diff >= stillMinDiff
}

// grayNear is the grey frame (patchW×patchH) at t, or a little before when that one
// can't be decoded (it happens at the odd frame).
func (a *App) grayNear(ctx context.Context, cam string, t time.Time) []byte {
	for _, back := range []time.Duration{0, time.Second, 2 * time.Second, 4 * time.Second, 7 * time.Second} {
		if g, err := a.decodeGray(ctx, cam, t.Add(-back), patchW, patchH); err == nil {
			return g
		}
	}
	if debugCat.Load() {
		logf("cat watch: no grey frame near %s", t.In(time.Local).Format("15:04:05.0"))
	}
	return nil
}

// catTemplate is the grey picture of the cat at box in the frame at t.
func (a *App) catTemplate(ctx context.Context, cam string, t time.Time, box Rect) []float32 {
	if g := a.grayNear(ctx, cam, t); g != nil {
		return catPatch(g, box)
	}
	return nil
}

// debugCat logs how the spots of cats compare (set while a replay runs).
var debugCat atomic.Bool

// ---- Following a cat the detector can't see (blobs)
//
// Lying flat in the shade of the stairs, or half cut off by the picture's edge, a cat
// can be invisible to the detector (scores of 0.05-0.27 on the 3rd floor replay, where
// she lay on the landing for over 5 minutes) while plainly there to the eye. Once a cat
// has been clearly detected, cat watch also follows the cat-sized patch of the picture
// that differs from the empty scene (a blob): the one where it was, or, if it moved
// between two looks, one that wasn't there at the look before (a pair of slippers moved
// earlier, or the camera's clock text, was there before and never counts).

const (
	blobW, blobH  = patchW / 2, patchH / 2 // blobs are found at this size
	blobLevel     = 22                     // grey levels away from the empty scene
	blobMinPixels = 15
	overlayBand   = 0.1 // part of the picture's height along the top with the clock text
	// A blob alone keeps a cat this long after the detector last saw it.
	catBlobTrust = time.Hour
)

type catSpot struct {
	box Rect
	n   int // pixels
}

// emptyScene is the scene without the cat: for each point, the middle value of grey
// frames from the minutes before it came (a cat or a person in one or two of them
// doesn't count).
func (a *App) emptyScene(ctx context.Context, cam string, before time.Time) []byte {
	var frames [][]byte
	// Not the last few seconds: the cat is usually around already, and the middle of
	// seven frames is the empty floor if it's in up to three of them.
	for _, back := range []time.Duration{10 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 7 * time.Minute, 10 * time.Minute} {
		if g := a.grayNear(ctx, cam, before.Add(-back)); g != nil {
			frames = append(frames, g)
		}
	}
	if len(frames) == 0 {
		return nil
	}
	out := make([]byte, len(frames[0]))
	vals := make([]byte, len(frames))
	for i := range out {
		for j, f := range frames {
			vals[j] = f[i]
		}
		slices.Sort(vals)
		out[i] = vals[len(vals)/2]
	}
	return out
}

// blobs finds the patches of g (patchW×patchH grey) that differ from the empty scene bg.
func spots(g, bg []byte) []catSpot {
	if len(g) != patchW*patchH || len(bg) != len(g) {
		return nil
	}
	// Half size, then points far from the empty scene, grown by one so a patchy cat is
	// one blob.
	diff := make([]bool, blobW*blobH)
	for y := 0; y < blobH; y++ {
		for x := 0; x < blobW; x++ {
			s := 0
			for _, o := range [4]int{0, 1, patchW, patchW + 1} {
				i := (2*y)*patchW + 2*x + o
				s += int(g[i]) - int(bg[i])
			}
			if s < 0 {
				s = -s
			}
			diff[y*blobW+x] = s/4 > blobLevel
		}
	}
	grown := make([]bool, len(diff))
	for y := 0; y < blobH; y++ {
		for x := 0; x < blobW; x++ {
			i := y*blobW + x
			grown[i] = diff[i] || x > 0 && diff[i-1] || x < blobW-1 && diff[i+1] || y > 0 && diff[i-blobW] || y < blobH-1 && diff[i+blobW]
		}
	}
	seen := make([]bool, len(grown))
	var out []catSpot
	stack := []int{}
	for start := range grown {
		if !grown[start] || seen[start] {
			continue
		}
		seen[start] = true
		stack = append(stack[:0], start)
		n, x0, y0, x1, y1 := 0, blobW, blobH, 0, 0
		for len(stack) > 0 {
			i := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			x, y := i%blobW, i/blobW
			n++
			x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
			for _, j := range [4]int{i - 1, i + 1, i - blobW, i + blobW} {
				if j < 0 || j >= len(grown) || (j == i-1 && x == 0) || (j == i+1 && x == blobW-1) || !grown[j] || seen[j] {
					continue
				}
				seen[j] = true
				stack = append(stack, j)
			}
		}
		// The camera's clock text (a thin band along the top edge) changes every second:
		// never a cat (it was followed as one for three minutes on the replay).
		if n >= blobMinPixels && float64(y1+1)/blobH > overlayBand {
			out = append(out, catSpot{box: Rect{X: float64(x0) / blobW, Y: float64(y0) / blobH, W: float64(x1-x0+1) / blobW, H: float64(y1-y0+1) / blobH}, n: n})
		}
	}
	return out
}

// catBlob picks the blob that is the cat last seen at box: about its usual size (area),
// and either on its spot, or one that has appeared since (not among old: the blobs when
// it was last seen, and those that appeared while a person was in view, as people move
// things: a pair of slippers moved by someone going in was taken for the cat), within
// reach.
func catBlob(cur, old []catSpot, box Rect, area, reach, aspect float64) (Rect, bool) {
	// By the points that differ, not the blob's box: a box can take in shadows around a
	// cat. On the replay the cat lying on the stairs was ~100 points, the cat at the door
	// ~230; patches of evening light on the stairs 21-29 (a cat's box is about 45% cat).
	fits := func(b catSpot) bool {
		r := float64(b.n) / (blobW * blobH) / max(area*0.45, 1e-6)
		// A standing person is tall and thin (someone on the stairs where the cat had
		// just been was taken for it).
		tall := b.box.H/max(b.box.W, 1e-6)/aspect >= 1.5
		return r >= 0.25 && r <= 4 && !tall
	}
	var best Rect
	bestD := math.Inf(1)
	for _, b := range cur {
		if !fits(b) {
			continue
		}
		if overlapOfSmaller(b.box, box) >= 0.3 {
			return b.box, true // where it was
		}
		if old == nil || slices.ContainsFunc(old, func(p catSpot) bool { return overlapOfSmaller(p.box, b.box) >= 0.3 }) {
			continue // was already there: not the cat moving
		}
		dx := (b.box.X + b.box.W/2) - (box.X + box.W/2)
		dy := (b.box.Y + b.box.H/2) - (box.Y + box.H/2)
		if d := math.Sqrt(dx*dx + dy*dy); d <= reach && d < bestD {
			best, bestD = b.box, d
		}
	}
	return best, !math.IsInf(bestD, 1)
}

// catArea is the cat's usual size in this visit (the middle of the sizes it was detected
// at); box's while there are none. A walking cat's blob is often bigger (blur, shadow)
// and a cat lying down smaller, so they aren't compared with each other.
func catArea(sizes []float64, box Rect) float64 {
	if len(sizes) == 0 {
		return box.W * box.H
	}
	s := slices.Clone(sizes)
	slices.Sort(s)
	return s[len(s)/2]
}

// Waking cat watch: a small cat on a bright floor can stay under the motion threshold
// for seconds (on the 3rd floor, motion started 11 s after the cat came into view).
// Cat watch starts looking after two frames in a row with a third of that much change.
const catWakeShare = 0.33

// Activity: the motion detector's score for a frame of cam (part of the picture that
// changed, in %), and its threshold for motion.
func (cw *CatWatcher) Activity(cam string, score float64) {
	// Called for every frame: no settings or app locks here.
	v, ok := cw.thresholds.Load(cam)
	if !ok {
		return
	}
	thr := v.(float64)
	cw.mu.Lock()
	if score >= thr*catWakeShare && score > 0 {
		cw.stirred[cam]++
	} else {
		cw.stirred[cam] = 0
	}
	wake := cw.stirred[cam] == 2
	cw.mu.Unlock()
	if wake {
		cw.start(cam)
	}
}
