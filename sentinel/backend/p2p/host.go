package p2p

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Messages between the server and the introducer (JSON over one WebSocket).
type wsMsg struct {
	T       string   `json:"t"`
	Nonce   string   `json:"nonce,omitempty"`
	Pub     string   `json:"pub,omitempty"`
	Sig     string   `json:"sig,omitempty"`
	Name    string   `json:"name,omitempty"`
	Version string   `json:"version,omitempty"`
	SID     string   `json:"sid,omitempty"`
	Cands   []string `json:"cands,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// AuthMessage is what the server signs to prove it owns its ID.
func AuthMessage(nonce string) []byte { return []byte("sentinel-introducer-v1:" + nonce) }

type HostConfig struct {
	Identity   *Identity
	Endpoint   *Endpoint
	Introducer string // https://…
	Name       string
	Version    string
	// LANAddrs are this server's addresses on the home network ("192.168.0.226:8555").
	LANAddrs func() []string
	Logf     func(format string, args ...any)
}

type HostStatus struct {
	Online    bool   `json:"online"`     // connected to the introducer
	Public    string `json:"public"`     // public address seen by STUN
	Error     string `json:"error"`      // why it isn't online
	Since     int64  `json:"since"`      // unix ms of the last change
	Connects  int64  `json:"connects"`   // app connections introduced since start
	LastApp   int64  `json:"last_app"`   // unix ms of the last one
	PublicErr string `json:"public_err"` // STUN problem, if any
}

// Host keeps the server reachable: a WebSocket to the introducer, and answers to
// connection requests with this server's addresses, while punching towards the app.
type Host struct {
	cfg HostConfig

	mu       sync.Mutex
	status   HostStatus
	public   string
	publicAt time.Time
	connects atomic.Int64
}

func NewHost(cfg HostConfig) *Host { return &Host{cfg: cfg} }

func (h *Host) Status() HostStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.status
	s.Public = h.public
	s.Connects = h.connects.Load()
	return s
}

func (h *Host) setOnline(on bool, err string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.status.Online != on || h.status.Error != err {
		h.status.Since = time.Now().UnixMilli()
	}
	h.status.Online, h.status.Error = on, err
}

// refreshPublic asks STUN for the public address (kept for 2 minutes).
func (h *Host) refreshPublic(ctx context.Context, force bool) string {
	h.mu.Lock()
	if !force && h.public != "" && time.Since(h.publicAt) < 2*time.Minute {
		p := h.public
		h.mu.Unlock()
		return p
	}
	h.mu.Unlock()
	a, err := h.cfg.Endpoint.PublicAddr(ctx)
	h.mu.Lock()
	defer h.mu.Unlock()
	if err != nil {
		h.status.PublicErr = err.Error()
		return h.public // the last known one is still the best guess
	}
	h.status.PublicErr = ""
	h.public, h.publicAt = a.String(), time.Now()
	return h.public
}

func (h *Host) Run(ctx context.Context) {
	go func() { // keep the public address fresh (it changes when the router restarts)
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			h.refreshPublic(ctx, true)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	delay := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := h.session(ctx)
		if ctx.Err() != nil {
			return
		}
		h.setOnline(false, err.Error())
		if time.Since(start) > time.Minute {
			delay = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, 30*time.Second)
	}
}

func (h *Host) session(ctx context.Context) error {
	u := strings.TrimRight(h.cfg.Introducer, "/")
	u = "ws" + strings.TrimPrefix(u, "http") + "/v1/host/" + h.cfg.Identity.ID
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	ws, resp, err := websocket.DefaultDialer.DialContext(dctx, u, http.Header{"User-Agent": {"Sentinel/" + h.cfg.Version}})
	cancel()
	if err != nil {
		if resp != nil {
			return errors.New("introducer: " + resp.Status)
		}
		return errors.New("can't reach the introducer (no internet?)")
	}
	defer ws.Close()
	var wmu sync.Mutex
	send := func(m any) error {
		wmu.Lock()
		defer wmu.Unlock()
		ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if s, ok := m.(string); ok {
			return ws.WriteMessage(websocket.TextMessage, []byte(s))
		}
		return ws.WriteJSON(m)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			ws.Close()
		case <-stop:
		}
	}()
	// The introducer answers "ping" with "pong" without waking up; a missing pong means
	// the connection is dead (e.g. the router restarted), so start over.
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if send("ping") != nil {
					return
				}
			}
		}
	}()
	for {
		ws.SetReadDeadline(time.Now().Add(70 * time.Second))
		_, data, err := ws.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("lost the introducer connection")
		}
		if string(data) == "pong" {
			continue
		}
		var m wsMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.T {
		case "challenge":
			sig := ed25519.Sign(h.cfg.Identity.Priv, AuthMessage(m.Nonce))
			send(wsMsg{T: "auth", Pub: base64.StdEncoding.EncodeToString(h.cfg.Identity.Pub), Sig: base64.StdEncoding.EncodeToString(sig), Name: h.cfg.Name, Version: h.cfg.Version})
		case "ok":
			h.setOnline(true, "")
			h.cfg.Logf("remote access: online as %s", FormatID(h.cfg.Identity.ID))
		case "error":
			return errors.New("introducer refused: " + m.Error)
		case "connect":
			h.connects.Add(1)
			h.mu.Lock()
			h.status.LastApp = time.Now().UnixMilli()
			h.mu.Unlock()
			go func(m wsMsg) {
				var cands []string
				if p := h.refreshPublic(ctx, false); p != "" {
					cands = append(cands, p)
				}
				if h.cfg.LANAddrs != nil {
					cands = append(cands, h.cfg.LANAddrs()...)
				}
				send(wsMsg{T: "answer", SID: m.SID, Cands: cands})
				h.cfg.Endpoint.Punch(ctx, m.Cands, 8*time.Second)
			}(m)
		}
	}
}
