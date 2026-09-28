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
	"time"
)

// Detector finds people and animals in single frames with a small YOLOX model, run by a
// Python worker (detect/detect.py). It only ever sees the few frames a night alert looks
// at, so it costs a fraction of a second per alert. The worker is a separate process:
// if it crashes or hangs it is killed and restarted, and recording never notices.

type Detection struct {
	Label string
	Score float64
	Box   Rect // normalised to the frame
}

type Detector struct {
	script, model string
	mu            sync.Mutex
	cmd           *exec.Cmd
	in            io.WriteCloser
	lines         chan string
	size          int
	retryAt       time.Time // after a failed start, don't try again before this
}

func newDetector() *Detector {
	return &Detector{
		script: env("SENTINEL_DETECT_SCRIPT", "/app/detect/detect.py"),
		model:  env("SENTINEL_DETECT_MODEL", "/app/detect/yolox_tiny.onnx"),
	}
}

// Available reports whether detection is installed and not in a start-failure backoff.
func (d *Detector) Available() bool {
	if _, err := os.Stat(d.model); err != nil {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cmd != nil || time.Now().After(d.retryAt)
}

func (d *Detector) startLocked() error {
	if time.Now().Before(d.retryAt) {
		return errors.New("object detection is unavailable (it failed to start recently)")
	}
	cmd := exec.Command("python3", d.script)
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
	var ready struct {
		Ready bool `json:"ready"`
		Size  int  `json:"size"`
	}
	line, err := d.readLocked(context.Background(), 60*time.Second) // loading the model
	if err == nil {
		err = json.Unmarshal([]byte(line), &ready)
	}
	if err != nil || !ready.Ready || ready.Size < 32 {
		d.stopLocked()
		d.retryAt = time.Now().Add(5 * time.Minute)
		return fmt.Errorf("object detection did not start: %v", err)
	}
	d.size = ready.Size
	logf("object detection ready (model input %d px)", d.size)
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

// Size is the largest picture side the model takes (starting the worker if needed).
func (d *Detector) Size() (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cmd == nil {
		if err := d.startLocked(); err != nil {
			return 0, err
		}
	}
	return d.size, nil
}

// Detect runs the model on one RGB picture (w×h, each side at most Size()).
func (d *Detector) Detect(ctx context.Context, rgb []byte, w, h int) ([]Detection, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cmd == nil {
		if err := d.startLocked(); err != nil {
			return nil, err
		}
	}
	if w > d.size || h > d.size || len(rgb) != w*h*3 {
		return nil, fmt.Errorf("picture %dx%d does not fit the model", w, h)
	}
	if _, err := fmt.Fprintf(d.in, "%d %d\n", w, h); err == nil {
		_, err = d.in.Write(rgb)
	}
	line, err := d.readLocked(ctx, 20*time.Second)
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

// detectAt decodes the part r (normalised) of the frame at t, scaled to fit the model,
// and runs detection on it. Boxes are returned relative to the whole frame. Looking at
// a part makes small things (a cat far down a corridor) big enough to recognise.
func (a *App) detectAt(ctx context.Context, cam string, t time.Time, r Rect) ([]Detection, error) {
	size, err := a.detector.Size()
	if err != nil {
		return nil, err
	}
	vf := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:flags=area,format=rgb24", size, size)
	if r != fullFrame {
		vf = fmt.Sprintf("crop=trunc(iw*%.4f/2)*2:trunc(ih*%.4f/2)*2:trunc(iw*%.4f):trunc(ih*%.4f),", r.W, r.H, r.X, r.Y) + vf
	}
	b, err := a.runDecode(ctx, cam, t, true, []string{"-vf", vf, "-f", "image2", "-c:v", "ppm", "pipe:1"})
	if err != nil {
		return nil, err
	}
	rgb, w, h, err := parsePPM(b)
	if err != nil {
		return nil, err
	}
	ds, err := a.detector.Detect(ctx, rgb, w, h)
	for i := range ds {
		b := &ds[i].Box
		*b = Rect{X: r.X + b.X*r.W, Y: r.Y + b.Y*r.H, W: b.W * r.W, H: b.H * r.H}
	}
	return ds, err
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
