package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Detector finds people and animals in single frames with YOLOX models, run by a Python
// worker (detect/detect.py): a fast "scan" model and a bigger "verify" model for a second
// opinion. It only ever sees the few frames of motion events that Sentinel asks about.
// The worker is a separate, low-priority process: if it crashes or hangs it is killed
// and restarted, and recording never notices.

type Detection struct {
	Label string
	Score float64
	Box   Rect // normalised to the frame
}

type Detector struct {
	script, model string
	mu            prioLock // one picture at a time; waiting users first
	cmd           *exec.Cmd
	in            io.WriteCloser
	lines         chan string
	size          int
	models        map[string]int // model name -> input size
	retryAt       time.Time      // after a failed start, don't try again before this
	// For Available, without the lock: that's held while the worker thinks (up to
	// seconds per picture, a minute while it loads), and the status every page polls
	// and night alerts ask whether detection works.
	alive   atomic.Bool
	retryMs atomic.Int64
}

func newDetector() *Detector {
	return &Detector{
		script: env("SENTINEL_DETECT_SCRIPT", "/app/detect/detect.py"),
		model:  env("SENTINEL_DETECT_MODEL", "/app/detect/yolox_s.onnx"),
	}
}

// Available reports whether detection is installed and not in a start-failure backoff.
func (d *Detector) Available() bool {
	if _, err := os.Stat(d.model); err != nil {
		return false
	}
	return d.alive.Load() || time.Now().UnixMilli() > d.retryMs.Load()
}

func (d *Detector) startLocked() error {
	if time.Now().Before(d.retryAt) {
		return errors.New("object detection is unavailable (it failed to start recently)")
	}
	// Lowest priority: Home Assistant, recording and live view always come first.
	cmd := exec.Command("nice", "-n", "19", "python3", d.script)
	cmd.Env = append(os.Environ(), "SENTINEL_DETECT_MODEL="+d.model)
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		d.retryAt = time.Now().Add(5 * time.Minute)
		d.retryMs.Store(d.retryAt.UnixMilli())
		return fmt.Errorf("object detection did not start: %v", err)
	}
	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
		_ = cmd.Wait()
	}()
	d.cmd, d.in, d.lines = cmd, in, lines
	d.alive.Store(true)
	var ready struct {
		Ready  bool           `json:"ready"`
		Size   int            `json:"size"`
		Models map[string]int `json:"models"`
	}
	line, err := d.readLocked(context.Background(), 60*time.Second) // loading the model
	if err == nil {
		err = json.Unmarshal([]byte(line), &ready)
	}
	if err != nil || !ready.Ready || ready.Size < 32 {
		d.stopLocked()
		d.retryAt = time.Now().Add(5 * time.Minute)
		d.retryMs.Store(d.retryAt.UnixMilli())
		return fmt.Errorf("object detection did not start: %v", err)
	}
	d.size, d.models = ready.Size, ready.Models
	if d.models == nil {
		d.models = map[string]int{modelScan: d.size}
	}
	logf("object detection ready (models %v)", d.models)
	return nil
}

func (d *Detector) stopLocked() {
	if d.cmd != nil && d.cmd.Process != nil {
		_ = d.cmd.Process.Kill()
	}
	if d.in != nil {
		_ = d.in.Close()
	}
	d.cmd, d.in, d.lines = nil, nil, nil
	d.alive.Store(false)
}

func (d *Detector) readLocked(ctx context.Context, timeout time.Duration) (string, error) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case line, ok := <-d.lines:
		if !ok {
			return "", errors.New("the detector stopped")
		}
		return line, nil
	case <-t.C:
		return "", errors.New("the detector did not answer in time")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

const (
	modelScan   = "scan"   // fast, looks at every frame
	modelVerify = "verify" // bigger and more accurate, confirms what scan found
	modelFaces  = "faces"  // faces and their fingerprints (see faces.go)
)

// HasModel reports whether the worker has a model (starting it if needed).
func (d *Detector) HasModel(model string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cmd == nil {
		if err := d.startLocked(); err != nil {
			return false
		}
	}
	_, ok := d.models[model]
	return ok
}

// Raw runs a model whose answer is rows of numbers (faces: see detect.py).
func (d *Detector) Raw(ctx context.Context, model string, rgb []byte, w, h int) ([][]float64, error) {
	line, err := d.ask(ctx, model, rgb, w, h)
	if err != nil {
		return nil, err
	}
	var rows [][]float64
	if err := json.Unmarshal([]byte(line), &rows); err != nil {
		d.mu.Lock()
		d.stopLocked()
		d.mu.Unlock()
		return nil, fmt.Errorf("bad detector answer: %v", err)
	}
	return rows, nil
}

