package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// Night alerts: when motion starts inside the alert hours, Sentinel sends WhatsApp pictures
// of the moment with the most movement: a close-up of the area that moved (full resolution,
// from the recording) and the whole scene. Optionally the event is saved as a clip, which
// the Drive backup can upload.

type alertSample struct {
	t     time.Time
	score float64
	box   Rect
}

type AlertRecord struct {
	ID         string `json:"id"`
	Camera     string `json:"camera"`
	CameraName string `json:"camera_name"`
	At         int64  `json:"at"` // the moment in the pictures (unix ms)
	Event      string `json:"event,omitempty"`
	Status     string `json:"status"` // sending | sent | failed
	Error      string `json:"error,omitempty"`
	Clip       string `json:"clip,omitempty"`
	Test       bool   `json:"test,omitempty"`
}

type Alerter struct {
	app     *App
	wa      *WhatsAppClient
	path    string
	mu      sync.Mutex
	samples map[string][]alertSample
	cams    map[string]*camAlerts
	log     []AlertRecord // newest last
}

// camAlerts is one camera's alert state.
type camAlerts struct {
	busy    bool        // an alert (and its follow-ups) is being handled
	last    time.Time   // last picture sent
	sent    []time.Time // pictures sent in the last hour
	pending *Event      // motion that started during the gap: sent when the gap ends
	timer   *time.Timer
	limited bool // hourly limit reached (reported once)
}

const alertLogLimit = 300

func newAlerter(app *App, path string) *Alerter {
	al := &Alerter{app: app, wa: newWhatsAppClient(app), path: path, samples: map[string][]alertSample{}, cams: map[string]*camAlerts{}}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &al.log)
	}
	for i := range al.log {
		if al.log[i].Status == "sending" {
			al.log[i].Status, al.log[i].Error = "failed", "interrupted by a restart"
		}
	}
	return al
}

// inWindow reports whether t's local time of day is inside from-to ("23:00", "06:00").
func inWindow(from, to string, t time.Time) bool {
	mins := t.Hour()*60 + t.Minute()
	s, e := hhmm(from), hhmm(to)
	if s <= e {
		return mins >= s && mins < e
	}
	return mins >= s || mins < e
}

func (al *Alerter) Sample(cam string, t time.Time, score float64, box Rect) {
	al.mu.Lock()
	defer al.mu.Unlock()
	list := append(al.samples[cam], alertSample{t, score, box})
	cut := t.Add(-5 * time.Minute)
	i := 0
	for i < len(list) && list[i].t.Before(cut) {
		i++
	}
	al.samples[cam] = list[i:]
}

// best returns the moment with the most movement in [from, to] (unix ms).
func (al *Alerter) best(cam string, from, to int64) alertSample {
	al.mu.Lock()
	defer al.mu.Unlock()
	b := alertSample{t: time.UnixMilli(from + 1000)}
	for _, x := range al.samples[cam] {
		if ms := x.t.UnixMilli(); ms >= from && ms <= to && x.score > b.score {
			b = x
		}
	}
	return b
}

// Active reports whether alerts would be sent right now (for the UI).
func (al *Alerter) Active() bool {
	s := al.app.settings.Get()
	return s.NightAlerts.Enabled && inWindow(s.NightAlerts.From, s.NightAlerts.To, time.Now())
}

func (al *Alerter) state(cam string) *camAlerts {
	st := al.cams[cam]
	if st == nil {
		st = &camAlerts{}
		al.cams[cam] = st
	}
	return st
}

func (al *Alerter) MotionStart(cam string, e Event) {
	s := al.app.settings.Get()
	n := s.NightAlerts
	if !n.Enabled || s.WhatsApp.To == "" || !inWindow(n.From, n.To, time.Now()) {
		return
	}
	if len(n.Cameras) > 0 && !contains(n.Cameras, cam) {
		return
	}
	al.mu.Lock()
	defer al.mu.Unlock()
	st := al.state(cam)
	if st.busy {
		st.pending = &e // handled right after the current alert
		return
	}
	if wait := time.Duration(n.CooldownSeconds)*time.Second - time.Since(st.last); wait > 0 {
		st.pending = &e
		al.scheduleLocked(cam, st, wait)
		return
	}
	st.busy = true
	go al.fire(cam, e)
}

