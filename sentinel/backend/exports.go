package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Clips: a time range of one camera saved as a standalone MP4 in /media/sentinel/exports
// (so it also shows in Home Assistant's Media browser). Saving runs in the background with
// progress; clips are kept for Settings.ExportRetentionDays unless pinned.

type Clip struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Camera     string  `json:"camera"`
	CameraName string  `json:"camera_name"`
	From       int64   `json:"from"` // unix ms
	To         int64   `json:"to"`
	Created    int64   `json:"created"`
	Status     string  `json:"status"` // queued | saving | ready | failed
	Progress   float64 `json:"progress"`
	Error      string  `json:"error,omitempty"`
	Size       int64   `json:"size"`
	Pinned     bool    `json:"pinned"`
	// File name in the exports folder, e.g. "Roof front gate_1a2b3c4d.mp4".
	File string `json:"file"`
	// Saved automatically for a night alert.
	Alert bool `json:"alert,omitempty"`
	// Made only to upload a motion event to Google Drive: hidden from the Clips page and
	// removed once uploaded (the recording itself stays on disk as usual).
	Auto bool `json:"auto,omitempty"`
	// Google Drive copy, if any.
	Backup *ClipBackup `json:"backup,omitempty"`
}

type ClipBackup struct {
	State    string  `json:"state"` // pending | uploading | done | failed
	Progress float64 `json:"progress"`
	FileID   string  `json:"file_id,omitempty"`
	Error    string  `json:"error,omitempty"`
	At       int64   `json:"at"`
	Tries    int     `json:"tries"`
}

type ClipStore struct {
	mu    sync.Mutex
	dir   string
	clips map[string]*Clip
	queue chan string
	app   *App
}

func newClipStore(dir string, app *App) *ClipStore {
	cs := &ClipStore{dir: dir, clips: map[string]*Clip{}, queue: make(chan string, 100), app: app}
	_ = os.MkdirAll(cs.metaDir(), 0o755)
	files, _ := filepath.Glob(filepath.Join(cs.metaDir(), "*.json"))
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var c Clip
		if json.Unmarshal(data, &c) != nil || c.ID == "" {
			continue
		}
		if c.Status != "ready" {
			// Interrupted by a restart or power cut.
			c.Status, c.Error, c.Progress = "failed", "interrupted by a restart — save it again", 0
			_ = os.Remove(cs.partPath(c.ID))
		}
		if c.Backup != nil && c.Backup.State == "uploading" {
			c.Backup.State = "pending" // start the upload over
		}
		cs.clips[c.ID] = &c
		cs.persist(&c)
	}
	// Any file that isn't part of a known clip is leftover from a crash.
	known := map[string]bool{}
	for _, c := range cs.clips {
		known[filepath.Base(cs.videoPath(c))] = true
	}
	top, _ := os.ReadDir(dir)
	for _, e := range top {
		if !e.IsDir() && !known[e.Name()] {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	meta, _ := os.ReadDir(cs.metaDir())
	for _, e := range meta {
		if _, ok := cs.clips[strings.SplitN(e.Name(), ".", 2)[0]]; !ok {
			_ = os.Remove(filepath.Join(cs.metaDir(), e.Name()))
		}
	}
	return cs
}

func (cs *ClipStore) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-cs.queue:
			cs.render(ctx, id)
		}
	}
}

func (cs *ClipStore) videoPath(c *Clip) string {
	if c.File != "" {
		return filepath.Join(cs.dir, c.File)
	}
	return filepath.Join(cs.dir, c.ID+".mp4")
}

func clipFileName(name, id string) string        { return safeFileName(name) + "_" + id + ".mp4" }
func (cs *ClipStore) partPath(id string) string  { return filepath.Join(cs.metaDir(), id+".part.mp4") }
func (cs *ClipStore) thumbPath(id string) string { return filepath.Join(cs.metaDir(), id+".jpg") }

// Thumbnails and metadata live in a hidden folder so Home Assistant's Media panel only
// shows the clips themselves.
func (cs *ClipStore) metaDir() string { return filepath.Join(cs.dir, ".meta") }

