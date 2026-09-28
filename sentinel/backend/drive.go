package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Google Drive backup of clips. Sign-in uses Google's device flow ("enter this code at
// google.com/device"), so it works from the add-on without a redirect URL. The drive.file
// scope only lets Sentinel see and change the files it uploaded itself.

const (
	driveScope    = "https://www.googleapis.com/auth/drive.file"
	driveChunk    = 8 << 20 // resumable upload chunk (multiple of 256 KiB)
	driveMaxTries = 8
)

type DriveAuth struct {
	UserCode string `json:"user_code"`
	URL      string `json:"url"`
	Expires  int64  `json:"expires"`
	Error    string `json:"error,omitempty"`
}

type Drive struct {
	app    *App
	client *http.Client

	mu        sync.Mutex
	access    string
	accessExp time.Time
	auth      *DriveAuth
	authSeq   int
	lastErr   string
	lastOK    int64
	wake      chan struct{}
}

func newDrive(app *App) *Drive {
	return &Drive{app: app, client: &http.Client{Timeout: 5 * time.Minute}, wake: make(chan struct{}, 1)}
}

func (d *Drive) poke() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

func (d *Drive) Connected() bool { return d.app.secrets.Get().DriveRefreshToken != "" }

func (d *Drive) setErr(err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err == nil {
		d.lastErr, d.lastOK = "", time.Now().UnixMilli()
	} else {
		d.lastErr = err.Error()
	}
}

// ---- OAuth ----

type googleErr struct {
	Error string `json:"error"`
	Desc  string `json:"error_description"`
}

func (d *Drive) form(endpoint string, v url.Values, out any) (int, error) {
	resp, err := d.client.PostForm(endpoint, v)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		var ge googleErr
		_ = json.Unmarshal(data, &ge)
		if ge.Error == "" {
			ge.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return resp.StatusCode, errors.New(ge.Error)
	}
	return resp.StatusCode, json.Unmarshal(data, out)
}

// StartAuth begins the device flow with the user's own OAuth client ("TVs and Limited
// Input devices" type) and waits for approval in the background.
func (d *Drive) StartAuth(clientID, secret string) (*DriveAuth, error) {
	clientID, secret = strings.TrimSpace(clientID), strings.TrimSpace(secret)
	if clientID == "" || secret == "" {
		sec := d.app.secrets.Get()
		clientID, secret = sec.DriveClientID, sec.DriveClientSecret
	}
	if clientID == "" || secret == "" {
		return nil, errors.New("paste the OAuth client ID and secret first")
	}
	var r struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
		URL        string `json:"verification_url"`
		ExpiresIn  int    `json:"expires_in"`
		Interval   int    `json:"interval"`
	}
	if _, err := d.form("https://oauth2.googleapis.com/device/code", url.Values{"client_id": {clientID}, "scope": {driveScope}}, &r); err != nil {
		if err.Error() == "invalid_client" {
			return nil, errors.New("Google doesn't know that client ID; check it's a \"TVs and Limited Input devices\" OAuth client")
		}
		return nil, fmt.Errorf("Google refused the sign-in request: %v", err)
	}
	_ = d.app.secrets.Update(func(s *Secrets) { s.DriveClientID, s.DriveClientSecret = clientID, secret })
	a := &DriveAuth{UserCode: r.UserCode, URL: r.URL, Expires: time.Now().Add(time.Duration(r.ExpiresIn) * time.Second).UnixMilli()}
	d.mu.Lock()
	d.authSeq++
	seq := d.authSeq
	d.auth = a
	d.mu.Unlock()
	go d.pollAuth(seq, clientID, secret, r.DeviceCode, time.Duration(max(r.Interval, 5))*time.Second, time.UnixMilli(a.Expires))
	cp := *a
	return &cp, nil
}

