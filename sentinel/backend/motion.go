package main

import (
	"context"
	"io"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Motion detection runs on the low-res substream in its own ffmpeg, completely separate
// from recording: if it fails, recording is unaffected.

const (
	motionW, motionH = 128, 72
	motionFPS        = 3
	pixelThreshold   = 18
	// Motion must continue this long after the last trigger before an event ends.
	motionHold = 10 * time.Second
)

type MotionListener interface {
	MotionStart(cam string, score float64)
	MotionUpdate(cam string, score float64)
	MotionEnd(cam string)
	// box is the part of the frame that changed (normalised), for close-up snapshots.
	Activity(cam string, score float64, box Rect)
	Preview(cam string, jpeg []byte)
}

type MotionStatus struct {
	State  string  `json:"state"` // running | connecting | offline | disabled
	Active bool    `json:"active"`
	Score  float64 `json:"score"` // % of frame changing
	Error  string  `json:"error,omitempty"`
}

type MotionDetector struct {
	cam       Camera
	listener  MotionListener
	incidents *IncidentLog

	mu        sync.Mutex
	status    MotionStatus
	grid      []byte // last frame: 0 still, 1 motion, 2 motion inside an ignore zone
	heartbeat atomic.Int64
	cancel    context.CancelFunc
	done      chan struct{}
}

func newMotionDetector(cam Camera, l MotionListener, inc *IncidentLog) *MotionDetector {
	m := &MotionDetector{cam: cam, listener: l, incidents: inc}
	m.status.State = "connecting"
	m.heartbeat.Store(time.Now().UnixMilli())
	return m
}

func (m *MotionDetector) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	m.cancel = cancel
	m.done = make(chan struct{})
	go func() {
		defer close(m.done)
		defer func() {
			if p := recover(); p != nil {
				m.incidents.Add("error", m.cam.ID, "motion detector crashed: %v", p)
			}
		}()
		m.run(ctx)
	}()
}

func (m *MotionDetector) Stop() {
	if m.cancel != nil {
		m.cancel()
		<-m.done
	}
}

func (m *MotionDetector) Alive() bool {
	select {
	case <-m.done:
		return false
	default:
		return true
	}
}

func (m *MotionDetector) Status() MotionStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *MotionDetector) set(f func(s *MotionStatus)) {
	m.mu.Lock()
	f(&m.status)
	m.mu.Unlock()
}

// threshold maps sensitivity 1..100 to the % of the frame that must change:
// 50 -> ~0.7 %, 100 -> 0.1 %, 1 -> ~4.9 %.
func threshold(sens int) float64 {
	return 5.0 * math.Pow(0.02, float64(sens)/100)
}

func (m *MotionDetector) buildMask() []bool { return maskGrid(m.cam, motionW, motionH) }

// Changed areas smaller than this many cells (of 128x72) are sensor noise, compression
// sparkle or insects close to an IR lamp, not something moving through the scene.
const minBlob = 4