func (al *Alerter) scheduleLocked(cam string, st *camAlerts, wait time.Duration) {
	if st.timer != nil {
		return
	}
	st.timer = time.AfterFunc(max(wait, 0), func() {
		al.mu.Lock()
		defer al.mu.Unlock()
		st.timer = nil
		if st.busy || st.pending == nil {
			return
		}
		e := *st.pending
		st.pending = nil
		st.busy = true
		go al.fire(cam, e)
	})
}

// allowLocked applies the hourly limit. It returns false when a picture must be skipped,
// and a caption note when this is the last picture before the limit.
func (al *Alerter) allowLocked(cam string, st *camAlerts, limit int) (bool, string) {
	now := time.Now()
	i := 0
	for i < len(st.sent) && now.Sub(st.sent[i]) > time.Hour {
		i++
	}
	st.sent = st.sent[i:]
	if limit > 0 && len(st.sent) >= limit {
		if !st.limited {
			st.limited = true
			al.app.incidents.Add("warn", cam, "Night alerts paused: %d pictures in the last hour (limit)", limit)
		}
		return false, ""
	}
	st.limited = false
	st.sent = append(st.sent, now)
	st.last = now
	if limit > 0 && len(st.sent) == limit {
		return true, fmt.Sprintf("\n_Alert limit reached: more from this camera after %s_", st.sent[0].Add(time.Hour).In(time.Local).Format("15:04"))
	}
	return true, ""
}

func (al *Alerter) fire(cam string, e Event) {
	defer func() {
		if p := recover(); p != nil {
			al.app.incidents.Add("error", cam, "night alert crashed: %v", p)
		}
		s := al.app.settings.Get()
		al.mu.Lock()
		st := al.state(cam)
		st.busy = false
		if st.pending != nil {
			al.scheduleLocked(cam, st, time.Duration(s.NightAlerts.CooldownSeconds)*time.Second-time.Since(st.last))
		}
		al.mu.Unlock()
	}()
	s := al.app.settings.Get()
	n := s.NightAlerts
	// Let the motion develop: short blips (insects, rain, IR flicker) end before this.
	if wait := time.UnixMilli(e.Start).Add(time.Duration(max(n.MinSeconds, 2)) * time.Second); time.Until(wait) > 0 && !sleepCtx(al.app.ctx, time.Until(wait)) {
		return
	}
	ev, ok := al.app.events.Get(cam, e.ID)
	if !ok || ev.End != 0 && ev.End-ev.Start < int64(n.MinSeconds)*1000 {
		return
	}
	name := cameraName(s, cam)
	end := ev.End
	if end == 0 {
		end = time.Now().UnixMilli()
	}
	best := al.best(cam, ev.Start-1000, end)

	al.mu.Lock()
	ok, note := al.allowLocked(cam, al.state(cam), n.MaxPerHour)
	al.mu.Unlock()
	if !ok {
		return
	}
	rec := AlertRecord{ID: e.ID, Camera: cam, CameraName: name, At: best.t.UnixMilli(), Event: e.ID, Status: "sending"}
	al.put(rec)
	err := al.deliver(cam, name, best.t, best.box, n.CloseUp, s.WhatsApp.To, e.ID, "", note, 15*time.Minute)
	al.finish(rec.ID, err)
	if err != nil {
		al.app.incidents.Add("error", cam, "Night alert not sent to WhatsApp: %v", err)
		notifyHA("", "Sentinel: night alert not sent", fmt.Sprintf("Motion on %s at %s, but the WhatsApp alert failed: %v", name, best.t.In(time.Local).Format("15:04:05"), err), "whatsapp", false)
	} else {
		al.app.incidents.Add("info", cam, "Night alert sent to WhatsApp (%s)", s.WhatsApp.ToName)
		notifyHA("", "", "", "whatsapp", true)
	}
	if n.SaveClip {
		go al.saveClip(cam, name, ev, rec.ID)
	}

	// Follow-ups: while the same motion goes on, a new picture every FollowupSeconds.
	for i := 2; err == nil && n.FollowupSeconds > 0; i++ {
		from := time.Now()
		if !sleepCtx(al.app.ctx, time.Duration(n.FollowupSeconds)*time.Second) {
			return
		}
		cur, ok := al.app.events.Get(cam, e.ID)
		if !ok || cur.End != 0 && cur.End < from.UnixMilli()+2000 {
			return // the motion stopped; the next motion is a new alert
		}
		b := al.best(cam, from.UnixMilli(), time.Now().UnixMilli())
		al.mu.Lock()
		ok, note = al.allowLocked(cam, al.state(cam), n.MaxPerHour)
		al.mu.Unlock()
		if !ok {
			return
		}
		id := fmt.Sprintf("%s-f%d", e.ID, i)
		al.put(AlertRecord{ID: id, Camera: cam, CameraName: name, At: b.t.UnixMilli(), Event: e.ID, Status: "sending"})
		err = al.deliver(cam, name, b.t, b.box, n.CloseUp, s.WhatsApp.To, id, "Still moving", note, 5*time.Minute)
		al.finish(id, err)
		n = al.app.settings.Get().NightAlerts
	}
}

