package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
	mux.HandleFunc("GET /api/vod.m3u8", a.handleVOD)
	mux.HandleFunc("GET /api/seg/{cam}/{id}", a.handleSegment)
	mux.HandleFunc("GET /api/export/{id}", a.handleExport)
	mux.HandleFunc("GET /api/incidents", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		writeJSON(w, 200, a.incidents.List(max(n, 100)))
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
	return mux
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
			"min_free_gb": s.MinFreeGB, "orphans": orphans,
		},
		"clock":  a.clock.Status(),
		"live":   a.go2rtc.running.Load(),
		"mqtt":   map[string]any{"connected": a.mqtt.Connected(), "error": a.mqtt.Error()},
		"health": a.Healthy(),
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
	key := src
	if v, ok := snapCache.Load(key); ok {
		e := v.(snapEntry)
		if time.Since(e.at) < 10*time.Second {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(e.img)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	img, err := a.go2rtc.Frame(ctx, src)
	if err != nil {
		if v, ok := snapCache.Load(key); ok { // stale is better than nothing
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write(v.(snapEntry).img)
			return
		}
		writeErr(w, 502, err.Error())
		return
	}
	snapCache.Store(key, snapEntry{time.Now(), img})
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(img)
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
	writeJSON(w, 200, a.events.List(cams, from.UnixMilli(), to.UnixMilli(), limit))
}

func (a *App) handleThumb(w http.ResponseWriter, r *http.Request) {
	cam, id := r.PathValue("cam"), r.PathValue("id")
	if strings.ContainsAny(cam+id, "/\\") || strings.Contains(cam+id, "..") {
		writeErr(w, 400, "bad id")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, a.events.ThumbPath(cam, id))
}

// handleVOD builds an HLS playlist over the recordings in [from, to): every file becomes
// a discontinuity with its own init section, and every fragment a byte-range segment.
// Wall-clock time is carried in EXT-X-PROGRAM-DATE-TIME so the player can map position to time.
func (a *App) handleVOD(w http.ResponseWriter, r *http.Request) {
	cam := r.URL.Query().Get("camera")
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
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// handleExport joins the recordings of a time range into one MP4 download (no re-encoding).
func (a *App) handleExport(w http.ResponseWriter, r *http.Request) {
	cam := r.PathValue("id")
	from := msParam(r, "from", time.Time{})
	to := msParam(r, "to", time.Time{})
	if from.IsZero() || !to.After(from) {
		writeErr(w, 400, "choose a start and end time")
		return
	}
	if to.Sub(from) > 3*time.Hour {
		writeErr(w, 400, "exports are limited to 3 hours")
		return
	}
	segs := a.store.Range(cam, from, to)
	if len(segs) == 0 {
		writeErr(w, 404, "no recordings in that range")
		return
	}
	tmp, err := os.MkdirTemp("", "export")
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer os.RemoveAll(tmp)
	var list strings.Builder
	for _, s := range segs {
		p := a.store.Path(cam, s.ID)
		if p == "" {
			continue
		}
		fmt.Fprintf(&list, "file '%s'\n", strings.ReplaceAll(p, "'", `'\''`))
		if in := from.Sub(s.Start()); in > 0 {
			fmt.Fprintf(&list, "inpoint %.3f\n", in.Seconds())
		}
		if out := to.Sub(s.Start()); out < s.End().Sub(s.Start()) {
			fmt.Fprintf(&list, "outpoint %.3f\n", out.Seconds())
		}
	}
	listPath := filepath.Join(tmp, "list.txt")
	_ = os.WriteFile(listPath, []byte(list.String()), 0o600)
	out := filepath.Join(tmp, "clip.mp4")
	args := []string{"-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v", "-map", "0:a?", "-c", "copy"}
	a.mu.Lock()
	if rec := a.recorders[cam]; rec != nil && rec.Status().Stream.VideoCodec == "hevc" {
		args = append(args, "-tag:v", "hvc1")
	}
	a.mu.Unlock()
	args = append(args, "-movflags", "+faststart", out)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	if msg, err := exec.CommandContext(ctx, "ffmpeg", args...).CombinedOutput(); err != nil {
		writeErr(w, 500, "export failed: "+strings.TrimSpace(string(msg)))
		return
	}
	f, err := os.Open(out)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	name := fmt.Sprintf("%s_%s.mp4", cam, from.In(time.Local).Format("2006-01-02_15-04-05"))
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeContent(w, r, name, st.ModTime(), f)
}