func (m *MotionDetector) run(ctx context.Context) {
	var bo backoff
	mask := m.buildMask()
	active := 0
	for _, v := range mask {
		if !v {
			active++
		}
	}
	if active == 0 {
		m.set(func(s *MotionStatus) { s.State, s.Error = "disabled", "whole frame is masked" })
		<-ctx.Done()
		return
	}
	thr := threshold(m.cam.MotionSensitivity)
	inMotion := false
	for ctx.Err() == nil {
		m.heartbeat.Store(time.Now().UnixMilli())
		url := restreamURL(m.cam.ID)
		// One thread each: the substream is small, and eight of these starting a thread
		// per core would crowd out everything else.
		args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-filter_complex_threads", "1"}
		args = append(args, inputArgs(url)...)
		args = append(args, "-threads", "1")
		// One decode feeds both motion (tiny grey frames on stdout) and timeline previews
		// (small JPEGs on fd 3).
		args = append(args, "-i", url, "-an", "-sn",
			"-filter_complex", "[0:v]fps=3,split=2[a][b];[a]scale=128:72:flags=area,format=gray[m];[b]fps=1/2,scale=320:-2[p]",
			"-map", "[m]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
			"-map", "[p]", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "7", "pipe:3")
		pr, pw := io.Pipe()
		prevR, prevW, perr := os.Pipe()
		if perr != nil {
			sleepCtx(ctx, bo.next())
			continue
		}
		tail := &tailBuffer{}
		cmd, err := startProc("ffmpeg", args, nil, pw, tail, prevW)
		prevW.Close() // the child has its own copy
		if err == nil {
			go func() {
				defer prevR.Close()
				splitJPEGs(prevR, func(j []byte) { m.listener.Preview(m.cam.ID, j) })
			}()
		} else {
			prevR.Close()
		}
		if err != nil {
			m.set(func(s *MotionStatus) { s.State, s.Error = "offline", err.Error() })
			sleepCtx(ctx, bo.next())
			continue
		}
		exited := make(chan struct{})
		go func() { cmd.Wait(); pw.Close(); close(exited) }()

		frames := make(chan []byte, 2)
		stopFrames := make(chan struct{})
		go func() {
			defer close(frames)
			for {
				buf := make([]byte, motionW*motionH)
				if _, err := io.ReadFull(pr, buf); err != nil {
					return
				}
				select {
				case frames <- buf:
				case <-stopFrames:
					return
				}
			}
		}()

		started := time.Now()
		var bg []float32
		var consecutive int
		var lastTrigger time.Time
		watchdog := time.NewTicker(5 * time.Second)
		lastFrame := time.Now()
	loop:
		for {
			select {
			case <-ctx.Done():
				stopProc(cmd, exited)
				break loop
			case <-watchdog.C:
				m.heartbeat.Store(time.Now().UnixMilli())
				if time.Since(lastFrame) > 30*time.Second {
					stopProc(cmd, exited)
					break loop
				}
			case f, ok := <-frames:
				if !ok {
					break loop
				}
				now := time.Now()
				lastFrame = now
				m.heartbeat.Store(now.UnixMilli())
				if bg == nil {
					bg = make([]float32, len(f))
					for i, v := range f {
						bg[i] = float32(v)
					}
					m.set(func(s *MotionStatus) { s.State, s.Error = "running", "" })
					bo.reset()
					continue
				}
				changed := 0
				var cols [motionW]int
				var rows [motionH]int
				grid := make([]byte, len(f))
				on := make([]bool, len(f))
				for i, v := range f {
					d := float32(v) - bg[i]
					if d > pixelThreshold || d < -pixelThreshold {
						if mask[i] {
							grid[i] = 2
						} else {
							on[i] = true
						}
					}
					bg[i] += d * 0.08
				}
				// Only solid moving shapes count; scattered specks are noise.
				components(on, motionW, motionH, func(cells []int) {
					if len(cells) < minBlob {
						return
					}
					for _, i := range cells {
						grid[i] = 1
						changed++
						cols[i%motionW]++
						rows[i/motionW]++
					}
				})
				m.mu.Lock()
				m.grid = grid
				m.mu.Unlock()
				score := float64(changed) * 100 / float64(active)
				if score > 70 {
					// Whole-scene change (IR switching, lights, camera adjusting): re-learn.
					for i, v := range f {
						bg[i] = float32(v)
					}
					score = 0
				}
				var box Rect
				if changed > 0 {
					x0, x1 := trimmedSpan(cols[:], changed/20)
					y0, y1 := trimmedSpan(rows[:], changed/20)
					box = Rect{X: float64(x0) / motionW, Y: float64(y0) / motionH, W: float64(x1-x0+1) / motionW, H: float64(y1-y0+1) / motionH}
				}
				m.listener.Activity(m.cam.ID, score, box)
				if score >= thr {
					consecutive++
				} else {
					consecutive = 0
				}
				if consecutive >= 2 {
					lastTrigger = now
					if !inMotion {
						inMotion = true
						m.listener.MotionStart(m.cam.ID, score)
					} else {
						m.listener.MotionUpdate(m.cam.ID, score)
					}
				}
				if inMotion && now.Sub(lastTrigger) > motionHold {
					inMotion = false
					m.listener.MotionEnd(m.cam.ID)
				}
				sc := score
				im := inMotion
				m.set(func(s *MotionStatus) { s.Score, s.Active = sc, im })
			}
		}
		watchdog.Stop()
		close(stopFrames)
		pr.Close()
		<-exited
		if inMotion {
			inMotion = false
			m.listener.MotionEnd(m.cam.ID)
		}
		if ctx.Err() != nil {
			break
		}
		if time.Since(started) > 2*time.Minute {
			bo.reset()
		}
		msg := tail.last()
		m.set(func(s *MotionStatus) { s.State, s.Error, s.Active, s.Score = "offline", msg, false, 0 })
		d := bo.next()
		for end := time.Now().Add(d); time.Now().Before(end) && ctx.Err() == nil; {
			m.heartbeat.Store(time.Now().UnixMilli())
			sleepCtx(ctx, time.Second)
		}
	}
	m.set(func(s *MotionStatus) { s.Active, s.Score = false, 0 })
}

// trimmedSpan returns the index range of a histogram left after ignoring up to `trim`
// counts on each side, so a few stray noisy pixels don't stretch the motion box.
func trimmedSpan(h []int, trim int) (int, int) {
	lo, acc := 0, 0
	for lo < len(h)-1 && acc+h[lo] <= trim {
		acc += h[lo]
		lo++
	}
	hi := len(h) - 1
	acc = 0
	for hi > lo && acc+h[hi] <= trim {
		acc += h[hi]
		hi--
	}
	return lo, hi
}

// Grid returns the latest motion map (motionW x motionH), for the zone editor.
func (m *MotionDetector) Grid() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.grid
}

// inPolygon is the even-odd rule point-in-polygon test.
func inPolygon(pts [][2]float64, x, y float64) bool {
	in := false
	for i, j := 0, len(pts)-1; i < len(pts); j, i = i, i+1 {
		xi, yi, xj, yj := pts[i][0], pts[i][1], pts[j][0], pts[j][1]
		if (yi > y) != (yj > y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi {
			in = !in
		}
	}
	return in
}