func (cs *ClipStore) persist(c *Clip) {
	data, _ := json.MarshalIndent(c, "", "  ")
	_ = writeFileAtomic(filepath.Join(cs.metaDir(), c.ID+".json"), data, 0o644)
}

func (cs *ClipStore) update(id string, f func(c *Clip)) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if c := cs.clips[id]; c != nil {
		f(c)
		cs.persist(c)
	}
}

func (cs *ClipStore) Create(cam Camera, from, to time.Time, name string) (*Clip, error) {
	return cs.create(cam, from, to, name, false, false)
}

func (cs *ClipStore) create(cam Camera, from, to time.Time, name string, alert, auto bool) (*Clip, error) {
	if !to.After(from) {
		return nil, errors.New("the end must be after the start")
	}
	if to.Sub(from) > 3*time.Hour {
		return nil, errors.New("clips are limited to 3 hours")
	}
	if len(cs.app.store.Range(cam.ID, from, to)) == 0 {
		return nil, errors.New("there is no recording in that range")
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	name = strings.TrimSpace(name)
	if name == "" {
		name = fmt.Sprintf("%s · %s", cam.Name, from.In(time.Local).Format("Jan 2, 15:04:05"))
	}
	c := &Clip{ID: hex.EncodeToString(b), Name: name, Camera: cam.ID, CameraName: cam.Name, From: from.UnixMilli(), To: to.UnixMilli(), Created: time.Now().UnixMilli(), Status: "queued", Alert: alert, Auto: auto}
	c.File = clipFileName(name, c.ID)
	cs.mu.Lock()
	cs.clips[c.ID] = c
	cs.persist(c)
	cs.mu.Unlock()
	select {
	case cs.queue <- c.ID:
	default:
		cs.update(c.ID, func(c *Clip) { c.Status, c.Error = "failed", "too many clips queued" })
	}
	cp := *c
	return &cp, nil
}

var outTimeRe = regexp.MustCompile(`^out_time_(?:us|ms)=(\d+)`)

func (cs *ClipStore) render(ctx context.Context, id string) {
	cs.mu.Lock()
	c := cs.clips[id]
	if c == nil {
		cs.mu.Unlock()
		return
	}
	job := *c
	cs.mu.Unlock()
	fail := func(msg string) {
		_ = os.Remove(cs.partPath(id))
		cs.update(id, func(c *Clip) { c.Status, c.Error, c.Progress = "failed", msg, 0 })
		cs.app.incidents.Add("warn", job.Camera, "Clip %q failed: %s", job.Name, msg)
	}
	from, to := time.UnixMilli(job.From), time.UnixMilli(job.To)
	segs := cs.app.store.Range(job.Camera, from, to)
	if len(segs) == 0 {
		fail("the recordings for this range were removed")
		return
	}
	cs.update(id, func(c *Clip) { c.Status = "saving" })

	// Concatenate the 1-minute files without re-encoding, trimmed to the range.
	var list strings.Builder
	for _, s := range segs {
		p := cs.app.store.Path(job.Camera, s.ID)
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
	listPath := filepath.Join(cs.metaDir(), id+".list")
	defer os.Remove(listPath)
	if err := os.WriteFile(listPath, []byte(list.String()), 0o600); err != nil {
		fail(err.Error())
		return
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", listPath,
		"-map", "0:v", "-map", "0:a?", "-c", "copy"}
	cs.app.mu.Lock()
	if rec := cs.app.recorders[job.Camera]; rec != nil && rec.Status().Stream.VideoCodec == "hevc" {
		args = append(args, "-tag:v", "hvc1")
	}
	cs.app.mu.Unlock()
	args = append(args, "-movflags", "+faststart", "-progress", "pipe:1", "-y", cs.partPath(id))
	cctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "ffmpeg", args...)
	stdout, _ := cmd.StdoutPipe()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		fail(err.Error())
		return
	}
	total := float64(job.To-job.From) * 1000 // µs
	sc := bufio.NewScanner(stdout)
	lastPct := 0.0
	for sc.Scan() {
		if m := outTimeRe.FindStringSubmatch(sc.Text()); m != nil {
			us, _ := strconv.ParseFloat(m[1], 64)
			pct := min(99, us/total*100)
			if pct-lastPct >= 2 {
				lastPct = pct
				cs.update(id, func(c *Clip) { c.Progress = pct })
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		fail(redact(msg))
		return
	}
	if err := os.Rename(cs.partPath(id), cs.videoPath(&job)); err != nil {
		fail(err.Error())
		return
	}
	// Thumbnail from the middle of the clip.
	mid := fmt.Sprintf("%.2f", float64(job.To-job.From)/2000)
	_ = exec.CommandContext(cctx, "ffmpeg", "-v", "error", "-ss", mid, "-i", cs.videoPath(&job), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", "-y", cs.thumbPath(id)).Run()
	st, _ := os.Stat(cs.videoPath(&job))
	cs.update(id, func(c *Clip) {
		c.Status, c.Progress, c.Error = "ready", 100, ""
		if st != nil {
			c.Size = st.Size()
		}
	})
	if !job.Auto {
		cs.app.incidents.Add("info", job.Camera, "Clip saved: %s", job.Name)
	}
	cs.app.drive.ClipReady(id)
}

func (cs *ClipStore) List() []Clip {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	out := make([]Clip, 0, len(cs.clips))
	for _, c := range cs.clips {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out
}

func (cs *ClipStore) Get(id string) (Clip, bool) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c, ok := cs.clips[id]
	if !ok {
		return Clip{}, false
	}
	return *c, true
}

func (cs *ClipStore) Patch(id string, name *string, pinned *bool) (Clip, bool) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c, ok := cs.clips[id]
	if !ok {
		return Clip{}, false
	}
	if name != nil && strings.TrimSpace(*name) != "" {
		c.Name = strings.TrimSpace(*name)
		if r := []rune(c.Name); len(r) > 120 {
			c.Name = string(r[:120])
		}
		if c.Status == "ready" {
			newFile := clipFileName(c.Name, c.ID)
			if err := os.Rename(cs.videoPath(c), filepath.Join(cs.dir, newFile)); err == nil {
				c.File = newFile
			}
		}
	}
	if pinned != nil {
		c.Pinned = *pinned
	}
	cs.persist(c)
	return *c, true
}

func (cs *ClipStore) Delete(id string) bool {
	cs.mu.Lock()
	c, ok := cs.clips[id]
	if ok && (c.Status == "saving" || c.Status == "queued") {
		cs.mu.Unlock()
		return false
	}
	delete(cs.clips, id)
	cs.mu.Unlock()
	if !ok {
		return false
	}
	for _, p := range []string{cs.videoPath(c), cs.thumbPath(id), cs.partPath(id), filepath.Join(cs.metaDir(), id+".json")} {
		_ = os.Remove(p)
	}
	return ok
}

// Cleanup removes unpinned clips older than `days` (0 = keep forever), and motion-backup
// clips that still haven't uploaded after 2 days (the recording is still on disk).
func (cs *ClipStore) Cleanup(days int) {
	cut := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	autoCut := time.Now().Add(-48 * time.Hour).UnixMilli()
	for _, c := range cs.List() {
		if c.Status == "saving" || c.Status == "queued" || c.Backup != nil && c.Backup.State == "uploading" {
			continue
		}
		if c.Auto && (c.Created < autoCut || c.Status == "failed") || !c.Auto && days > 0 && !c.Pinned && c.Created < cut {
			cs.Delete(c.ID)
		}
	}
}

// SetBackup changes a clip's Drive backup state (nil f result removes it).
func (cs *ClipStore) SetBackup(id string, f func(b *ClipBackup)) {
	cs.update(id, func(c *Clip) {
		if c.Backup == nil {
			c.Backup = &ClipBackup{}
		}
		f(c.Backup)
	})
}

func (cs *ClipStore) Bytes() int64 {
	var n int64
	for _, c := range cs.List() {
		if c.Auto {
			continue
		}
		n += c.Size
	}
	return n
}

func safeFileName(s string) string {
	s = regexp.MustCompile(`[^\w\-. ]+`).ReplaceAllString(s, "_")
	s = strings.TrimSpace(s)
	if s == "" {
		s = "clip"
	}
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}
