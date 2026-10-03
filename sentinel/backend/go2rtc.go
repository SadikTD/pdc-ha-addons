package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// go2rtc serves live view only (MSE over the ingress WebSocket, plus snapshots).
// Recording never goes through it, so a live-view problem can't cost footage.

const (
	go2rtcAddr = "127.0.0.1:1984"
	// Local-only RTSP restream: motion detection reads the substream from here, so each
	// camera serves one substream connection no matter how many viewers there are.
	// (Some NVRs/cameras refuse more than one or two connections per stream.)
	go2rtcRTSP = "127.0.0.1:8554"
)

func restreamURL(cam string) string { return "rtsp://" + go2rtcRTSP + "/" + cam + "_sub" }

type Go2RTC struct {
	confPath  string
	incidents *IncidentLog
	running   atomic.Bool
	mu        sync.Mutex
	cams      []Camera
	restartCh chan struct{}
	client    *http.Client
}

func newGo2RTC(confPath string, inc *IncidentLog) *Go2RTC {
	return &Go2RTC{confPath: confPath, incidents: inc, restartCh: make(chan struct{}, 1), client: &http.Client{Timeout: 15 * time.Second}}
}

func yamlQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func (g *Go2RTC) writeConfig() error {
	g.mu.Lock()
	cams := g.cams
	g.mu.Unlock()
	var b strings.Builder
	b.WriteString("api:\n  listen: \"" + go2rtcAddr + "\"\n")
	b.WriteString("rtsp:\n  listen: \"" + go2rtcRTSP + "\"\nwebrtc:\n  listen: \"\"\nsrtp:\n  listen: \"\"\nrtmp:\n  listen: \"\"\n")
	b.WriteString("log:\n  level: warn\nstreams:\n")
	for _, c := range cams {
		if !c.Enabled {
			continue
		}
		// The ffmpeg source is only used when a viewer needs AAC audio the camera can't give.
		fmt.Fprintf(&b, "  %s:\n    - %s\n    - %s\n", c.ID, yamlQuote(c.MainURL), yamlQuote("ffmpeg:"+c.ID+"#audio=aac"))
		sub := c.SubURL
		if sub == "" {
			sub = c.MainURL
		}
		fmt.Fprintf(&b, "  %s_sub:\n    - %s\n", c.ID, yamlQuote(sub))
		// Pictures of the substream, for browsers that can't decode the camera's video
		// (e.g. H.265 without HEVC support). ffmpeg only runs while someone watches.
		fmt.Fprintf(&b, "  %s_pic:\n    - %s\n", c.ID, yamlQuote("ffmpeg:"+c.ID+"_sub#video=mjpeg"))
	}
	return writeFileAtomic(g.confPath, []byte(b.String()), 0o600)
}

// SetCameras updates the stream list and restarts go2rtc if it changed.
func (g *Go2RTC) SetCameras(cams []Camera) {
	g.mu.Lock()
	changed := fmt.Sprint(streamsOf(g.cams)) != fmt.Sprint(streamsOf(cams))
	g.cams = cams
	g.mu.Unlock()
	if changed {
		select {
		case g.restartCh <- struct{}{}:
		default:
		}
	}
}

func streamsOf(cams []Camera) []string {
	var s []string
	for _, c := range cams {
		if c.Enabled {
			s = append(s, c.ID, c.MainURL, c.SubURL)
		}
	}
	return s
}

func (g *Go2RTC) Run(ctx context.Context) {
	var bo backoff
	for ctx.Err() == nil {
		if err := g.writeConfig(); err != nil {
			logf("go2rtc config: %v", err)
		}
		tail := &tailBuffer{}
		cmd, err := startProc("go2rtc", []string{"-config", g.confPath}, nil, nil, tail)
		if err != nil {
			logf("go2rtc: %v", err)
			sleepCtx(ctx, bo.next())
			continue
		}
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()
		g.running.Store(true)
		started := time.Now()
		restart := false
		select {
		case <-ctx.Done():
			stopProc(cmd, exited)
		case <-g.restartCh:
			restart = true
			stopProc(cmd, exited)
		case <-exited:
			g.incidents.Add("warn", "", "Live view service restarted: %s", tail.last())
		}
		g.running.Store(false)
		if restart {
			continue
		}
		if time.Since(started) > time.Minute {
			bo.reset()
		}
		sleepCtx(ctx, bo.next())
	}
}

// Proxy forwards /go2rtc/* (including the live WebSocket) to go2rtc.
func (g *Go2RTC) Proxy() http.Handler {
	target, _ := url.Parse("http://" + go2rtcAddr)
	p := httputil.NewSingleHostReverseProxy(target)
	orig := p.Director
	p.Director = func(r *http.Request) {
		orig(r)
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/go2rtc")
		r.Host = go2rtcAddr
		// go2rtc checks Origin on WebSockets; the request already passed HA's ingress auth.
		r.Header.Del("Origin")
	}
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "live view is starting", http.StatusBadGateway)
	}
	return p
}

// Frame fetches a JPEG snapshot of a stream ("<cam>" or "<cam>_sub").
func (g *Go2RTC) Frame(ctx context.Context, src string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+go2rtcAddr+"/api/frame.jpeg?src="+url.QueryEscape(src), nil)
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return nil, fmt.Errorf("snapshot failed: %s", strings.TrimSpace(string(b)))
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	// An offline camera gets "200 OK" with no picture at all.
	if err == nil && (len(b) < 100 || b[0] != 0xff || b[1] != 0xd8) {
		return nil, errors.New("the camera sent no picture (is it offline?)")
	}
	return b, err
}

func removeQuiet(p string) { _ = os.Remove(p) }
