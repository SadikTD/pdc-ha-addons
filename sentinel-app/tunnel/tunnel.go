// Package tunnel is the Sentinel app's connection engine (built into the Android app
// with gomobile). It connects to Sentinel with sentinel/p2p and serves a private HTTP
// proxy on 127.0.0.1, so the player, image loader and API client simply use plain
// HTTP URLs while everything travels over the encrypted QUIC connection.
package tunnel

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"

	"sentinel/p2p"
)

const DefaultIntroducer = "https://sentinel-introducer.sadikhossain747.workers.dev"

// Tunnel is one connection to one Sentinel. All methods are safe to call from any thread.
type Tunnel struct {
	dataDir string

	mu         sync.Mutex
	id         string
	introducer string
	token      string
	localIPs   []string
	ep         *p2p.Endpoint
	conn       *quic.Conn
	res        *p2p.DialResult
	connecting chan struct{} // closed when the current attempt ends
	state      State
	rt         *http3.Transport
	ln         net.Listener
	secret     string
	gen        int // bumps on Reconnect so stale connections are dropped
	relayOnly  bool
	network    string // which network the phone is on (set by the app)
}

// State as JSON for the app: {"state":"connecting|connected|offline|idle", …}.
type State struct {
	State string `json:"state"`
	Path  string `json:"path,omitempty"` // "home" or "internet"
	Addr  string `json:"addr,omitempty"`
	RTTms int64  `json:"rtt_ms,omitempty"`
	Error string `json:"error,omitempty"`
	Since int64  `json:"since"`
}

func New(dataDir string) *Tunnel {
	os.MkdirAll(dataDir, 0o700)
	return &Tunnel{dataDir: dataDir, introducer: DefaultIntroducer, state: State{State: "idle", Since: now()}}
}

func now() int64 { return time.Now().UnixMilli() }

// SetServer chooses the Sentinel (by ID) and the introducer ("" keeps the default).
func (t *Tunnel) SetServer(id, introducer string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	id = p2p.NormalizeID(id)
	if introducer == "" {
		introducer = DefaultIntroducer
	}
	if id != t.id || introducer != t.introducer {
		t.id, t.introducer = id, introducer
		t.dropLocked("")
	}
}

// SetToken sets the login token sent with every request ("" after logging out).
func (t *Tunnel) SetToken(token string) {
	t.mu.Lock()
	t.token = token
	t.mu.Unlock()
}

// SetLocalIPs gives the phone's own addresses (comma separated), which Android knows
// better than Go can find out.
func (t *Tunnel) SetLocalIPs(csv string) {
	var ips []string
	for _, s := range strings.Split(csv, ",") {
		if a, err := netip.ParseAddr(strings.TrimSpace(s)); err == nil && a.Is4() {
			ips = append(ips, a.String())
		}
	}
	t.mu.Lock()
	t.localIPs = ips
	t.mu.Unlock()
}

// Start opens the local proxy and returns its base URL, e.g.
// "http://127.0.0.1:38421/5f2c…". The random part keeps other apps out.
func (t *Tunnel) Start() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ln != nil {
		return t.baseLocked(), nil
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	b := make([]byte, 16)
	rand.Read(b)
	t.secret = hex.EncodeToString(b)
	t.ln = ln
	t.rt = &http3.Transport{Dial: t.dialForHTTP3, QUICConfig: p2p.QUICConfig()}
	srv := &http.Server{Handler: http.HandlerFunc(t.proxy), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	return t.baseLocked(), nil
}

func (t *Tunnel) baseLocked() string {
	return "http://" + t.ln.Addr().String() + "/" + t.secret
}

// Reconnect drops the connection (e.g. the phone switched from Wi-Fi to mobile data);
// the next request connects again at once.
func (t *Tunnel) Reconnect() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dropLocked("")
}

func (t *Tunnel) dropLocked(reason string) {
	t.gen++
	if t.conn != nil {
		t.conn.CloseWithError(0, reason)
		t.conn = nil
	}
	if t.rt != nil {
		t.rt.Close()
		t.rt = &http3.Transport{Dial: t.dialForHTTP3, QUICConfig: p2p.QUICConfig()}
	}
	if t.ep != nil {
		t.ep.Close()
		t.ep = nil
	}
	t.state = State{State: "idle", Since: now()}
}

// StateJSON reports the connection for the app's status indicator.
func (t *Tunnel) StateJSON() string {
	t.mu.Lock()
	st := t.state
	c := t.conn
	t.mu.Unlock()
	if c != nil && st.State == "connected" {
		if s := c.ConnectionStats(); s.SmoothedRTT > 0 {
			st.RTTms = s.SmoothedRTT.Milliseconds()
		}
	}
	b, _ := json.Marshal(st)
	return string(b)
}