// ask sends one picture to a model and returns the answer line.
func (d *Detector) ask(ctx context.Context, model string, rgb []byte, w, h int) (string, error) {
	d.mu.LockFor(ctx)
	defer d.mu.Unlock()
	if d.cmd == nil {
		if err := d.startLocked(); err != nil {
			return "", err
		}
	}
	size, ok := d.models[model]
	if !ok {
		return "", fmt.Errorf("the detector has no %s model", model)
	}
	if w > size || h > size || len(rgb) != w*h*3 {
		return "", fmt.Errorf("picture %dx%d does not fit the model", w, h)
	}
	if _, err := fmt.Fprintf(d.in, "%d %d %s\n", w, h, model); err == nil {
		_, err = d.in.Write(rgb)
	}
	// The answer is waited for even if the asker gave up (a page closed): stopping now
	// would mean restarting the worker and loading every model again.
	line, err := d.readLocked(context.Background(), 20*time.Second)
	if err != nil {
		d.stopLocked() // don't leave a half-read answer behind
		return "", err
	}
	return line, nil
}

// Size is the largest picture side a model takes (starting the worker if needed). A
// missing verify model falls back to the scan model.
func (d *Detector) Size(model string) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cmd == nil {
		if err := d.startLocked(); err != nil {
			return 0, err
		}
	}
	if n, ok := d.models[model]; ok {
		return n, nil
	}
	return d.size, nil
}

// Detect runs a model on one RGB picture (w×h, each side at most Size(model)).
func (d *Detector) Detect(ctx context.Context, model string, rgb []byte, w, h int) ([]Detection, error) {
	d.mu.LockFor(ctx)
	defer d.mu.Unlock()
	if d.cmd == nil {
		if err := d.startLocked(); err != nil {
			return nil, err
		}
	}
	size, ok := d.models[model]
	if !ok {
		model, size = modelScan, d.size
	}
	if w > size || h > size || len(rgb) != w*h*3 {
		return nil, fmt.Errorf("picture %dx%d does not fit the model", w, h)
	}
	if _, err := fmt.Fprintf(d.in, "%d %d %s\n", w, h, model); err == nil {
		_, err = d.in.Write(rgb)
	}
	// The answer is waited for even if the asker gave up (a page closed): stopping now
	// would mean restarting the worker and loading every model again.
	line, err := d.readLocked(context.Background(), 20*time.Second)
	if err != nil {
		d.stopLocked() // don't leave a half-read answer behind
		return nil, err
	}
	var raw [][]any
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		d.stopLocked()
		return nil, fmt.Errorf("bad detector answer: %v", err)
	}
	out := make([]Detection, 0, len(raw))
	for _, r := range raw {
		if len(r) != 6 {
			continue
		}
		label, _ := r[0].(string)
		v := make([]float64, 5)
		for i := range v {
			v[i], _ = r[i+1].(float64)
		}
		out = append(out, Detection{Label: label, Score: v[0], Box: Rect{X: v[1], Y: v[2], W: v[3], H: v[4]}})
	}
	return out, nil
}

var fullFrame = Rect{W: 1, H: 1}

// frameRGB is a decoded picture: a part of a camera frame, scaled down.
type frameRGB struct {
	rgb  []byte
	w, h int
	r    Rect // the part of the frame it shows (normalised)
}

// decodeRGB decodes the part r (normalised) of the frame at t, scaled to fit size×size
// (size 0: as recorded, full resolution).
func (a *App) decodeRGB(ctx context.Context, cam string, t time.Time, r Rect, size int) (frameRGB, error) {
	vf := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:flags=area,format=rgb24", size, size)
	if size <= 0 {
		vf = "format=rgb24"
	}
	if r != fullFrame {
		vf = fmt.Sprintf("crop=trunc(iw*%.4f/2)*2:trunc(ih*%.4f/2)*2:trunc(iw*%.4f):trunc(ih*%.4f),", r.W, r.H, r.X, r.Y) + vf
	}
	b, err := a.runDecode(ctx, cam, t, true, []string{"-vf", vf, "-f", "image2", "-c:v", "ppm", "pipe:1"})
	if err != nil {
		return frameRGB{}, err
	}
	rgb, w, h, err := parsePPM(b)
	if err != nil {
		return frameRGB{}, err
	}
	return frameRGB{rgb, w, h, r}, nil
}

