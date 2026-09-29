package p2p

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
)

// Debug, when set, logs each step of connecting (for troubleshooting).
var Debug func(format string, args ...any)

func debugf(format string, args ...any) {
	if Debug != nil {
		Debug(format, args...)
	}
}

// ErrOffline: the introducer has no connection from this Sentinel.
var ErrOffline = errors.New("Sentinel is offline (it isn't connected to the internet)")

type DialConfig struct {
	ID         string
	Introducer string   // "" = local network only
	Hints      []string // addresses that worked before, tried at once
	Endpoint   *Endpoint
	// LocalIPs of this device; OutboundIP() when empty.
	LocalIPs []string
	// NoRelay: direct paths only. RelayOnly: skip direct paths (for testing).
	NoRelay   bool
	RelayOnly bool
	// RelayHeadStart overrides relayHeadStart (negative: try the relay at once, e.g. on a
	// network where it was needed before).
	RelayHeadStart time.Duration
}

// relayHeadStart: how long direct paths get before the relay is tried. At home and on
// friendly networks a direct path answers well within this.
const relayHeadStart = 700 * time.Millisecond

type DialResult struct {
	Conn  *quic.Conn
	Addr  string
	Local bool     // on the same network as the server
	Relay bool     // through the relay (no direct path was possible)
	Cands []string // every address the server offered (worth keeping as hints)
}

type attempt struct {
	conn *quic.Conn
	addr string
	err  error
}

// Dial connects to the Sentinel with this ID: at once to the hints, and through the
// introducer to every address the server has, whichever answers first. At home that's
// the LAN address in a few milliseconds; away it's the hole-punched public address.
func Dial(ctx context.Context, cfg DialConfig) (*DialResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ep := cfg.Endpoint
	id := NormalizeID(cfg.ID)
	if len(id) != IDLength {
		return nil, errors.New("that doesn't look like a Sentinel ID")
	}
	results := make(chan attempt, 32)
	var mu sync.Mutex
	tried := map[string]bool{}
	outstanding := 0
	directLeft := 0 // direct dials still in progress
	try := func(addr string) {
		mu.Lock()
		defer mu.Unlock()
		if tried[addr] || cfg.RelayOnly {
			return
		}
		tried[addr] = true
		ua, err := net.ResolveUDPAddr("udp4", addr)
		if err != nil {
			return
		}
		outstanding++
		directLeft++
		debugf("dialing %s", addr)
		go func() {
			c, err := ep.Transport.Dial(ctx, ua, ClientTLS(id), QUICConfig())
			debugf("dial %s: %v", addr, err)
			mu.Lock()
			directLeft--
			mu.Unlock()
			results <- attempt{c, addr, err}
		}()
	}
	for _, h := range cfg.Hints {
		try(h)
	}

	var introErr error
	var serverCands []string
	if cfg.Introducer != "" {
		mu.Lock()
		outstanding++ // the introducer counts as an attempt until it has answered
		mu.Unlock()
		session := ""
		var relayConn chan *RelayConn
		if !cfg.NoRelay {
			// Open the relay WebSocket right away, so it's ready if direct paths fail.
			session = NewRelaySession()
			relayConn = make(chan *RelayConn, 1)
			go func() {
				rc, err := DialRelay(ctx, cfg.Introducer, session, "client")
				if err != nil {
					debugf("relay: %v", err)
				}
				relayConn <- rc
			}()
		}
		go func() {
			cands, err := introduce(ctx, cfg, id, session)
			useRelay := err == nil && relayConn != nil
			mu.Lock()
			introErr, serverCands = err, cands
			if useRelay {
				outstanding++ // the relay attempt
			}
			mu.Unlock()
			for _, c := range cands {
				try(c)
			}
			switch {
			case useRelay:
				go func() {
					// Give direct paths a head start; stop waiting once they've all failed.
					head := relayHeadStart
					if cfg.RelayHeadStart != 0 {
						head = max(cfg.RelayHeadStart, 0)
					}
					deadline := time.Now().Add(head)
					for time.Now().Before(deadline) && ctx.Err() == nil {
						mu.Lock()
						left := directLeft
						mu.Unlock()
						if left == 0 {
							break
						}
						time.Sleep(40 * time.Millisecond)
					}
					rc := <-relayConn
					if rc == nil {
						results <- attempt{addr: "relay", err: errors.New("can't reach the relay")}
						return
					}
					c, err := dialRelayed(ctx, rc, id)
					debugf("relay dial: %v", err)
					results <- attempt{c, "relay", err}
				}()
			case relayConn != nil:
				go func() {
					if rc := <-relayConn; rc != nil {
						rc.Close()
					}
				}()
			}
			results <- attempt{addr: "introducer", err: err}
		}()
	}

	var lastErr error
	for {
		mu.Lock()
		left := outstanding
		mu.Unlock()
		if left == 0 {
			break
		}
		var r attempt
		select {
		case r = <-results:
		case <-ctx.Done():
			r = attempt{err: ctx.Err()}
			mu.Lock()
			outstanding = 1 // stop after this
			mu.Unlock()
		}
		mu.Lock()
		outstanding--
		mu.Unlock()
		if r.addr == "introducer" {
			continue
		}
		if r.err != nil {
			if errors.Is(r.err, ErrWrongServer) || strings.Contains(r.err.Error(), ErrWrongServer.Error()) {
				lastErr = ErrWrongServer
			} else if lastErr == nil {
				lastErr = r.err
			}
			continue
		}
		// Winner: the others are cancelled when we return; close any late successes.
		// (Don't wait for the introducer: at home the LAN hint wins even with the
		// internet down.)
		go func() {
			for {
				mu.Lock()
				left := outstanding
				mu.Unlock()
				if left == 0 {
					return
				}
				if r := <-results; r.conn != nil {
					r.conn.CloseWithError(0, "")
				}
				mu.Lock()
				outstanding--
				mu.Unlock()
			}
		}()
		mu.Lock()
		cands := serverCands
		mu.Unlock()
		ap, _ := netip.ParseAddrPort(r.addr)
		return &DialResult{Conn: r.conn, Addr: r.addr, Local: ap.Addr().IsPrivate(), Relay: r.addr == "relay", Cands: cands}, nil
	}
	mu.Lock()
	defer mu.Unlock()
	switch {
	case introErr != nil && errors.Is(introErr, ErrOffline):
		return nil, ErrOffline
	case lastErr == ErrWrongServer:
		return nil, ErrWrongServer
	case introErr != nil && len(tried) == 0:
		return nil, introErr
	}
	return nil, errors.New("couldn't reach Sentinel from this network")
}

