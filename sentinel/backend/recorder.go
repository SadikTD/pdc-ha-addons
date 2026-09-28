package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	segmentSeconds = 60
	// No new data for this long = ffmpeg is hung (Frigate's failure mode): kill and restart.
	stallTimeout = 20 * time.Second
	// A fresh connection gets a little longer to deliver its first keyframe.
	startTimeout = 40 * time.Second
)

type RecStatus struct {
	State       string     `json:"state"` // recording | starting | stalled | reconnecting | offline
	Since       int64      `json:"since"` // unix ms of the last state change
	LastError   string     `json:"last_error,omitempty"`
	Restarts24h int        `json:"restarts_24h"`
	BitrateKbps float64    `json:"bitrate_kbps"`
	LastWrite   int64      `json:"last_write"` // unix ms
	Audio       bool       `json:"audio"`
	Stream      StreamInfo `json:"stream"`
}

type Recorder struct {
	cam       Camera
	store     *Store
	clock     *Clock
	incidents *IncidentLog

	mu          sync.Mutex
	status      RecStatus
	restarts    []time.Time
	noAudioTill time.Time
	heartbeat   atomic.Int64
	restartCh   chan struct{}
	cancel      context.CancelFunc
	done        chan struct{}
}

func newRecorder(cam Camera, store *Store, clock *Clock, inc *IncidentLog) *Recorder {
	r := &Recorder{cam: cam, store: store, clock: clock, incidents: inc, restartCh: make(chan struct{}, 1)}
	r.status = RecStatus{State: "starting", Since: time.Now().UnixMilli()}
	r.heartbeat.Store(time.Now().UnixMilli())
	return r
}

func (r *Recorder) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		defer func() {
			// A bug here must not stop recording for good: log and let the manager restart us.
			if p := recover(); p != nil {
				r.incidents.Add("error", r.cam.ID, "recorder crashed: %v", p)
			}
		}()
		r.run(ctx)
	}()
}

func (r *Recorder) Stop() {
	if r.cancel != nil {
		r.cancel()
		<-r.done
	}
}

func (r *Recorder) Alive() bool {
	select {
	case <-r.done:
		return false
	default:
		return true
	}
}

// Restart makes the recorder start a new ffmpeg session (e.g. after a clock step).
func (r *Recorder) Restart() {
	select {
	case r.restartCh <- struct{}{}:
	default:
	}
}

func (r *Recorder) Status() RecStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.status
	cut := time.Now().Add(-24 * time.Hour)
	for _, t := range r.restarts {
		if t.After(cut) {
			s.Restarts24h++
		}
	}
	return s
}

func (r *Recorder) HeartbeatAge() time.Duration {
	return time.Since(time.UnixMilli(r.heartbeat.Load()))
}

func (r *Recorder) setState(state, errMsg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status.State != state {
		r.status.State = state
		r.status.Since = time.Now().UnixMilli()
	}
	if errMsg != "" || state == "recording" {
		r.status.LastError = errMsg
	}
}