// Connect connects now (instead of on the first request) and waits up to 20 s.
func (t *Tunnel) Connect() error {
	_, err := t.ensure(context.Background())
	return err
}

// ensure returns the live connection, connecting if needed. Concurrent callers share
// one attempt.
func (t *Tunnel) ensure(ctx context.Context) (*quic.Conn, error) {
	for {
		t.mu.Lock()
		if t.conn != nil && t.conn.Context().Err() == nil {
			c := t.conn
			t.mu.Unlock()
			return c, nil
		}
		if t.id == "" {
			t.mu.Unlock()
			return nil, errors.New("no Sentinel chosen")
		}
		if ch := t.connecting; ch != nil {
			t.mu.Unlock()
			select {
			case <-ch:
				t.mu.Lock()
				c, st := t.conn, t.state
				t.mu.Unlock()
				if c != nil {
					return c, nil
				}
				return nil, errors.New(st.Error)
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ch := make(chan struct{})
		t.connecting = ch
		gen := t.gen
		if t.ep == nil {
			ep, err := p2p.Listen(0)
			if err != nil {
				t.connecting = nil
				close(ch)
				t.mu.Unlock()
				return nil, err
			}
			t.ep = ep
		}
		cfg := p2p.DialConfig{ID: t.id, Introducer: t.introducer, Hints: t.loadHints(), Endpoint: t.ep, LocalIPs: slices.Clone(t.localIPs), RelayOnly: t.relayOnly}
		if t.network != "" && slices.Contains(t.loadRelayNets(), t.network) {
			cfg.RelayHeadStart = -1 // this network needed the relay last time
		}
		t.state = State{State: "connecting", Since: now()}
		t.mu.Unlock()

		res, err := p2p.Dial(context.Background(), cfg)

		t.mu.Lock()
		t.connecting = nil
		if gen != t.gen { // Reconnect/SetServer happened meanwhile
			if res != nil {
				res.Conn.CloseWithError(0, "")
			}
			close(ch)
			t.mu.Unlock()
			continue
		}
		if err != nil {
			t.state = State{State: "offline", Error: err.Error(), Since: now()}
			close(ch)
			t.mu.Unlock()
			return nil, err
		}
		t.conn, t.res = res.Conn, res
		path := "internet"
		if res.Local {
			path = "home"
		} else if res.Relay {
			path = "relay"
		}
		t.state = State{State: "connected", Path: path, Addr: res.Addr, Since: now()}
		t.saveHints(res)
		t.rememberNetwork(res.Relay)
		close(ch)
		c := res.Conn
		t.mu.Unlock()
		go func() { // notice when it drops
			<-c.Context().Done()
			t.mu.Lock()
			if t.conn == c {
				t.conn = nil
				t.state = State{State: "idle", Error: "connection lost", Since: now()}
			}
			t.mu.Unlock()
		}()
		return c, nil
	}
}

func (t *Tunnel) dialForHTTP3(ctx context.Context, _ string, _ *tls.Config, _ *quic.Config) (*quic.Conn, error) {
	return t.ensure(ctx)
}

// Hints: addresses that worked for this Sentinel, tried first next time (the LAN
// address makes connecting at home instant, even with the internet down).
type hints struct {
	ID    string   `json:"id"`
	Addrs []string `json:"addrs"`
}

func (t *Tunnel) hintsPath() string { return filepath.Join(t.dataDir, "hints.json") }

func (t *Tunnel) loadHints() []string {
	b, err := os.ReadFile(t.hintsPath())
	if err != nil {
		return nil
	}
	var h hints
	if json.Unmarshal(b, &h) != nil || h.ID != t.id {
		return nil
	}
	return h.Addrs
}

func (t *Tunnel) saveHints(res *p2p.DialResult) {
	var addrs []string
	if a, err := netip.ParseAddrPort(res.Addr); err == nil && a.Addr().IsPrivate() {
		addrs = append(addrs, res.Addr)
	}
	for _, c := range res.Cands {
		if a, err := netip.ParseAddrPort(c); err == nil && a.Addr().IsPrivate() && !slices.Contains(addrs, c) {
			addrs = append(addrs, c) // public addresses change; only keep LAN ones
		}
	}
	for _, old := range t.loadHints() {
		if a, err := netip.ParseAddrPort(old); err == nil && a.Addr().IsPrivate() && !slices.Contains(addrs, old) && len(addrs) < 4 {
			addrs = append(addrs, old)
		}
	}
	b, _ := json.Marshal(hints{ID: t.id, Addrs: addrs})
	os.WriteFile(t.hintsPath(), b, 0o600)
}

var hopHeaders = []string{"Connection", "Keep-Alive", "Proxy-Connection", "Transfer-Encoding", "Upgrade", "Te", "Trailer"}

// proxy forwards a local request to Sentinel. Idempotent requests are retried once on a
// fresh connection if the old one had silently died (e.g. after a network switch).
func (t *Tunnel) proxy(w http.ResponseWriter, r *http.Request) {
	t.mu.Lock()
	secret, tok, rt := t.secret, t.token, t.rt
	t.mu.Unlock()
	path, ok := strings.CutPrefix(r.URL.Path, "/"+secret)
	if !ok || secret == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	u := *r.URL
	u.Scheme, u.Host, u.Path, u.RawPath = "https", "sentinel", path, ""
	var body []byte
	if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
		body, _ = io.ReadAll(io.LimitReader(r.Body, 8<<20))
	}
	var resp *http.Response
	var err error
	tries := 1
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		tries = 2
	}
	for try := 0; try < tries; try++ {
		req, _ := http.NewRequestWithContext(r.Context(), r.Method, u.String(), nil)
		if body != nil {
			req.Body = io.NopCloser(strings.NewReader(string(body)))
			req.ContentLength = int64(len(body))
		}
		req.Header = r.Header.Clone()
		for _, h := range hopHeaders {
			req.Header.Del(h)
		}
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err = rt.RoundTrip(req)
		if err == nil || r.Context().Err() != nil {
			break
		}
		t.mu.Lock()
		if t.rt == rt {
			t.dropLocked("request failed")
		}
		rt = t.rt
		t.mu.Unlock()
	}
	if err != nil {
		t.mu.Lock()
		msg := t.state.Error
		t.mu.Unlock()
		if msg == "" {
			msg = err.Error()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": msg, "offline": "1"})
		return
	}
	defer resp.Body.Close()
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	w.WriteHeader(resp.StatusCode)
	// Stream as it arrives (live video), flushing every chunk.
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 64<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// Discover looks for Sentinels on the phone's Wi-Fi for up to ms milliseconds and
// returns JSON: [{"id":"…","name":"Sentinel","addr":"192.168.0.226:8555"}].
func Discover(localIP string, ms int) string {
	ip, err := netip.ParseAddr(localIP)
	if err != nil {
		ip = p2p.OutboundIP()
	}
	ep, err := p2p.Listen(0)
	if err != nil {
		return "[]"
	}
	defer ep.Close()
	type found struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Version string `json:"version"`
		Addr    string `json:"addr"`
	}
	out := []found{}
	for _, f := range ep.Discover(context.Background(), ip, p2p.DefaultPort, time.Duration(ms)*time.Millisecond) {
		var x found
		if json.Unmarshal(f.JSON, &x) == nil && x.ID != "" {
			x.Addr = f.Addr
			out = append(out, x)
		}
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// Stop closes everything.
func (t *Tunnel) Stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dropLocked("")
	if t.ln != nil {
		t.ln.Close()
		t.ln = nil
	}
}

// FormatID shows an ID the way Sentinel does ("7KQ2-M9XD-4T1B"), or "" if it isn't one.
func FormatID(id string) string {
	if n := p2p.NormalizeID(id); len(n) == p2p.IDLength {
		return p2p.FormatID(n)
	}
	return ""
}

// SetRelayOnly forces the relay (testing).
func (t *Tunnel) SetRelayOnly(on bool) {
	t.mu.Lock()
	t.relayOnly = on
	t.dropLocked("")
	t.mu.Unlock()
}

// SetNetwork tells the engine which network the phone is on (e.g. "wifi:<id>" or
// "cell"), so it remembers where only the relay works and uses it at once there.
func (t *Tunnel) SetNetwork(key string) {
	t.mu.Lock()
	t.network = key
	t.mu.Unlock()
}

func (t *Tunnel) relayNetsPath() string { return filepath.Join(t.dataDir, "relay-networks.json") }

func (t *Tunnel) loadRelayNets() []string {
	var nets []string
	if b, err := os.ReadFile(t.relayNetsPath()); err == nil {
		json.Unmarshal(b, &nets)
	}
	return nets
}

func (t *Tunnel) rememberNetwork(relay bool) {
	if t.network == "" {
		return
	}
	nets := t.loadRelayNets()
	has := slices.Contains(nets, t.network)
	switch {
	case relay && !has:
		nets = append(nets, t.network)
	case !relay && has:
		nets = slices.DeleteFunc(nets, func(n string) bool { return n == t.network })
	default:
		return
	}
	b, _ := json.Marshal(nets)
	os.WriteFile(t.relayNetsPath(), b, 0o600)
}