// detectIn runs a model on a decoded picture. Boxes come back relative to the whole
// frame.
func (a *App) detectIn(ctx context.Context, model string, f frameRGB) ([]Detection, error) {
	ds, err := a.detector.Detect(ctx, model, f.rgb, f.w, f.h)
	for i := range ds {
		b := &ds[i].Box
		*b = Rect{X: f.r.X + b.X*f.r.W, Y: f.r.Y + b.Y*f.r.H, W: b.W * f.r.W, H: b.H * f.r.H}
	}
	return ds, err
}

// detectAt decodes the part r (normalised) of the frame at t and runs a model on it.
// Boxes are returned relative to the whole frame. Looking at a part makes small things
// (a cat far down a corridor) big enough to recognise.
func (a *App) detectAt(ctx context.Context, cam string, t time.Time, r Rect, model string) ([]Detection, error) {
	size, err := a.detector.Size(model)
	if err != nil {
		return nil, err
	}
	f, err := a.decodeRGB(ctx, cam, t, r, size)
	if err != nil {
		return nil, err
	}
	return a.detectIn(ctx, model, f)
}

// parsePPM reads a binary PPM (P6, 8-bit) as written by ffmpeg.
func parsePPM(b []byte) ([]byte, int, int, error) {
	fields := make([]int, 0, 3)
	i := 2
	if !bytes.HasPrefix(b, []byte("P6")) {
		return nil, 0, 0, errors.New("not a PPM picture")
	}
	for len(fields) < 3 && i < len(b) {
		for i < len(b) && (b[i] == ' ' || b[i] == '\n' || b[i] == '\r' || b[i] == '\t') {
			i++
		}
		j := i
		for j < len(b) && b[j] >= '0' && b[j] <= '9' {
			j++
		}
		n, err := strconv.Atoi(string(b[i:j]))
		if err != nil {
			return nil, 0, 0, errors.New("bad PPM header")
		}
		fields = append(fields, n)
		i = j
	}
	i++ // the single whitespace after maxval
	w, h := fields[0], fields[1]
	if fields[2] != 255 || i+w*h*3 > len(b) {
		return nil, 0, 0, errors.New("unexpected PPM format")
	}
	return b[i : i+w*h*3], w, h, nil
}

// iou is the overlap of two boxes (intersection over union).
func iou(a, b Rect) float64 {
	x0, y0 := max(a.X, b.X), max(a.Y, b.Y)
	x1, y1 := min(a.X+a.W, b.X+b.W), min(a.Y+a.H, b.Y+b.H)
	if x1 <= x0 || y1 <= y0 {
		return 0
	}
	in := (x1 - x0) * (y1 - y0)
	return in / (a.W*a.H + b.W*b.H - in)
}

// prioLock is a mutex where urgent work (a night alert, someone waiting on a page) goes
// before background work (object detection and faces catching up) that is waiting too:
// with plain first-come order an alert queued behind every background picture.
type prioLock struct {
	mu       sync.Mutex
	held     bool
	urgent   []chan struct{}
	backlogQ []chan struct{}
}

// Lock takes it as urgent work.
func (p *prioLock) Lock() { p.lock(true) }

// LockFor takes it as background work when ctx says so (see lowPriority).
func (p *prioLock) LockFor(ctx context.Context) { p.lock(ctx.Value(lowPriorityKey) == nil) }

// detectorHeld counts cat watches running: background work (labels, faces, catching
// up) waits meanwhile, so a cat at the door is looked at every 2-3 s. On the replay,
// with the labeler catching up, one look took 19 s and missed the cat walking past.
var detectorHeld atomic.Int32

func (p *prioLock) lock(urgent bool) {
	for !urgent && detectorHeld.Load() > 0 {
		time.Sleep(250 * time.Millisecond)
	}
	p.mu.Lock()
	if !p.held {
		p.held = true
		p.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	if urgent {
		p.urgent = append(p.urgent, ch)
	} else {
		p.backlogQ = append(p.backlogQ, ch)
	}
	p.mu.Unlock()
	<-ch // handed over by Unlock, still held
}

func (p *prioLock) Unlock() {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case len(p.urgent) > 0:
		close(p.urgent[0])
		p.urgent = p.urgent[1:]
	case len(p.backlogQ) > 0:
		close(p.backlogQ[0])
		p.backlogQ = p.backlogQ[1:]
	default:
		p.held = false
	}
}
