package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type App struct {
	ctx       context.Context
	media     string
	settings  *SettingsStore
	clock     *Clock
	store     *Store
	events    *EventStore
	activity  *ActivityStore
	previews  *PreviewStore
	clips     *ClipStore
	breakdown atomic.Value // map[string]int64: bytes per data type
	incidents *IncidentLog
	go2rtc    *Go2RTC
	mqtt      *MQTT
	started   time.Time
	heartbeat atomic.Int64

	mu        sync.Mutex
	recorders map[string]*Recorder
	motion    map[string]*MotionDetector
	cams      map[string]Camera
	outage    map[string]time.Time // camera -> when it stopped recording
	alerted   map[string]bool
	lastRec   map[string]bool
}

func (a *App) Init() {
	a.recorders = map[string]*Recorder{}
	a.motion = map[string]*MotionDetector{}
	a.cams = map[string]Camera{}
	a.outage = map[string]time.Time{}
	a.alerted = map[string]bool{}
	a.lastRec = map[string]bool{}
	a.clock.onFix = a.store.ApplyClockFix
	a.clock.onJump = func(j time.Duration) {
		a.incidents.Add("warn", "", "System clock jumped by %.1f s; starting new recording files", j.Seconds())
		a.mu.Lock()
		defer a.mu.Unlock()
		for _, r := range a.recorders {
			r.Restart()
		}
	}
	a.mqtt.onConnect = a.publishAll
}

// Apply starts, stops or restarts camera workers to match the settings.
func (a *App) Apply(s Settings) {
	a.mu.Lock()
	defer a.mu.Unlock()
	want := map[string]Camera{}
	for _, c := range s.Cameras {
		want[c.ID] = c
	}
	for id, old := range a.cams {
		c, ok := want[id]
		if ok && c.Enabled && old.Enabled && sameRecording(old, c) && sameMotion(old, c) {
			continue
		}
		if ok && c.Enabled && old.Enabled && sameRecording(old, c) {
			// Only motion settings changed: leave the recorder alone.
			if m := a.motion[id]; m != nil {
				m.Stop()
				delete(a.motion, id)
			}
			a.cams[id] = c
			if c.Motion {
				a.startMotion(c)
			}
			continue
		}
		if r := a.recorders[id]; r != nil {
			r.Stop()
			delete(a.recorders, id)
		}
		if m := a.motion[id]; m != nil {
			m.Stop()
			delete(a.motion, id)
		}
		delete(a.cams, id)
		delete(a.outage, id)
		delete(a.alerted, id)
	}
	for id, c := range want {
		if _, running := a.cams[id]; running || !c.Enabled {
			if !c.Enabled {
				a.cams[id] = c
			}
			continue
		}
		a.cams[id] = c
		if c.Record {
			r := newRecorder(c, a.store, a.clock, a.incidents)
			a.recorders[id] = r
			r.Start(a.ctx)
		}
		if c.Motion {
			a.startMotion(c)
		}
	}
	a.go2rtc.SetCameras(s.Cameras)
	a.mqtt.SetCameras(s.Cameras)
}

func (a *App) startMotion(c Camera) {
	m := newMotionDetector(c, a, a.incidents)
	a.motion[c.ID] = m
	m.Start(a.ctx)
}

func sameRecording(a, b Camera) bool {
	return a.MainURL == b.MainURL && a.Record == b.Record && a.Audio == b.Audio
}

func sameMotion(a, b Camera) bool {
	return a.SubURL == b.SubURL && a.Motion == b.Motion && a.MotionSensitivity == b.MotionSensitivity &&
		strings.TrimSpace(jsonString(a.MotionMasks)) == strings.TrimSpace(jsonString(b.MotionMasks)) && a.Name == b.Name
}

// ---- MotionListener ----

func (a *App) MotionStart(cam string, score float64) {
	e := a.events.Start(cam, a.clock.Now(), score)
	a.mqtt.Motion(cam, true)
	go a.captureThumb(cam, e.ID)
}

func (a *App) MotionUpdate(cam string, score float64) { a.events.Update(cam, score) }

