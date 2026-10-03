package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
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
	// Gone: no cat for this long, no motion now, and new motion since it was last seen
	// (leaving makes motion; a cat sitting still that the detector misses for a while
	// doesn't). Without new motion, gone only after catLostAfter.
	catGoneAfter = 30 * time.Second
	catLostAfter = 5 * time.Minute
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
	app    *App
	path   string
	mu     sync.Mutex
	active map[string]bool      // camera -> being watched now
	moved  map[string]time.Time // camera -> when motion last started
	log    []CatVisit           // newest last
	fileMu sync.Mutex
	// The Echo's volume before cat watch raised it, while raised (restored after a
	// restart too: it's saved with the log).
	alexaMu    sync.Mutex
	alexaSaved map[string]float64
	// The replay running now, if any.
	replayStop context.CancelFunc
	replayInfo map[string]any
}

type catWatchFile struct {
	Visits     []CatVisit         `json:"visits"`
	AlexaSaved map[string]float64 `json:"alexa_saved,omitempty"`
}

func newCatWatcher(app *App, path string) *CatWatcher {
	cw := &CatWatcher{app: app, path: path, active: map[string]bool{}, moved: map[string]time.Time{}, alexaSaved: map[string]float64{}}
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
	defer cw.mu.Unlock()
	cw.moved[cam] = time.Now()
	if !cw.watching(cw.app.settings.Get(), cam) {
		return
	}
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
		first, last, seenAt, hint, visit, alerting = time.Time{}, time.Time{}, time.Time{}, Rect{}, nil, time.Time{}
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
			if err := cw.app.alerts.wa.Send(to, msg, "sentinel:cat:"+visit.ID+":end"); err != nil {
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
		look, err := cw.app.catLook(ctx, cameraConfig(s, cam), t, hint)
		if err != nil {
			if errs++; errs == 5 {
				cw.app.incidents.Add("warn", cam, "Cat watch can't check frames: %v", err)
			}
		} else {
			errs = 0
		}
		if look.found {
			if last.IsZero() || t.Sub(last) > catGap {
				if visit != nil && visit.Alerted == 0 {
					cw.update(visit.ID, func(v *CatVisit) { v.Ongoing = false })
					visit = nil
				}
				if visit == nil {
					first = t
				}
			}
			last, hint, seenAt = t, look.box, time.Now()
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
		case t.Sub(last) > catGap && visit != nil && visit.Alerted == 0 && quiet > catIdleAfter && left:
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
			if c.Alexa && !f.dry && time.Since(lastAlexa) >= repeat-time.Second {
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
	go func() {
		defer func() {
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
	if st.State == "unavailable" {
		return 0, errors.New("the Echo is unavailable")
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
	cw.alexaMu.Lock()
	_, raised := cw.alexaSaved[e]
	cw.alexaMu.Unlock()
	if !raised {
		if v, err := alexaVolume(e); err == nil && v != want {
			cw.alexaMu.Lock()
			cw.alexaSaved[e] = v
			cw.alexaMu.Unlock()
			cw.save()
		} else if err != nil {
			logf("cat watch: can't read %s's volume (it won't be put back): %v", e, err)
		}
	}
	if err := alexaSetVolume(e, want); err != nil {
		return err
	}
	return callService("notify.alexa_media", map[string]any{"target": []string{e}, "message": c.AlexaMessage, "data": map[string]any{"type": "announce"}})
}

// alexaRestore puts back the volumes cat watch changed.
func (cw *CatWatcher) alexaRestore() {
	cw.alexaMu.Lock()
	saved := cw.alexaSaved
	cw.alexaSaved = map[string]float64{}
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
	found bool
	box   Rect
	score float64
}

// catDets runs the big model over the parts of the frame at t (the part named by hint
// first; with stopEarly, the rest only while no cat is found). People seen from above
// (crouching, a white cap) are often taken for a cat or dog: an animal on a person
// doesn't count. Ignored areas don't either.
func (a *App) catDets(ctx context.Context, cam Camera, t time.Time, hint Rect, stopEarly bool) ([]Detection, error) {
	regions := catRegions(a.frameAspect(cam.ID))
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
		return nil, lastErr
	}
	return out, nil
}

// catLook: is there a cat in the frame at t (for cat watch)?
func (a *App) catLook(ctx context.Context, cam Camera, t time.Time, hint Rect) (catSighting, error) {
	dets, err := a.catDets(ctx, cam, t, hint, true)
	if len(dets) > 0 {
		return catSighting{found: true, box: dets[0].Box, score: dets[0].Score}, nil
	}
	return catSighting{}, err
}