// deliver renders the pictures and sends them, retrying while the bridge or WhatsApp is
// down (e.g. during a router restart) for up to `patience`.
func (al *Alerter) deliver(cam, name string, t time.Time, box Rect, closeUp bool, to, key, label, note string, patience time.Duration) error {
	full, crop, err := al.pictures(cam, t, box, closeUp)
	if err != nil {
		return err
	}
	when := t.In(time.Local).Format("Mon 2 Jan · 3:04:05 PM")
	type msg struct {
		img     []byte
		caption string
	}
	if label == "" {
		label = "Motion"
	}
	caption := fmt.Sprintf("🚨 *%s · %s*\n%s%s", label, name, when, note)
	msgs := []msg{{full, caption}}
	if crop != nil {
		msgs = []msg{{crop, caption}, {full, "Full view · " + name}}
	}
	deadline := time.Now().Add(patience)
	for i, m := range msgs {
		var bo backoff
		for {
			err := al.wa.SendImage(to, m.img, m.caption, fmt.Sprintf("sentinel:%s:%d", key, i+1))
			if err == nil {
				break
			}
			var be *bridgeError
			if !errors.As(err, &be) || !be.retryable || time.Now().After(deadline) {
				return err
			}
			if !sleepCtx(al.app.ctx, 5*bo.next()) {
				return err
			}
		}
	}
	return nil
}

// pictures returns the full scene (up to 1920 px wide) and, when asked and useful, a
// close-up of the moving area, both decoded from the full-quality recording.
func (al *Alerter) pictures(cam string, t time.Time, box Rect, closeUp bool) (full, crop []byte, err error) {
	ctx := al.app.ctx
	// The recording reaches the disk a few seconds after the fact.
	for deadline := time.Now().Add(30 * time.Second); ; {
		full, err = al.app.decodeFrame(ctx, cam, t, "scale='min(1920,iw)':-2", 3, true)
		if err == nil || time.Now().After(deadline) || !sleepCtx(ctx, 2*time.Second) {
			break
		}
	}
	if full == nil {
		// Not recording right now: fall back to the live substream.
		if full, err = al.app.go2rtc.Frame(ctx, cam+"_sub"); err != nil {
			return nil, nil, fmt.Errorf("no picture available: %v", err)
		}
		return full, nil, nil
	}
	if closeUp && box.W > 0 && box.H > 0 {
		r := closeUpRect(box)
		if r.W*r.H < 0.6 {
			vf := fmt.Sprintf("crop=trunc(iw*%.4f/2)*2:trunc(ih*%.4f/2)*2:trunc(iw*%.4f):trunc(ih*%.4f),scale=-2:720:flags=lanczos", r.W, r.H, r.X, r.Y)
			crop, _ = al.app.decodeFrame(ctx, cam, t, vf, 2, true)
		}
	}
	return full, crop, nil
}