func newSession(bootTag string) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return bootTag + hex.EncodeToString(b)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (r *Recorder) run(ctx context.Context) {
	dir := r.store.camDir(r.cam.ID)
	var bo backoff
	quickFails := 0
	for ctx.Err() == nil {
		r.heartbeat.Store(time.Now().UnixMilli())
		if err := os.MkdirAll(dir, 0o755); err != nil {
			r.setState("offline", "storage: "+err.Error())
			sleepCtx(ctx, 10*time.Second)
			continue
		}
		// Learn the codec once (needed to tag HEVC so browsers can play it).
		r.mu.Lock()
		info := r.status.Stream
		r.mu.Unlock()
		if info.VideoCodec == "" {
			var err error
			info, err = probeStream(ctx, r.cam.MainURL)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				r.setState("offline", err.Error())
				r.hb(ctx, bo.next())
				continue
			}
			r.mu.Lock()
			r.status.Stream = info
			r.mu.Unlock()
		}

		session := newSession(r.clock.BootTag())
		r.store.RegisterSession(session, r.clock.Epoch())
		audio := r.cam.Audio && info.AudioCodec != "" && time.Now().After(r.noAudioTill)
		args := r.ffmpegArgs(dir, session, info, audio)
		tail := &tailBuffer{}
		cmd, err := startProc("ffmpeg", args, []string{"TZ=UTC"}, nil, tail)
		if err != nil {
			r.setState("offline", "cannot start ffmpeg: "+err.Error())
			r.hb(ctx, bo.next())
			continue
		}
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()

		started := time.Now()
		r.mu.Lock()
		r.status.Audio = audio
		r.mu.Unlock()
		if r.getState() != "recording" {
			r.setState("starting", "")
		}
		var lastID string
		var lastSize int64
		lastGrowth := time.Now()
		gotData := false
		reason := ""
		ticker := time.NewTicker(2 * time.Second)
	monitor:
		for {
			select {
			case <-ctx.Done():
				stopProc(cmd, exited)
				ticker.Stop()
				r.store.SyncSession(r.cam.ID, session, true)
				return
			case <-r.restartCh:
				reason = "restart requested"
				stopProc(cmd, exited)
				break monitor
			case <-exited:
				reason = "ffmpeg exited"
				break monitor
			case now := <-ticker.C:
				r.heartbeat.Store(now.UnixMilli())
				active := r.store.SyncSession(r.cam.ID, session, false)
				if active != nil {
					if active.ID != lastID {
						lastID, lastSize = active.ID, 0
					}
					if active.Size > lastSize {
						grown := active.Size - lastSize
						elapsed := now.Sub(lastGrowth).Seconds()
						lastSize = active.Size
						lastGrowth = now
						r.mu.Lock()
						if elapsed > 0 && elapsed < 30 && grown < 1<<30 {
							kbps := float64(grown) * 8 / 1000 / elapsed
							if r.status.BitrateKbps == 0 {
								r.status.BitrateKbps = kbps
							} else {
								r.status.BitrateKbps = r.status.BitrateKbps*0.8 + kbps*0.2
							}
						}
						r.status.LastWrite = now.UnixMilli()
						r.mu.Unlock()
						if !gotData {
							gotData = true
							if r.getState() != "recording" {
								r.incidents.Add("info", r.cam.ID, "Recording started%s", map[bool]string{true: "", false: " (without audio)"}[audio])
							}
							r.setState("recording", "")
						}
					}
				}
				if gotData && now.Sub(lastGrowth) > 10*time.Second {
					r.setState("stalled", "no data from camera")
				}
				limit := stallTimeout
				if !gotData {
					limit = startTimeout
				}
				if now.Sub(lastGrowth) > limit {
					if gotData {
						reason = fmt.Sprintf("stream stalled (no data for %d s)", int(now.Sub(lastGrowth).Seconds()))
					} else {
						reason = "no video received"
					}
					stopProc(cmd, exited)
					break monitor
				}
			}
		}
		ticker.Stop()
		<-exited
		r.store.SyncSession(r.cam.ID, session, true)

		ran := time.Since(started)
		msg := tail.last()
		if msg == "" {
			msg = reason
		}
		r.mu.Lock()
		r.restarts = append(r.restarts, time.Now())
		if len(r.restarts) > 500 {
			r.restarts = r.restarts[len(r.restarts)-500:]
		}
		r.mu.Unlock()
		if gotData {
			r.incidents.Add("warn", r.cam.ID, "Recording interrupted: %s", reason+detail(msg, reason))
		}
		if ran > 2*time.Minute {
			bo.reset()
			quickFails = 0
		} else {
			quickFails++
		}
		// Audio is a nice-to-have: if the camera keeps failing with it, record without.
		if audio && quickFails >= 3 {
			r.noAudioTill = time.Now().Add(15 * time.Minute)
			r.incidents.Add("warn", r.cam.ID, "Recording without audio for 15 min after repeated failures")
		}
		// The camera may have changed codec (firmware update, settings change).
		if quickFails > 0 && quickFails%5 == 0 {
			r.mu.Lock()
			r.status.Stream = StreamInfo{}
			r.mu.Unlock()
		}
		if reason == "restart requested" {
			continue
		}
		r.setState("reconnecting", msg)
		r.hb(ctx, bo.next())
	}
}

func detail(msg, reason string) string {
	if msg == "" || msg == reason {
		return ""
	}
	return " - " + msg
}

// hb sleeps while keeping the heartbeat fresh (the health check watches it).
func (r *Recorder) hb(ctx context.Context, d time.Duration) {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		r.heartbeat.Store(time.Now().UnixMilli())
		if !sleepCtx(ctx, min(time.Until(end), 2*time.Second)) {
			return
		}
	}
}

func (r *Recorder) ffmpegArgs(dir, session string, info StreamInfo, audio bool) []string {
	args := []string{"-hide_banner", "-loglevel", "warning", "-nostdin", "-fflags", "+genpts+discardcorrupt"}
	args = append(args, inputArgs(r.cam.MainURL)...)
	args = append(args, "-i", r.cam.MainURL, "-map", "0:v:0", "-c:v", "copy")
	if info.VideoCodec == "hevc" {
		args = append(args, "-tag:v", "hvc1") // required for browser playback of H.265 in MP4
	}
	if audio {
		args = append(args, "-map", "0:a:0?")
		if info.AudioCodec == "aac" {
			args = append(args, "-c:a", "copy")
		} else {
			args = append(args, "-c:a", "aac", "-b:a", "32k")
		}
	} else {
		args = append(args, "-an")
	}
	args = append(args,
		"-f", "segment",
		"-segment_time", strconv.Itoa(segmentSeconds),
		"-segment_atclocktime", "1",
		"-reset_timestamps", "1",
		"-strftime", "1",
		"-segment_format", "mp4",
		// Fragmented MP4: every few seconds is flushed as a self-contained fragment,
		// so a power cut loses at most the last fragment, never the whole file.
		"-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof",
		filepath.Join(dir, "%Y%m%d-%H%M%S-"+session+".mp4"),
	)
	return args
}

func (r *Recorder) getState() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status.State
}
