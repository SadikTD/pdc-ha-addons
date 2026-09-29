package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func msParam(r *http.Request, name string, def time.Time) time.Time {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return time.UnixMilli(n)
}

func (a *App) Routes(www string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if a.Healthy() {
			writeJSON(w, 200, map[string]string{"status": "ok"})
			return
		}
		writeErr(w, 503, "unhealthy")
	})
	mux.HandleFunc("GET /api/status", a.handleStatus)
	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.settings.Get()) })
	mux.HandleFunc("PUT /api/settings", a.handlePutSettings)
	mux.HandleFunc("POST /api/test-stream", a.handleTestStream)
	mux.HandleFunc("GET /api/cameras/{id}/snapshot.jpg", a.handleSnapshot)
	mux.HandleFunc("GET /api/recordings/{id}", a.handleCoverage)
	mux.HandleFunc("GET /api/activity/{id}", a.handleActivity)
	mux.HandleFunc("GET /api/events", a.handleEvents)
	mux.HandleFunc("GET /api/events/{cam}/{id}/thumb.jpg", a.handleThumb)
	mux.HandleFunc("GET /api/events/{cam}/{id}/snap.jpg", a.handleSnap)
	mux.HandleFunc("GET /api/search", a.handleSearch)
	// "That's not a person": the label goes, and the camera learns the spot.
	mux.HandleFunc("POST /api/events/{cam}/{id}/wrong", func(w http.ResponseWriter, r *http.Request) {
		cam, id := r.PathValue("cam"), r.PathValue("id")
		var req struct {
			Label string `json:"label"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req) != nil || !slices.Contains(watchLabels, req.Label) {
			writeErr(w, 400, "which label?")
			return
		}
		o, ok := a.events.RemoveLabel(cam, id, req.Label)
		if !ok {
			writeErr(w, 404, "no such label on that event")
			return
		}
		a.labeler.hot.Add(cam, o.Box, userHits)
		a.labeler.hot.Save()
		e, _ := a.events.Get(cam, id)
		writeJSON(w, 200, e)
	})
	// The WhatsApp morning report as it would be sent now (preview), and a test send.
	mux.HandleFunc("GET /api/whatsapp/morning-report", func(w http.ResponseWriter, r *http.Request) {
		s := a.settings.Get()
		rep := a.nightReport(time.Now())
		if r.URL.Query().Get("from") != "" { // any span, for trying it out
			rep = a.reportBetween(msParam(r, "from", time.Now()), msParam(r, "to", time.Now()))
		}
		if r.URL.Query().Get("format") == "jpg" {
			img, err := rep.picture(a, s)
			if err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(img)
			return
		}
		writeJSON(w, 200, map[string]any{"caption": rep.caption(s), "from": rep.From.UnixMilli(), "to": rep.To.UnixMilli(), "people": len(rep.People)})
	})
	mux.HandleFunc("POST /api/whatsapp/morning-report/test", func(w http.ResponseWriter, r *http.Request) {
		s := a.settings.Get()
		if s.WhatsApp.To == "" {
			writeErr(w, 400, "choose the chat for night alerts first")
			return
		}
		rep := a.nightReport(time.Now())
		img, err := rep.picture(a, s)
		if err == nil {
			err = a.alerts.wa.SendImage(s.WhatsApp.To, img, rep.caption(s), fmt.Sprintf("sentinel:report-test:%d", time.Now().UnixMilli()))
		}
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/detection/hotspots/{cam}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, a.labeler.hot.List(r.PathValue("cam")))
	})
	mux.HandleFunc("DELETE /api/detection/hotspots/{cam}", func(w http.ResponseWriter, r *http.Request) {
		a.labeler.hot.Clear(r.PathValue("cam"))
		a.labeler.hot.Save()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	// Check events again (e.g. after changing detection): from/to in unix ms.
	mux.HandleFunc("POST /api/detection/rescan", func(w http.ResponseWriter, r *http.Request) {
		now := time.Now()
		from, to := msParam(r, "from", now.Add(-24*time.Hour)), msParam(r, "to", now)
		var cams []string
		if c := r.URL.Query().Get("cameras"); c != "" {
			cams = strings.Split(c, ",")
		}
		n := a.events.Rescan(cams, from.UnixMilli(), to.UnixMilli(), r.URL.Query().Get("only") == "seen")
		a.labeler.Poke()
		writeJSON(w, 200, map[string]int{"events": n})
	})
	// Why an event got (or didn't get) its labels: checks it again, step by step, without
	// saving or learning anything.
	mux.HandleFunc("GET /api/detection/explain/{cam}/{id}", func(w http.ResponseWriter, r *http.Request) {
		e, ok := a.events.Get(r.PathValue("cam"), r.PathValue("id"))
		if !ok {
			writeErr(w, 404, "no such event")
			return
		}
		var steps []string
		trace := func(format string, args ...any) { steps = append(steps, fmt.Sprintf(format, args...)) }
		objs, rejected, _, checked := a.labeler.scan(r.Context(), e, scanOpts{dry: true, trace: trace})
		writeJSON(w, 200, map[string]any{"labels_now": e.Labels, "objects": objs, "rejected": rejected, "frames": checked, "steps": steps})
	})
	// People: who the faces are (see faces.go).
	mux.HandleFunc("GET /api/people", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"people": a.faces.PeopleInfo(), "status": a.faces.Status()})
	})
	mux.HandleFunc("PATCH /api/people/{id}", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		p, err := a.faces.Rename(r.PathValue("id"), req.Name)
		if err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		writeJSON(w, 200, p)
	})
	mux.HandleFunc("DELETE /api/people/{id}", func(w http.ResponseWriter, r *http.Request) {
		a.faces.Forget(r.PathValue("id"))
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/people/{id}/faces", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 {
			limit = 60
		}
		writeJSON(w, 200, a.faces.PersonFaces(r.PathValue("id"), limit))
	})
	// Why an event did or didn't give faces: looks again step by step, keeping nothing.
	mux.HandleFunc("GET /api/faces/explain/{cam}/{id}", func(w http.ResponseWriter, r *http.Request) {
		e, ok := a.events.Get(r.PathValue("cam"), r.PathValue("id"))
		if !ok {
			writeErr(w, 404, "no such event")
			return
		}
		var steps []string
		found, err := a.faces.look(r.Context(), e, true, func(format string, args ...any) { steps = append(steps, fmt.Sprintf(format, args...)) })
		faces := 0
		for _, s := range found {
			if s.emb != nil {
				faces++
			}
		}
		errText := ""
		if err != nil {
			errText = err.Error()
		}
		writeJSON(w, 200, map[string]any{"people": len(found), "faces": faces, "steps": steps, "error": errText})
	})
	mux.HandleFunc("GET /api/faces/unknown", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 {
			limit = 40
		}
		writeJSON(w, 200, a.faces.Unknown(limit))
	})
	// {faces: [ids], person: id} or {faces, name}: these faces are that person.
	mux.HandleFunc("POST /api/faces/name", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Faces  []string `json:"faces"`
			Person string   `json:"person"`
			Name   string   `json:"name"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.Faces) == 0 {
			writeErr(w, 400, "bad request")
			return
		}
		p, err := a.faces.Name(req.Faces, req.Person, req.Name)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, p)
	})
	mux.HandleFunc("POST /api/faces/not", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Faces  []string `json:"faces"`
			Person string   `json:"person"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.Faces) == 0 || req.Person == "" {
			writeErr(w, 400, "bad request")
			return
		}
		a.faces.NotPerson(req.Faces, req.Person)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/faces/junk", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Faces []string `json:"faces"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.Faces) == 0 {
			writeErr(w, 400, "bad request")
			return
		}
		a.faces.Junk(req.Faces)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/faces/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSuffix(r.PathValue("id"), ".jpg")
		s, ok := a.faces.Face(id)
		if !ok || !camAllowed(r, s.Cam) {
			writeErr(w, 404, "no such face")
			return
		}
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeFile(w, r, a.faces.imgPath(id))
	})
	mux.HandleFunc("GET /api/summary", a.handleSummary)
	mux.HandleFunc("GET /api/preview/{cam}/{ts}", a.handlePreview)
	mux.HandleFunc("GET /api/cameras/{id}/latest.jpg", func(w http.ResponseWriter, r *http.Request) {
		img := a.previews.Latest(r.PathValue("id"))
		if img == nil {
			// No motion detection on this camera, so no frames of our own: ask it for one.
			var err error
			if img, err = a.frame(r.Context(), r.PathValue("id")+"_sub", time.Minute); err != nil {
				writeErr(w, 404, "no frame yet")
				return
			}
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(img)
	})
	mux.HandleFunc("GET /api/vod.m3u8", a.handleVOD)
	mux.HandleFunc("GET /api/seg/{cam}/{id}", a.handleSegment)
	mux.HandleFunc("GET /api/clips", func(w http.ResponseWriter, r *http.Request) {
		out := []Clip{}
		for _, c := range a.clips.List() {
			if !c.Auto && camAllowed(r, c.Camera) {
				out = append(out, c)
			}
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("GET /api/cameras/{id}/motion-grid", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		m := a.motion[r.PathValue("id")]
		a.mu.Unlock()
		if m == nil {
			writeErr(w, 404, "motion detection is off for this camera")
			return
		}
		writeJSON(w, 200, map[string]any{"w": motionW, "h": motionH, "grid": m.Grid()})
	})
	mux.HandleFunc("POST /api/clips", a.handleCreateClip)
	mux.HandleFunc("PATCH /api/clips/{id}", a.handlePatchClip)
	mux.HandleFunc("DELETE /api/clips/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !a.clips.Delete(r.PathValue("id")) {
			writeErr(w, 409, "clip is still being saved")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/clips/{id}/video", a.handleClipVideo)
	mux.HandleFunc("GET /api/clips/{id}/thumb.jpg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, max-age=3600")
		http.ServeFile(w, r, a.clips.thumbPath(filepath.Base(r.PathValue("id"))))
	})
	mux.HandleFunc("POST /api/clips/{id}/backup", func(w http.ResponseWriter, r *http.Request) {
		if !a.drive.Connected() {
			writeErr(w, 409, "connect Google Drive in Settings first")
			return
		}
		if _, ok := a.clips.Get(r.PathValue("id")); !ok {
			writeErr(w, 404, "clip not found")
			return
		}
		a.drive.Queue(r.PathValue("id"))
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/alerts", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.alerts.List()) })
	// The full picture of an alert moment (for the app's notifications), from the recording.
	mux.HandleFunc("GET /api/alerts/picture", func(w http.ResponseWriter, r *http.Request) {
		cam := r.URL.Query().Get("camera")
		if !idRe.MatchString(cam) {
			writeErr(w, 400, "bad camera id")
			return
		}
		img, err := a.alerts.picture(cam, msParam(r, "t", time.Now()))
		if err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Write(img)
	})
	mux.HandleFunc("POST /api/alerts/test", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Camera string `json:"camera"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
		if err := a.alerts.Test(req.Camera); err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/whatsapp", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"token_set": a.secrets.Get().WhatsAppToken != ""}
		if out["token_set"] == true {
			chats, err := a.alerts.wa.Chats()
			if err != nil {
				out["error"] = err.Error()
			} else {
				out["chats"] = chats
			}
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("PUT /api/whatsapp/token", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
			writeErr(w, 400, "bad request")
			return
		}
		_ = a.secrets.Update(func(s *Secrets) { s.WhatsAppToken = strings.TrimSpace(req.Token) })
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/drive", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.drive.Status()) })
	mux.HandleFunc("POST /api/drive/connect", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
		auth, err := a.drive.StartAuth(req.ClientID, req.ClientSecret)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, auth)
	})
	mux.HandleFunc("POST /api/drive/disconnect", func(w http.ResponseWriter, r *http.Request) {
		a.drive.Disconnect()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/incidents", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if n <= 0 {
			n = 100
		}
		writeJSON(w, 200, a.incidents.List(min(n, 1000)))
	})
	mux.HandleFunc("POST /api/cameras/{id}/restart", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		rec := a.recorders[r.PathValue("id")]
		a.mu.Unlock()
		if rec == nil {
			writeErr(w, 404, "camera is not recording")
			return
		}
		rec.Restart()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("DELETE /api/recordings/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		for _, c := range a.settings.Get().Cameras {
			if c.ID == id {
				writeErr(w, 409, "remove the camera first")
				return
			}
		}
		a.store.DeleteCamera(id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	if a.remote != nil {
		a.remote.panelRoutes(mux)
	}
	mux.Handle("/go2rtc/", a.go2rtc.Proxy())

	// The single-page app; hashed assets can be cached forever.
	files := http.FileServer(http.Dir(www))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(www, filepath.Clean(r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(www, "index.html"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		files.ServeHTTP(w, r)
	})
	return compress(mux)
}

type CameraStatus struct {
	Camera
	Recorder  *RecStatus    `json:"recorder"`
	Motion    *MotionStatus `json:"motion"`
	Storage   CamStorage    `json:"storage"`
	LastEvent *Event        `json:"last_event"`
}

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	s := a.settings.Get()
	stats := a.store.Stats()
	var cams []CameraStatus
	a.mu.Lock()
	for _, c := range s.Cameras {
		if !camAllowed(r, c.ID) {
			continue
		}
		cs := CameraStatus{Camera: c, Storage: stats[c.ID], LastEvent: a.events.Last(c.ID)}
		cs.MainURL, cs.SubURL = redact(c.MainURL), redact(c.SubURL)
		if rec := a.recorders[c.ID]; rec != nil {
			st := rec.Status()
			cs.Recorder = &st
		}
		if m := a.motion[c.ID]; m != nil {
			st := m.Status()
			cs.Motion = &st
		}
		cams = append(cams, cs)
	}
	a.mu.Unlock()
	if cams == nil {
		cams = []CameraStatus{}
	}
	var used, rate int64
	var orphans []map[string]any
	for cam, st := range stats {
		used += st.Bytes
		rate += st.RateBph
		known := false
		for _, c := range s.Cameras {
			known = known || c.ID == cam
		}
		if !known && st.Count > 0 {
			orphans = append(orphans, map[string]any{"id": cam, "bytes": st.Bytes, "count": st.Count})
		}
	}
	du := diskUsage(a.store.root)
	// How many days of footage the disk could hold at the current rate.
	capacityDays := 0.0
	if rate > 0 {
		usable := float64(du.Free) + float64(used) - s.MinFreeGB*1e9
		capacityDays = math.Max(0, usable/float64(rate)/24)
	}
	writeJSON(w, 200, map[string]any{
		"version":   version,
		"uptime_ms": time.Since(a.started).Milliseconds(),
		"now":       a.clock.Now().UnixMilli(),
		"cameras":   cams,
		"storage": map[string]any{
			"disk": du, "used": used, "rate_bph": rate, "capacity_days": capacityDays,
			"min_free_gb": s.MinFreeGB, "orphans": orphans, "breakdown": a.breakdown.Load(), "clips": a.clips.Bytes(),
		},
		"alerts":    map[string]any{"enabled": s.NightAlerts.Enabled && s.WhatsApp.To != "", "active": a.alerts.Active() && s.WhatsApp.To != ""},
		"drive":     map[string]any{"connected": a.drive.Connected(), "mode": s.Drive.Mode},
		"clock":     a.clock.Status(),
		"live":      a.go2rtc.running.Load(),
		"detection": a.labeler.Status(),
		"mqtt":      map[string]any{"connected": a.mqtt.Connected(), "error": a.mqtt.Error()},
		"health":    a.Healthy(),
	})
}

func (a *App) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var s Settings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&s); err != nil {
		writeErr(w, 400, "invalid settings: "+err.Error())
		return
	}
	// The UI shows redacted URLs for unchanged cameras; keep the stored credentials then.
	old := a.settings.Get()
	for i := range s.Cameras {
		for _, o := range old.Cameras {
			if o.ID != s.Cameras[i].ID {
				continue
			}
			if s.Cameras[i].MainURL == redact(o.MainURL) {
				s.Cameras[i].MainURL = o.MainURL
			}
			if s.Cameras[i].SubURL == redact(o.SubURL) {
				s.Cameras[i].SubURL = o.SubURL
			}
		}
	}
	if err := a.settings.Set(s); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	saved := a.settings.Get()
	a.Apply(saved)
	a.incidents.Add("info", "", "Settings saved")
	writeJSON(w, 200, saved)
}

func (a *App) handleTestStream(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		Camera string `json:"camera"`
		Field  string `json:"field"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	url := req.URL
	// Allow testing a saved camera whose URL the UI only has in redacted form.
	for _, c := range a.settings.Get().Cameras {
		if c.ID == req.Camera {
			if req.Field == "sub_url" && url == redact(c.SubURL) {
				url = c.SubURL
			} else if url == redact(c.MainURL) {
				url = c.MainURL
			}
		}
	}
	if !validStreamURL(url) {
		writeErr(w, 400, "enter an rtsp:// URL")
		return
	}
	info, err := probeStream(r.Context(), url)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "info": info})
}

var snapCache sync.Map // cam -> snapEntry

type snapEntry struct {
	at  time.Time
	img []byte
}

func (a *App) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	src := id + "_sub"
	if r.URL.Query().Get("hq") == "1" {
		src = id
	}
	img, err := a.frame(r.Context(), src, 10*time.Second)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(img)
}

var (
	frameMu      sync.Mutex
	frameFetches = map[string]chan struct{}{}
)

// frame returns a picture from the camera, reusing one up to maxAge old. Viewers asking
// at the same time share one grab (each takes a second or two); if the camera can't
// give one, the last picture is better than nothing.
func (a *App) frame(ctx context.Context, src string, maxAge time.Duration) ([]byte, error) {
	for {
		if v, ok := snapCache.Load(src); ok && time.Since(v.(snapEntry).at) < maxAge {
			return v.(snapEntry).img, nil
		}
		frameMu.Lock()
		if ch, ok := frameFetches[src]; ok {
			frameMu.Unlock()
			select {
			case <-ch:
				maxAge = time.Minute // take what that grab got
				if _, ok := snapCache.Load(src); !ok {
					return nil, errors.New("no picture from the camera")
				}
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ch := make(chan struct{})
		frameFetches[src] = ch
		frameMu.Unlock()
		fctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		img, err := a.go2rtc.Frame(fctx, src)
		cancel()
		if err == nil {
			snapCache.Store(src, snapEntry{time.Now(), img})
		}
		frameMu.Lock()
		delete(frameFetches, src)
		close(ch)
		frameMu.Unlock()
		if err != nil {
			if v, ok := snapCache.Load(src); ok {
				return v.(snapEntry).img, nil
			}
			return nil, err
		}
		return img, nil
	}
}

func (a *App) handleCoverage(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := msParam(r, "from", now.Add(-24*time.Hour))
	to := msParam(r, "to", now.Add(time.Hour))
	writeJSON(w, 200, a.store.Coverage(r.PathValue("id"), from, to))
}

func (a *App) handleActivity(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := msParam(r, "from", now.Add(-24*time.Hour))
	to := msParam(r, "to", now)
	step, _ := strconv.Atoi(r.URL.Query().Get("step"))
	writeJSON(w, 200, a.activity.Range(r.PathValue("id"), from, to, time.Duration(step)*time.Second))
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := msParam(r, "from", now.Add(-7*24*time.Hour))
	to := msParam(r, "to", now.Add(time.Hour))
	var cams []string
	if c := r.URL.Query().Get("cameras"); c != "" {
		cams = strings.Split(c, ",")
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 500
	}
	cams, ok := a.visibleCams(r, cams)
	if !ok {
		writeJSON(w, 200, []Event{})
		return
	}
	// labels=person,cat: events with any of these; motion=1: plain motion only;
	// person=<id>: events with that person (recognised).
	var keep func(*Event) bool
	if p := r.URL.Query().Get("person"); p != "" {
		q := SearchQuery{People: []string{p}, DayFrom: -1}
		keep = q.Match
	} else if l := r.URL.Query().Get("labels"); l != "" {
		q := SearchQuery{Labels: strings.Split(l, ","), DayFrom: -1}
		keep = q.Match
	} else if r.URL.Query().Get("motion") == "1" {
		q := SearchQuery{Motion: true, DayFrom: -1}
		keep = q.Match
	}
	writeJSON(w, 200, a.events.Filter(cams, from.UnixMilli(), to.UnixMilli(), limit, keep))
}

// visibleCams narrows a camera list to what the request may see (app users can be
// limited to some cameras). ok is false when nothing is left.
func (a *App) visibleCams(r *http.Request, cams []string) ([]string, bool) {
	u := appUser(r)
	if u == nil {
		return cams, true
	}
	if len(cams) == 0 {
		for _, c := range a.settings.Get().Cameras {
			cams = append(cams, c.ID)
		}
	}
	cams = slices.DeleteFunc(slices.Clone(cams), func(c string) bool { return !u.CanSee(c) })
	return cams, len(cams) > 0
}

func (a *App) handleSnap(w http.ResponseWriter, r *http.Request) {
	cam, id := r.PathValue("cam"), r.PathValue("id")
	if strings.ContainsAny(cam+id, "/\\") || strings.Contains(cam+id, "..") || !camAllowed(r, cam) {
		writeErr(w, 400, "bad id")
		return
	}
	servePicture(w, r, a.events.SnapPath(cam, id))
}

func (a *App) handleSearch(w http.ResponseWriter, r *http.Request) {
	s := a.settings.Get()
	q := ParseSearch(r.URL.Query().Get("q"), time.Now(), s.Cameras, a.faces.People())
	cams, ok := a.visibleCams(r, q.Cameras)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 300
	}
	events := []Event{}
	if ok {
		events = a.events.Filter(cams, q.From, q.To, limit, q.Match)
	}
	writeJSON(w, 200, map[string]any{"query": q, "events": events})
}

func (a *App) handleSummary(w http.ResponseWriter, r *http.Request) {
	d := time.Now()
	if v := r.URL.Query().Get("date"); v != "" {
		t, err := time.ParseInLocation("2006-01-02", v, time.Local)
		if err != nil {
			writeErr(w, 400, "date must be YYYY-MM-DD")
			return
		}
		d = t
	}
	var allowed func(string) bool
	if u := appUser(r); u != nil {
		allowed = u.CanSee
	}
	writeJSON(w, 200, a.Summary(d, allowed))
}

func (a *App) handleThumb(w http.ResponseWriter, r *http.Request) {
	cam, id := r.PathValue("cam"), r.PathValue("id")
	if strings.ContainsAny(cam+id, "/\\") || strings.Contains(cam+id, "..") {
		writeErr(w, 400, "bad id")
		return
	}
	servePicture(w, r, a.events.ThumbPath(cam, id))
}

// handleVOD builds an HLS playlist over the recordings in [from, to): every file becomes
// a discontinuity with its own init section, and every fragment a byte-range segment.
// Wall-clock time is carried in EXT-X-PROGRAM-DATE-TIME so the player can map position to time.
func (a *App) handleVOD(w http.ResponseWriter, r *http.Request) {
	cam := r.URL.Query().Get("camera")
	if !idRe.MatchString(cam) {
		writeErr(w, 400, "bad camera id")
		return
	}
	now := time.Now()
	from := msParam(r, "from", now.Add(-time.Hour))
	to := msParam(r, "to", from.Add(time.Hour))
	if to.Sub(from) > 6*time.Hour {
		to = from.Add(6 * time.Hour)
	}
	segs := a.store.Range(cam, from, to)
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	var body strings.Builder
	target := 1.0
	count := 0
	for i := range segs {
		s := &segs[i]
		idx, err := a.store.Index(s)
		if err != nil || len(idx.Fragments) == 0 {
			continue
		}
		uri := fmt.Sprintf("seg/%s/%s", cam, s.ID)
		if count > 0 {
			body.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		fmt.Fprintf(&body, "#EXT-X-MAP:URI=\"%s\",BYTERANGE=\"%d@0\"\n", uri, idx.InitLength)
		first := true
		for _, f := range idx.Fragments {
			fs := s.Start().Add(time.Duration(f.Start * float64(time.Second)))
			fe := fs.Add(time.Duration(f.Duration * float64(time.Second)))
			if !fe.After(from) || !fs.Before(to) {
				continue
			}
			if first {
				fmt.Fprintf(&body, "#EXT-X-PROGRAM-DATE-TIME:%s\n", fs.UTC().Format("2006-01-02T15:04:05.000Z"))
				first = false
			}
			fmt.Fprintf(&body, "#EXTINF:%.3f,\n#EXT-X-BYTERANGE:%d@%d\n%s\n", f.Duration, f.Length, f.Offset, uri)
			target = math.Max(target, f.Duration)
			count++
		}
	}
	fmt.Fprintf(&b, "#EXT-X-TARGETDURATION:%d\n", int(math.Ceil(target)))
	b.WriteString(body.String())
	b.WriteString("#EXT-X-ENDLIST\n")
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(b.String()))
}

func (a *App) handleSegment(w http.ResponseWriter, r *http.Request) {
	p := a.store.Path(r.PathValue("cam"), r.PathValue("id"))
	if p == "" {
		writeErr(w, 404, "recording not found (it may have been removed by retention)")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeErr(w, 404, "recording not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeErr(w, 404, "recording not found")
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// handlePreview serves the preview frame nearest to a time (unix ms) for timeline scrubbing.
func (a *App) handlePreview(w http.ResponseWriter, r *http.Request) {
	ts, err := strconv.ParseInt(strings.TrimSuffix(r.PathValue("ts"), ".jpg"), 10, 64)
	if err != nil {
		writeErr(w, 400, "bad time")
		return
	}
	cam := r.PathValue("cam")
	img, at, ok := a.previews.Get(cam, time.UnixMilli(ts))
	if !ok {
		// No stored preview (footage from before previews existed): take the nearest
		// keyframe from the recording itself.
		img, ok = a.frameFromRecording(r.Context(), cam, time.UnixMilli(ts))
		at = ts
	}
	if !ok {
		writeErr(w, 404, "no preview")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Frame-Time", strconv.FormatInt(at, 10))
	if time.Since(time.UnixMilli(ts)) > time.Minute {
		w.Header().Set("Cache-Control", "private, max-age=86400")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.Write(img)
}

var (
	extractSem   = make(chan struct{}, 2) // at most 2 ffmpeg extractions at once
	extractCache sync.Map                 // cam/2s-bucket -> []byte
	extractCount atomic.Int64
)

func (a *App) frameFromRecording(ctx context.Context, cam string, t time.Time) ([]byte, bool) {
	key := fmt.Sprintf("%s/%d", cam, t.UnixMilli()/2000)
	if v, ok := extractCache.Load(key); ok {
		b := v.([]byte)
		return b, b != nil
	}
	out, err := a.decodeFrame(ctx, cam, t, "scale=320:-2", 7, false)
	if err != nil {
		return nil, false
	}
	if extractCount.Add(1)%2000 == 0 {
		extractCache.Clear()
	}
	extractCache.Store(key, out)
	return out, true
}

var errNoFrame = errors.New("no recording at that moment yet")

type priorityKey struct{}

var lowPriorityKey = priorityKey{}

// lowPriority marks work (e.g. frame decoding for object detection) that should yield
// to recording and live viewers.
func lowPriority(ctx context.Context) context.Context {
	return context.WithValue(ctx, lowPriorityKey, true)
}

// fragmentAt returns the init section plus the fragment of the recording containing t
// (each fragment starts with a keyframe), and how far into that fragment t is. With
// exact, the fragment must already contain t (it may not be on disk yet).
func (a *App) fragmentAt(cam string, t time.Time, exact bool) ([]byte, float64, error) {
	segs := a.store.Range(cam, t, t.Add(time.Millisecond))
	if len(segs) == 0 {
		return nil, 0, errNoFrame
	}
	s := segs[0]
	p := a.store.Path(cam, s.ID)
	if p == "" {
		return nil, 0, errNoFrame
	}
	idx, err := a.store.Index(&s)
	if err != nil || len(idx.Fragments) == 0 {
		return nil, 0, errNoFrame
	}
	off := t.Sub(s.Start()).Seconds()
	frag := idx.Fragments[0]
	for _, f := range idx.Fragments {
		if f.Start <= off {
			frag = f
		}
	}
	if exact && off > frag.Start+frag.Duration {
		return nil, 0, errNoFrame
	}
	file, err := os.Open(p)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	data := make([]byte, idx.InitLength+frag.Length)
	if _, err := file.ReadAt(data[:idx.InitLength], 0); err != nil {
		return nil, 0, err
	}
	if _, err := file.ReadAt(data[idx.InitLength:], frag.Offset); err != nil {
		return nil, 0, err
	}
	return data, max(0, off-frag.Start), nil
}

func (a *App) runDecode(ctx context.Context, cam string, t time.Time, exact bool, out []string) ([]byte, error) {
	data, into, err := a.fragmentAt(cam, t, exact)
	if err != nil {
		return nil, err
	}
	select {
	case extractSem <- struct{}{}:
		defer func() { <-extractSem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	args := []string{"-v", "error", "-i", "pipe:0"}
	if exact && into > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", into))
	}
	args = append(append(args, "-frames:v", "1"), out...)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	if ctx.Value(lowPriorityKey) != nil { // background work: recording and viewers first
		cmd = exec.CommandContext(ctx, "nice", append([]string{"-n", "10", "ffmpeg"}, args...)...)
	}
	cmd.Stdin = bytes.NewReader(data)
	b, err := cmd.Output()
	if err != nil || len(b) < 100 {
		return nil, fmt.Errorf("could not decode a frame: %v", err)
	}
	return b, nil
}

// decodeFrame decodes the frame at t (exact) or the fragment's keyframe as a JPEG.
func (a *App) decodeFrame(ctx context.Context, cam string, t time.Time, vf string, q int, exact bool) ([]byte, error) {
	return a.runDecode(ctx, cam, t, exact, []string{"-vf", vf, "-q:v", strconv.Itoa(q), "-f", "image2", "-c:v", "mjpeg", "pipe:1"})
}

// decodeGray decodes the frame at t as a small w×h greyscale image, for comparing frames.
func (a *App) decodeGray(ctx context.Context, cam string, t time.Time, w, h int) ([]byte, error) {
	b, err := a.runDecode(ctx, cam, t, true, []string{"-vf", fmt.Sprintf("scale=%d:%d:flags=area,format=gray", w, h), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"})
	if err == nil && len(b) != w*h {
		return nil, errNoFrame
	}
	return b, err
}

func (a *App) handleCreateClip(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Camera string `json:"camera"`
		From   int64  `json:"from"`
		To     int64  `json:"to"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	var cam *Camera
	for _, c := range a.settings.Get().Cameras {
		if c.ID == req.Camera {
			cam = &c
			break
		}
	}
	if cam == nil {
		cam = &Camera{ID: req.Camera, Name: req.Camera}
	}
	clip, err := a.clips.Create(*cam, time.UnixMilli(req.From), time.UnixMilli(req.To), req.Name)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, clip)
}

func (a *App) handlePatchClip(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   *string `json:"name"`
		Pinned *bool   `json:"pinned"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	c, ok := a.clips.Patch(r.PathValue("id"), req.Name, req.Pinned)
	if !ok {
		writeErr(w, 404, "clip not found")
		return
	}
	writeJSON(w, 200, c)
}

// handleClipVideo streams a saved clip (seekable); ?download=1 makes the browser save it.
func (a *App) handleClipVideo(w http.ResponseWriter, r *http.Request) {
	c, ok := a.clips.Get(r.PathValue("id"))
	if !ok || c.Status != "ready" {
		writeErr(w, 404, "clip not ready")
		return
	}
	f, err := os.Open(a.clips.videoPath(&c))
	if err != nil {
		writeErr(w, 404, "clip file missing")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeErr(w, 404, "clip file missing")
		return
	}
	name := safeFileName(c.Name) + ".mp4"
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	}
	w.Header().Set("Content-Type", "video/mp4")
	http.ServeContent(w, r, name, st.ModTime(), f)
}