func (d *Drive) pollAuth(seq int, clientID, secret, deviceCode string, interval time.Duration, expires time.Time) {
	fail := func(msg string) {
		d.mu.Lock()
		if d.authSeq == seq && d.auth != nil {
			d.auth.Error = msg
		}
		d.mu.Unlock()
	}
	for time.Now().Before(expires) {
		if !sleepCtx(d.app.ctx, interval) {
			return
		}
		d.mu.Lock()
		stale := d.authSeq != seq
		d.mu.Unlock()
		if stale {
			return
		}
		var tok struct {
			Access  string `json:"access_token"`
			Refresh string `json:"refresh_token"`
			Expires int    `json:"expires_in"`
		}
		_, err := d.form("https://oauth2.googleapis.com/token", url.Values{
			"client_id": {clientID}, "client_secret": {secret}, "device_code": {deviceCode},
			"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"},
		}, &tok)
		switch {
		case err == nil:
			_ = d.app.secrets.Update(func(s *Secrets) { s.DriveRefreshToken, s.DriveFolderID = tok.Refresh, "" })
			d.mu.Lock()
			d.access, d.accessExp = tok.Access, time.Now().Add(time.Duration(tok.Expires-60)*time.Second)
			d.auth = nil
			d.mu.Unlock()
			account := d.account()
			_ = d.app.secrets.Update(func(s *Secrets) { s.DriveAccount = account })
			if _, err := d.folder(); err != nil {
				d.setErr(err)
			}
			d.app.incidents.Add("info", "", "Google Drive connected (%s)", account)
			d.poke()
			return
		case err.Error() == "authorization_pending":
		case err.Error() == "slow_down":
			interval += 5 * time.Second
		case err.Error() == "access_denied":
			fail("Access was denied in the Google sign-in page")
			return
		case err.Error() == "expired_token":
			fail("The code expired; press Connect again")
			return
		default:
			// Network trouble: keep trying until the code expires.
		}
	}
	fail("The code expired; press Connect again")
}

func (d *Drive) token() (string, error) {
	d.mu.Lock()
	if d.access != "" && time.Now().Before(d.accessExp) {
		t := d.access
		d.mu.Unlock()
		return t, nil
	}
	d.mu.Unlock()
	sec := d.app.secrets.Get()
	if sec.DriveRefreshToken == "" {
		return "", errors.New("Google Drive isn't connected")
	}
	var tok struct {
		Access  string `json:"access_token"`
		Expires int    `json:"expires_in"`
	}
	if _, err := d.form("https://oauth2.googleapis.com/token", url.Values{
		"client_id": {sec.DriveClientID}, "client_secret": {sec.DriveClientSecret},
		"refresh_token": {sec.DriveRefreshToken}, "grant_type": {"refresh_token"},
	}, &tok); err != nil {
		if err.Error() == "invalid_grant" {
			return "", errors.New("Google access expired or was removed; press Connect again (publish the OAuth app so access doesn't expire after 7 days)")
		}
		return "", fmt.Errorf("Google sign-in: %v", err)
	}
	d.mu.Lock()
	d.access, d.accessExp = tok.Access, time.Now().Add(time.Duration(tok.Expires-60)*time.Second)
	d.mu.Unlock()
	return tok.Access, nil
}

// api calls the Drive REST API with a JSON body (or none) and decodes a JSON reply.
func (d *Drive) api(method, u string, body any, out any) (*http.Response, error) {
	tok, err := d.token()
	if err != nil {
		return nil, err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(d.app.ctx, method, u, rd)
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		return resp, fmt.Errorf("Google Drive: HTTP %d %s", resp.StatusCode, e.Error.Message)
	}
	if out != nil {
		_ = json.Unmarshal(data, out)
	}
	return resp, nil
}

func (d *Drive) account() string {
	var r struct {
		User struct {
			Email string `json:"emailAddress"`
			Name  string `json:"displayName"`
		} `json:"user"`
	}
	if _, err := d.api("GET", "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", nil, &r); err != nil {
		return "Google account"
	}
	if r.User.Email != "" {
		return r.User.Email
	}
	return r.User.Name
}

// folder returns the "Sentinel" folder, creating it (again) if needed.
func (d *Drive) folder() (string, error) {
	if id := d.app.secrets.Get().DriveFolderID; id != "" {
		var f struct {
			Trashed bool `json:"trashed"`
		}
		resp, err := d.api("GET", "https://www.googleapis.com/drive/v3/files/"+id+"?fields=id,trashed", nil, &f)
		if err == nil && !f.Trashed {
			return id, nil
		}
		if resp == nil || resp.StatusCode != 404 && err != nil && !f.Trashed {
			return "", err
		}
	}
	var f struct {
		ID string `json:"id"`
	}
	if _, err := d.api("POST", "https://www.googleapis.com/drive/v3/files?fields=id", map[string]any{
		"name": "Sentinel", "mimeType": "application/vnd.google-apps.folder",
		"description": "Clips backed up by Sentinel (Home Assistant camera recorder)",
	}, &f); err != nil {
		return "", err
	}
	_ = d.app.secrets.Update(func(s *Secrets) { s.DriveFolderID = f.ID })
	return f.ID, nil
}

func (d *Drive) Disconnect() {
	sec := d.app.secrets.Get()
	if sec.DriveRefreshToken != "" {
		_, _ = d.client.PostForm("https://oauth2.googleapis.com/revoke", url.Values{"token": {sec.DriveRefreshToken}})
	}
	_ = d.app.secrets.Update(func(s *Secrets) { s.DriveRefreshToken, s.DriveAccount, s.DriveFolderID = "", "", "" })
	d.mu.Lock()
	d.access, d.auth, d.lastErr = "", nil, ""
	d.authSeq++
	d.mu.Unlock()
}