func (a *App) MotionEnd(cam string) {
	a.events.End(cam, a.clock.Now())
	a.mqtt.Motion(cam, false)
}

func (a *App) Activity(cam string, score float64) { a.activity.Record(cam, a.clock.Now(), score) }

func (a *App) Preview(cam string, jpeg []byte) { a.previews.Add(cam, a.clock.Now(), jpeg) }

func (a *App) captureThumb(cam, id string) {
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	img, err := a.go2rtc.Frame(ctx, cam+"_sub")
	if err != nil || len(img) == 0 {
		return
	}
	p := a.events.ThumbPath(cam, id)
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if writeFileAtomic(p, img, 0o644) == nil {
		a.events.SetThumb(cam, id)
	}
	a.mqtt.Snapshot(cam, img)
}

// ---- background loops ----

func (a *App) Background() {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	lastCleanup := time.Time{}
	lastFlush := time.Now()
	lastStorage := time.Time{}
	lastSizes := time.Time{}
	for {
		select {
		case <-a.ctx.Done():
			a.activity.Flush()
			return
		case now := <-tick.C:
			a.heartbeat.Store(now.UnixMilli())
			a.superviseWorkers()
			a.checkOutages()
			if now.Sub(lastFlush) > time.Minute {
				a.activity.Flush()
				lastFlush = now
			}
			if now.Sub(lastCleanup) > time.Minute {
				a.cleanup()
				lastCleanup = now
			}
			if now.Sub(lastSizes) > 5*time.Minute {
				go a.measureSizes()
				lastSizes = now
			}
			if now.Sub(lastStorage) > time.Minute {
				a.publishStorage()
				lastStorage = now
			}
		}
	}
}

// superviseWorkers restarts any worker goroutine that died (it shouldn't, but a recorder
// that silently stops is exactly the failure Sentinel exists to prevent).
func (a *App) superviseWorkers() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, r := range a.recorders {
		if !r.Alive() || r.HeartbeatAge() > 90*time.Second {
			a.incidents.Add("error", id, "Recorder was unresponsive; restarted it")
			go r.Stop()
			nr := newRecorder(a.cams[id], a.store, a.clock, a.incidents)
			a.recorders[id] = nr
			nr.Start(a.ctx)
		}
	}
	for id, m := range a.motion {
		if !m.Alive() || time.Since(time.UnixMilli(m.heartbeat.Load())) > 90*time.Second {
			a.incidents.Add("warn", id, "Motion detector was unresponsive; restarted it")
			go m.Stop()
			nm := newMotionDetector(a.cams[id], a, a.incidents)
			a.motion[id] = nm
			nm.Start(a.ctx)
		}
	}
}

func (a *App) inQuietWindow(windows []string) bool {
	now := time.Now()
	mins := now.Hour()*60 + now.Minute()
	for _, w := range windows {
		s, e, ok := strings.Cut(w, "-")
		if !ok {
			continue
		}
		sm, em := hhmm(s), hhmm(e)
		if sm <= em && mins >= sm && mins < em || sm > em && (mins >= sm || mins < em) {
			return true
		}
	}
	return false
}

func hhmm(s string) int {
	h, m, _ := strings.Cut(s, ":")
	hi, _ := strconv.Atoi(h)
	mi, _ := strconv.Atoi(m)
	return hi*60 + mi
}

