package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go/http3"

	"sentinel/p2p"
)

// Remote access for the Sentinel app: QUIC (HTTP/3) on UDP 8555, reachable on the home
// network and, through NAT hole punching arranged by the introducer, from anywhere.
// Only logged-in app users get in, and each only sees what their account allows.

const defaultIntroducer = "https://sentinel-introducer.sadikhossain747.workers.dev"

type Remote struct {
	app      *App
	identity *p2p.Identity
	host     *p2p.Host
	users    *UserStore
	port     int
	err      string

	lanMu sync.Mutex
	lan   []string
	lanAt time.Time
}

type ctxKey int

const appUserKey ctxKey = 1

// appUser is the logged-in app user of a request (nil for the Home Assistant panel).
func appUser(r *http.Request) *AppUser {
	u, _ := r.Context().Value(appUserKey).(*AppUser)
	return u
}

// camAllowed: may this request see the camera? The HA panel sees everything.
func camAllowed(r *http.Request, cam string) bool {
	u := appUser(r)
	return u == nil || u.CanSee(cam)
}

// newRemote loads the app accounts and the server identity; Start opens the port.
func (a *App) newRemote(configDir string) *Remote {
	rm := &Remote{app: a, users: openUserStore(filepath.Join(configDir, "app_users.json")), port: p2p.DefaultPort}
	if p, err := strconv.Atoi(env("SENTINEL_APP_PORT", "")); err == nil {
		rm.port = p
	}
	id, err := p2p.LoadOrCreateIdentity(filepath.Join(configDir, "identity.key"))
	if err != nil {
		rm.err = "identity: " + err.Error()
		logf("remote access: %s", rm.err)
		return rm
	}
	rm.identity = id
	return rm
}

func (rm *Remote) Start(routes http.Handler) {
	a, id := rm.app, rm.identity
	if id == nil {
		return
	}
	ep, err := p2p.Listen(rm.port)
	if err != nil {
		rm.err = "can't open UDP port " + strconv.Itoa(rm.port) + ": " + err.Error()
		logf("remote access: %s", rm.err)
		return
	}
	ep.OnQuery = func() []byte {
		b, _ := json.Marshal(map[string]string{"id": id.ID, "name": "Sentinel", "version": version})
		return b
	}
	tlsConf, err := id.ServerTLS()
	if err != nil {
		rm.err = err.Error()
		return
	}
	ln, err := ep.Transport.Listen(tlsConf, p2p.QUICConfig())
	if err != nil {
		rm.err = err.Error()
		return
	}
	srv := &http3.Server{Handler: rm.middleware(routes)}
	go func() {
		for {
			conn, err := ln.Accept(a.ctx)
			if err != nil {
				return
			}
			go srv.ServeQUICConn(conn)
		}
	}()
	rm.host = p2p.NewHost(p2p.HostConfig{
		Identity:   id,
		Endpoint:   ep,
		Introducer: env("SENTINEL_INTRODUCER", defaultIntroducer),
		Name:       "Sentinel",
		Version:    version,
		LANAddrs:   rm.lanAddrs,
		Logf:       logf,
	})
	go rm.host.Run(a.ctx)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-a.ctx.Done():
				rm.users.Flush()
				ep.Close()
				return
			case <-t.C:
				rm.users.Flush()
			}
		}
	}()
	logf("remote access: listening on UDP %d, Sentinel ID %s", rm.port, p2p.FormatID(id.ID))
}