// ---- backup queue ----

// ClipReady is called when a clip finishes saving: queue it if the backup mode wants it.
func (d *Drive) ClipReady(id string) {
	mode := d.app.settings.Get().Drive.Mode
	c, ok := d.app.clips.Get(id)
	if !ok || !d.Connected() || mode == "off" || mode == "alerts" && !c.Alert {
		return
	}
	d.Queue(id)
}

// Queue marks a clip for upload (also used by "Back up now" and "Retry").
func (d *Drive) Queue(id string) {
	d.app.clips.SetBackup(id, func(b *ClipBackup) {
		if b.State != "done" && b.State != "uploading" {
			b.State, b.Error, b.Tries, b.Progress = "pending", "", 0, 0
		}
	})
	d.poke()
}

func (d *Drive) Run(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	lastPrune := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.wake:
		case <-tick.C:
		}
		if !d.Connected() {
			continue
		}
		for ctx.Err() == nil {
			c := d.next()
			if c == nil {
				break
			}
			d.upload(c)
		}
		if days := d.app.settings.Get().Drive.RetentionDays; days > 0 && time.Since(lastPrune) > 6*time.Hour {
			lastPrune = time.Now()
			d.prune(days)
		}
	}
}

// next picks the oldest clip waiting for upload; failed uploads are retried with growing gaps.
func (d *Drive) next() *Clip {
	var best *Clip
	for _, c := range d.app.clips.List() {
		b := c.Backup
		if c.Status != "ready" || b == nil {
			continue
		}
		wait := time.Duration(1<<min(b.Tries, 8)) * time.Minute
		due := b.State == "pending" || b.State == "failed" && b.Tries < driveMaxTries && time.Since(time.UnixMilli(b.At)) > wait
		if due && (best == nil || c.Created < best.Created) {
			cp := c
			best = &cp
		}
	}
	return best
}

func (d *Drive) upload(c *Clip) {
	d.app.clips.SetBackup(c.ID, func(b *ClipBackup) { b.State, b.Progress, b.At = "uploading", 0, time.Now().UnixMilli() })
	id, err := d.uploadFile(c)
	d.setErr(err)
	d.app.clips.SetBackup(c.ID, func(b *ClipBackup) {
		b.At = time.Now().UnixMilli()
		if err != nil {
			b.State, b.Error = "failed", err.Error()
			b.Tries++
		} else {
			b.State, b.FileID, b.Error, b.Progress = "done", id, "", 100
		}
	})
	if err != nil {
		logf("drive: %s: %v", c.Name, err)
		if c.Backup == nil || c.Backup.Tries+1 >= driveMaxTries {
			d.app.incidents.Add("warn", c.Camera, "Clip not backed up to Google Drive: %v", err)
		}
	} else {
		d.app.incidents.Add("info", c.Camera, "Clip backed up to Google Drive: %s", c.Name)
	}
}