func (a *App) checkOutages() {
	s := a.settings.Get()
	a.mu.Lock()
	type change struct {
		cam      Camera
		rec      bool
		alert    bool
		resolved bool
		down     time.Duration
		errMsg   string
	}
	var changes []change
	for id, r := range a.recorders {
		st := r.Status()
		rec := st.State == "recording"
		cam := a.cams[id]
		if prev, ok := a.lastRec[id]; !ok || prev != rec {
			a.lastRec[id] = rec
			changes = append(changes, change{cam: cam, rec: rec})
		}
		if rec {
			if since, down := a.outage[id]; down {
				if a.alerted[id] {
					changes = append(changes, change{cam: cam, rec: true, resolved: true, down: time.Since(since)})
				}
				delete(a.outage, id)
				delete(a.alerted, id)
			}
			continue
		}
		if _, down := a.outage[id]; !down {
			a.outage[id] = time.Now()
		}
		if !a.alerted[id] && time.Since(a.outage[id]) >= time.Duration(s.NotifyAfterMinutes)*time.Minute && !a.inQuietWindow(s.QuietWindows) {
			a.alerted[id] = true
			changes = append(changes, change{cam: cam, alert: true, down: time.Since(a.outage[id]), errMsg: st.LastError})
		}
	}
	a.mu.Unlock()
	for _, c := range changes {
		switch {
		case c.alert:
			msg := c.cam.Name + " has not recorded for " + humanDuration(c.down) + "."
			if c.errMsg != "" {
				msg += " Last error: " + c.errMsg
			}
			msg += " Sentinel keeps retrying automatically."
			a.incidents.Add("error", c.cam.ID, "Alert sent: not recording for %s", humanDuration(c.down))
			notifyHA(s.NotifyService, "Sentinel: "+c.cam.Name+" is not recording", msg, c.cam.ID, false)
		case c.resolved:
			notifyHA(s.NotifyService, "Sentinel: "+c.cam.Name+" is recording again", c.cam.Name+" is recording again after "+humanDuration(c.down)+".", c.cam.ID, true)
		default:
			a.mqtt.Recording(c.cam.ID, c.rec)
		}
	}
}

func humanDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	if d < time.Minute {
		return "under a minute"
	}
	h, m := int(d.Hours()), int(d.Minutes())%60
	switch {
	case h == 0:
		return strconv.Itoa(m) + " min"
	case m == 0:
		return strconv.Itoa(h) + " h"
	default:
		return strconv.Itoa(h) + " h " + strconv.Itoa(m) + " min"
	}
}

func (a *App) retention() (map[string]int, int) {
	s := a.settings.Get()
	retain := map[string]int{}
	def := 2
	for _, c := range s.Cameras {
		retain[c.ID] = c.RetainDays
		if c.RetainDays > def {
			def = c.RetainDays
		}
	}
	return retain, def
}

func (a *App) cleanup() {
	retain, def := a.retention()
	s := a.settings.Get()
	a.store.Cleanup(retain, def, s.MinFreeGB)
	a.events.Cleanup(retain, def)
	a.activity.Cleanup(retain, def)
	a.previews.Cleanup(retain, def)
	a.clips.Cleanup(s.ClipRetentionDays)
}

func (a *App) publishStorage() {
	du := diskUsage(a.store.root)
	var used int64
	for _, cs := range a.store.Stats() {
		used += cs.Bytes
	}
	a.mqtt.Storage(float64(du.Free)/1e9, float64(used)/1e9)
	cs := a.clock.Status()
	a.mqtt.ClockProblem(cs.LastCheck > 0 && !cs.Synced || cs.OffsetMs > 5000 || cs.OffsetMs < -5000)
}

func (a *App) publishAll() {
	a.mu.Lock()
	for id, r := range a.recorders {
		a.mqtt.Recording(id, r.Status().State == "recording")
	}
	for id, m := range a.motion {
		a.mqtt.Motion(id, m.Status().Active)
	}
	a.mu.Unlock()
	a.publishStorage()
}

// Healthy is what the Supervisor watchdog checks: if the main loop or a recorder loop
// is stuck, the add-on gets restarted.
func (a *App) Healthy() bool {
	if time.Since(time.UnixMilli(a.heartbeat.Load())) > 60*time.Second {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, r := range a.recorders {
		if r.HeartbeatAge() > 3*time.Minute {
			return false
		}
	}
	return true
}

// measureSizes adds up what each kind of Sentinel data uses on disk (System page).
func (a *App) measureSizes() {
	sizes := map[string]int64{}
	for _, d := range []string{"recordings", "previews", "events", "activity", "exports"} {
		_ = filepath.WalkDir(filepath.Join(a.media, d), func(_ string, e os.DirEntry, err error) error {
			if err == nil && !e.IsDir() {
				if info, err := e.Info(); err == nil {
					sizes[d] += info.Size()
				}
			}
			return nil
		})
	}
	a.breakdown.Store(sizes)
}