// closeUpRect widens the motion box with some margin, keeps a sensible shape (between
// portrait 3:4 and 16:9 on a 16:9 frame) and keeps it inside the frame.
func closeUpRect(b Rect) Rect {
	cx, cy := b.X+b.W/2, b.Y+b.H/2
	w, h := max(b.W*1.5, 0.2), max(b.H*1.5, 0.2)
	if ar := w * 16 / (h * 9); ar > 16.0/9 {
		h = w
	} else if ar < 0.75 {
		w = h * 27 / 64
	}
	w, h = min(w, 1), min(h, 1)
	x := min(max(cx-w/2, 0), 1-w)
	y := min(max(cy-h/2, 0), 1-h)
	return Rect{X: x, Y: y, W: w, H: h}
}

// saveClip saves the event (10 s before to 10 s after, at most 3 minutes) as a clip.
func (al *Alerter) saveClip(cam, name string, ev Event, alertID string) {
	limit := time.UnixMilli(ev.Start).Add(3 * time.Minute)
	for {
		cur, ok := al.app.events.Get(cam, ev.ID)
		if !ok || cur.End != 0 || time.Now().After(limit) {
			if ok {
				ev = cur
			}
			break
		}
		if !sleepCtx(al.app.ctx, 5*time.Second) {
			return
		}
	}
	end := time.UnixMilli(ev.End)
	if ev.End == 0 || end.After(limit) {
		end = limit
	}
	from, to := time.UnixMilli(ev.Start).Add(-10*time.Second), end.Add(10*time.Second)
	// Wait until that footage is on disk.
	if d := time.Until(to.Add(8 * time.Second)); d > 0 && !sleepCtx(al.app.ctx, d) {
		return
	}
	cam0 := Camera{ID: cam, Name: name}
	c, err := al.app.clips.create(cam0, from, to, fmt.Sprintf("Night alert · %s · %s", name, from.In(time.Local).Format("Jan 2 15.04")), true, false)
	if err != nil {
		al.app.incidents.Add("warn", cam, "Could not save the night alert clip: %v", err)
		return
	}
	al.mu.Lock()
	for i := range al.log {
		if al.log[i].ID == alertID {
			al.log[i].Clip = c.ID
		}
	}
	al.saveLocked()
	al.mu.Unlock()
}

// Test sends the current picture of a camera to the chosen chat.
func (al *Alerter) Test(cam string) error {
	s := al.app.settings.Get()
	if s.WhatsApp.To == "" {
		return errors.New("choose a WhatsApp chat first")
	}
	name := cameraName(s, cam)
	t := al.app.clock.Now().Add(-8 * time.Second)
	id := fmt.Sprintf("test-%d", time.Now().UnixMilli())
	rec := AlertRecord{ID: id, Camera: cam, CameraName: name, At: t.UnixMilli(), Status: "sending", Test: true}
	al.put(rec)
	err := al.deliver(cam, name, t, Rect{}, false, s.WhatsApp.To, id, "Test", "", 0)
	al.finish(id, err)
	return err
}

func cameraName(s Settings, cam string) string {
	for _, c := range s.Cameras {
		if c.ID == cam {
			return c.Name
		}
	}
	return cam
}

func (al *Alerter) put(r AlertRecord) {
	al.mu.Lock()
	defer al.mu.Unlock()
	al.log = append(al.log, r)
	if len(al.log) > alertLogLimit {
		al.log = al.log[len(al.log)-alertLogLimit:]
	}
	al.saveLocked()
}

func (al *Alerter) finish(id string, err error) {
	al.mu.Lock()
	defer al.mu.Unlock()
	for i := range al.log {
		if al.log[i].ID == id {
			if err != nil {
				al.log[i].Status, al.log[i].Error = "failed", err.Error()
			} else {
				al.log[i].Status = "sent"
			}
		}
	}
	al.saveLocked()
}

func (al *Alerter) saveLocked() {
	data, _ := json.Marshal(al.log)
	_ = writeFileAtomic(al.path, data, 0o644)
}

func (al *Alerter) List() []AlertRecord {
	al.mu.Lock()
	defer al.mu.Unlock()
	out := make([]AlertRecord, len(al.log))
	for i, r := range al.log {
		out[len(al.log)-1-i] = r
	}
	return out
}