// uploadFile sends the clip with a resumable upload, in chunks, resuming after errors.
func (d *Drive) uploadFile(c *Clip) (string, error) {
	folder, err := d.folder()
	if err != nil {
		return "", err
	}
	f, err := os.Open(d.app.clips.videoPath(c))
	if err != nil {
		return "", errors.New("the clip file is gone")
	}
	defer f.Close()
	st, _ := f.Stat()
	size := st.Size()
	name := time.UnixMilli(c.From).In(time.Local).Format("2006-01-02 15.04.05") + " " + safeFileName(c.Name) + ".mp4"

	tok, err := d.token()
	if err != nil {
		return "", err
	}
	meta, _ := json.Marshal(map[string]any{
		"name": name, "parents": []string{folder},
		"description": fmt.Sprintf("%s, %s to %s", c.CameraName, time.UnixMilli(c.From).In(time.Local).Format("Mon 2 Jan 2006 15:04:05"), time.UnixMilli(c.To).In(time.Local).Format("15:04:05")),
	})
	req, _ := http.NewRequestWithContext(d.app.ctx, "POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", bytes.NewReader(meta))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	req.Header.Set("X-Upload-Content-Type", "video/mp4")
	req.Header.Set("X-Upload-Content-Length", strconv.FormatInt(size, 10))
	resp, err := d.client.Do(req)
	if err != nil {
		return "", err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	session := resp.Header.Get("Location")
	if resp.StatusCode != 200 || session == "" {
		return "", fmt.Errorf("Google Drive refused the upload (HTTP %d)", resp.StatusCode)
	}

	var offset int64
	buf := make([]byte, driveChunk)
	fails := 0
	for {
		n, _ := f.ReadAt(buf[:min(int64(driveChunk), size-offset)], offset)
		id, next, err := d.putChunk(session, buf[:n], offset, size)
		if err != nil {
			fails++
			if fails > 6 || d.app.ctx.Err() != nil {
				return "", err
			}
			sleepCtx(d.app.ctx, time.Duration(fails*fails)*5*time.Second)
			// Ask Google how much it has, then continue from there.
			if id, got, err2 := d.putChunk(session, nil, -1, size); err2 == nil {
				if id != "" {
					return id, nil
				}
				offset = got
			}
			continue
		}
		fails = 0
		if id != "" {
			return id, nil
		}
		offset = next
		p := float64(offset) * 100 / float64(max(size, 1))
		d.app.clips.SetBackup(c.ID, func(b *ClipBackup) { b.Progress = p })
	}
}

// putChunk uploads data at offset (offset -1 = status query). It returns the file id when
// the upload is complete, else the next offset Google expects.
func (d *Drive) putChunk(session string, data []byte, offset, size int64) (string, int64, error) {
	tok, err := d.token()
	if err != nil {
		return "", 0, err
	}
	req, _ := http.NewRequestWithContext(d.app.ctx, "PUT", session, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+tok)
	if offset < 0 {
		req.Header.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
	} else {
		req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+int64(len(data))-1, size))
	}
	req.ContentLength = int64(len(data))
	resp, err := d.client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	switch resp.StatusCode {
	case 200, 201:
		var f struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(body, &f)
		return f.ID, size, nil
	case 308:
		// "Range: bytes=0-12345" = everything up to 12345 is stored.
		var next int64
		if r := resp.Header.Get("Range"); r != "" {
			if _, end, ok := strings.Cut(r, "-"); ok {
				v, _ := strconv.ParseInt(end, 10, 64)
				next = v + 1
			}
		}
		return "", next, nil
	case 404, 410:
		return "", 0, errors.New("the upload session expired; it will start over")
	default:
		return "", 0, fmt.Errorf("Google Drive: HTTP %d", resp.StatusCode)
	}
}

// prune deletes backups older than `days` from Drive (only files Sentinel uploaded).
func (d *Drive) prune(days int) {
	folder := d.app.secrets.Get().DriveFolderID
	if folder == "" {
		return
	}
	cut := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
	q := url.QueryEscape(fmt.Sprintf("'%s' in parents and trashed = false and createdTime < '%s'", folder, cut))
	var r struct {
		Files []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"files"`
	}
	if _, err := d.api("GET", "https://www.googleapis.com/drive/v3/files?pageSize=200&fields=files(id,name)&q="+q, nil, &r); err != nil {
		logf("drive prune: %v", err)
		return
	}
	for _, f := range r.Files {
		if _, err := d.api("DELETE", "https://www.googleapis.com/drive/v3/files/"+f.ID, nil, nil); err == nil {
			logf("drive: removed old backup %s", f.Name)
		}
	}
	if len(r.Files) > 0 {
		d.app.incidents.Add("info", "", "Removed %d backups older than %d days from Google Drive", len(r.Files), days)
	}
}

type DriveStatus struct {
	Configured bool       `json:"configured"`
	Connected  bool       `json:"connected"`
	Account    string     `json:"account,omitempty"`
	FolderURL  string     `json:"folder_url,omitempty"`
	ClientID   string     `json:"client_id,omitempty"`
	Auth       *DriveAuth `json:"auth,omitempty"`
	LastError  string     `json:"last_error,omitempty"`
	LastOK     int64      `json:"last_ok,omitempty"`
	Pending    int        `json:"pending"`
	Uploading  int        `json:"uploading"`
	Failed     int        `json:"failed"`
	Done       int        `json:"done"`
}

func (d *Drive) Status() DriveStatus {
	sec := d.app.secrets.Get()
	st := DriveStatus{Configured: sec.DriveClientID != "", Connected: sec.DriveRefreshToken != "", Account: sec.DriveAccount, ClientID: sec.DriveClientID}
	if sec.DriveFolderID != "" {
		st.FolderURL = "https://drive.google.com/drive/folders/" + sec.DriveFolderID
	}
	d.mu.Lock()
	if d.auth != nil {
		a := *d.auth
		st.Auth = &a
	}
	st.LastError, st.LastOK = d.lastErr, d.lastOK
	d.mu.Unlock()
	for _, c := range d.app.clips.List() {
		if c.Backup == nil {
			continue
		}
		switch c.Backup.State {
		case "pending":
			st.Pending++
		case "uploading":
			st.Uploading++
		case "failed":
			st.Failed++
		case "done":
			st.Done++
		}
	}
	return st
}