// dialRelayed runs QUIC over the relay. The transport and the WebSocket live as long as
// the connection.
func dialRelayed(ctx context.Context, rc *RelayConn, id string) (*quic.Conn, error) {
	tr := &quic.Transport{Conn: rc}
	c, err := tr.Dial(ctx, RelayAddr{rc.session}, ClientTLS(id), QUICConfig())
	if err != nil {
		tr.Close()
		rc.Close()
		return nil, err
	}
	go func() {
		<-c.Context().Done()
		tr.Close()
		rc.Close()
	}()
	return c, nil
}

// introduce sends this device's addresses (and the relay session to join, if any) to
// the server through the introducer and returns the server's addresses.
func introduce(ctx context.Context, cfg DialConfig, id, relay string) ([]string, error) {
	ep := cfg.Endpoint
	port := strconv.Itoa(ep.Port())
	var cands []string
	ips := cfg.LocalIPs
	if len(ips) == 0 {
		if ip := OutboundIP(); ip.IsValid() {
			ips = []string{ip.String()}
		}
	}
	for _, ip := range ips {
		cands = append(cands, net.JoinHostPort(ip, port))
	}
	if pub, err := ep.PublicAddr(ctx); err == nil {
		cands = append([]string{pub.String()}, cands...)
	} else {
		debugf("STUN: %v", err)
	}
	debugf("my candidates: %v", cands)
	sid := make([]byte, 8)
	rand.Read(sid)
	body, _ := json.Marshal(map[string]any{"sid": hex.EncodeToString(sid), "cands": cands, "relay": relay})
	req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(cfg.Introducer, "/")+"/v1/connect/"+id, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, errors.New("can't reach the internet")
	}
	defer resp.Body.Close()
	var out struct {
		Cands []string `json:"cands"`
		Error string   `json:"error"`
	}
	json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out)
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrOffline
	}
	if resp.StatusCode != 200 {
		if out.Error == "" {
			out.Error = resp.Status
		}
		return nil, fmt.Errorf("introducer: %s", out.Error)
	}
	debugf("server candidates: %v", out.Cands)
	// While the server punches towards us, punch towards it too (the QUIC dials do
	// this as well, but a few extra packets make restrictive NATs open sooner).
	go ep.Punch(ctx, out.Cands, 3*time.Second)
	return out.Cands, nil
}