// lanAddrs: the host's own addresses on the home network (the add-on runs in a
// container, so ask the Supervisor), with the published app port.
func (rm *Remote) lanAddrs() []string {
	rm.lanMu.Lock()
	defer rm.lanMu.Unlock()
	if rm.lan != nil && time.Since(rm.lanAt) < 5*time.Minute {
		return rm.lan
	}
	data, err := supervisorRequest("GET", "/network/info", nil)
	if err != nil {
		return rm.lan
	}
	var info struct {
		Data struct {
			Interfaces []struct {
				Primary bool `json:"primary"`
				Enabled bool `json:"enabled"`
				IPv4    struct {
					Address []string `json:"address"`
				} `json:"ipv4"`
			} `json:"interfaces"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &info) != nil {
		return rm.lan
	}
	var out []string
	for _, itf := range info.Data.Interfaces {
		if !itf.Enabled {
			continue
		}
		for _, cidr := range itf.IPv4.Address {
			if p, err := netip.ParsePrefix(cidr); err == nil && p.Addr().IsPrivate() {
				a := net.JoinHostPort(p.Addr().String(), strconv.Itoa(rm.port))
				if itf.Primary {
					out = append([]string{a}, out...)
				} else {
					out = append(out, a)
				}
			}
		}
	}
	rm.lan, rm.lanAt = out, time.Now()
	return out
}

// Sentinel runs on the host network (so the app's UDP port isn't behind Docker's NAT,
// which breaks hole punching). The panel port must then stay private: only Home
// Assistant's ingress proxy and the Supervisor network (172.30.32.0/23) and the host
// itself may use it, never other devices on the LAN.
var panelNet = netip.MustParsePrefix("172.30.32.0/23")

func panelOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ap, err := netip.ParseAddrPort(r.RemoteAddr)
		if err != nil || !(ap.Addr().IsLoopback() || panelNet.Contains(ap.Addr().Unmap())) {
			http.Error(w, "Open Sentinel from Home Assistant, or use the Sentinel app.", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

func via(r *http.Request) string {
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil && ap.Addr().IsPrivate() {
		return "home"
	}
	return "internet"
}

func (rm *Remote) middleware(routes http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/hello":
			writeJSON(w, 200, map[string]any{"id": rm.identity.ID, "name": "Sentinel", "version": version})
			return
		case "/app/login":
			rm.handleLogin(w, r)
			return
		}
		u, sid, ok := rm.users.Auth(bearer(r), r.RemoteAddr, via(r))
		if !ok {
			writeErr(w, 401, "please log in again")
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), appUserKey, u))
		if strings.HasPrefix(r.URL.Path, "/app/") {
			rm.handleApp(w, r, u, sid)
			return
		}
		if !rm.allowed(u, r) {
			writeErr(w, 403, "your account can't do that")
			return
		}
		routes.ServeHTTP(w, r)
	})
}

// allowed is the app's list of what users may reach. Everything else, e.g. the
// settings (which hold camera passwords), stays on the Home Assistant panel.
func (rm *Remote) allowed(u *AppUser, r *http.Request) bool {
	p := r.URL.Path
	seg := strings.Split(strings.Trim(p, "/"), "/")
	get := r.Method == http.MethodGet || r.Method == http.MethodHead
	n := len(seg)
	at := func(i int) string {
		if i < n {
			return seg[i]
		}
		return ""
	}
	switch {
	case get && (p == "/api/status" || p == "/api/events" || p == "/api/clips"):
		return true // filtered per camera by the handlers
	case get && n == 4 && at(1) == "cameras" && (at(3) == "snapshot.jpg" || at(3) == "latest.jpg"):
		return u.CanSee(at(2))
	case get && n == 3 && (at(1) == "recordings" || at(1) == "activity"):
		return u.CanSee(at(2))
	case get && n == 4 && (at(1) == "preview" || at(1) == "seg"):
		return u.CanSee(at(2))
	case get && n == 5 && at(1) == "events" && at(4) == "thumb.jpg":
		return u.CanSee(at(2))
	case get && p == "/api/vod.m3u8":
		return u.CanSee(r.URL.Query().Get("camera"))
	case get && n == 4 && at(1) == "clips" && (at(3) == "video" || at(3) == "thumb.jpg"):
		c, ok := rm.app.clips.Get(at(2))
		return ok && u.CanSee(c.Camera)
	case r.Method == http.MethodPost && p == "/api/clips":
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		if err != nil {
			return false
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var req struct {
			Camera string `json:"camera"`
		}
		return json.Unmarshal(body, &req) == nil && u.CanSee(req.Camera)
	case get && (p == "/go2rtc/api/stream.mp4" || p == "/go2rtc/api/frame.jpeg"):
		return u.CanSee(strings.TrimSuffix(r.URL.Query().Get("src"), "_sub"))
	case u.Admin && get && (p == "/api/incidents" || p == "/api/alerts"):
		return true
	case u.Admin && n == 3 && at(1) == "clips" && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		return true
	case u.Admin && r.Method == http.MethodPost && n == 4 && at(1) == "clips" && at(3) == "backup":
		return true
	case u.Admin && r.Method == http.MethodPost && n == 4 && at(1) == "cameras" && at(3) == "restart":
		return true
	}
	return false
}

func (rm *Remote) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "use POST")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Device   string `json:"device"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	tok, u, err := rm.users.Login(req.Username, req.Password, req.Device, r.RemoteAddr)
	if err != nil {
		time.Sleep(500 * time.Millisecond)
		writeErr(w, 401, err.Error())
		return
	}
	rm.app.incidents.Add("info", "", "%s signed in to the Sentinel app (%s)", u.Username, req.Device)
	writeJSON(w, 200, map[string]any{"token": tok, "user": u, "server": map[string]string{"id": rm.identity.ID, "name": "Sentinel", "version": version}})
}

// handleApp: the app's own endpoints (account, and user management for admins).
func (rm *Remote) handleApp(w http.ResponseWriter, r *http.Request, u *AppUser, sid string) {
	p := strings.TrimPrefix(r.URL.Path, "/app")
	switch {
	case p == "/me" && r.Method == http.MethodGet:
		writeJSON(w, 200, map[string]any{"user": u.public(), "server": map[string]string{"id": rm.identity.ID, "name": "Sentinel", "version": version}})
	case p == "/logout" && r.Method == http.MethodPost:
		rm.users.Logout(sid)
		writeJSON(w, 200, map[string]bool{"ok": true})
	case p == "/push" && r.Method == http.MethodPost:
		var req struct {
			Token string `json:"token"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&req)
		rm.users.SetPushToken(sid, req.Token)
		writeJSON(w, 200, map[string]bool{"ok": true})
	case u.Admin:
		rm.handleUsers(w, r, p)
	default:
		writeErr(w, 403, "your account can't do that")
	}
}

// handleUsers manages app accounts: /users, /users/{id}, /sessions, /sessions/{id}.
// Used by admins in the app and by the Settings page (under /api/app).
func (rm *Remote) handleUsers(w http.ResponseWriter, r *http.Request, p string) {
	seg := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case p == "/users" && r.Method == http.MethodGet:
		writeJSON(w, 200, rm.users.List())
	case p == "/users" && r.Method == http.MethodPost:
		var in UserInput
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil {
			writeErr(w, 400, "bad request")
			return
		}
		u, err := rm.users.Create(in)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, u)
	case len(seg) == 2 && seg[0] == "users" && r.Method == http.MethodPatch:
		var in UserInput
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil {
			writeErr(w, 400, "bad request")
			return
		}
		u, err := rm.users.Update(seg[1], in)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, u)
	case len(seg) == 2 && seg[0] == "users" && r.Method == http.MethodDelete:
		if err := rm.users.Delete(seg[1]); err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case p == "/sessions" && r.Method == http.MethodGet:
		writeJSON(w, 200, rm.users.Sessions())
	case len(seg) == 2 && seg[0] == "sessions" && r.Method == http.MethodDelete:
		rm.users.Logout(seg[1])
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		writeErr(w, 404, "not found")
	}
}

// Status for the Settings page.
func (rm *Remote) Status() map[string]any {
	st := map[string]any{"port": rm.port, "error": rm.err, "users": rm.users.Count()}
	if rm.identity != nil {
		st["id"] = p2p.FormatID(rm.identity.ID)
	}
	if rm.host != nil {
		st["host"] = rm.host.Status()
		st["lan"] = rm.lanAddrs()
	}
	return st
}

// Routes for the Home Assistant panel (ingress is already an HA admin session).
func (rm *Remote) panelRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/app/status", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, rm.Status()) })
	mux.HandleFunc("/api/app/", func(w http.ResponseWriter, r *http.Request) {
		rm.handleUsers(w, r, strings.TrimPrefix(r.URL.Path, "/api/app"))
	})
}
