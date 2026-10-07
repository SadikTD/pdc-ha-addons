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
	"slices"
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
	folders   map[string]string // "2026-09-28" or "2026-09-28/Drawing Room" -> folder id
	usage     driveUsage
	// Motion backup: the event window being collected per camera, and finished windows
	// waiting for object detection to say whether anyone was in them.
	motion  map[string]*motionWindow
	waiting []motionJob
}

type motionJob struct {
	cam      string
	from, to int64
	since    time.Time
}

type driveUsage struct {
	Used     int64 `json:"used"`     // bytes Sentinel has on Drive
	Files    int   `json:"files"`    // files Sentinel has on Drive
	Free     int64 `json:"free"`     // free space on the Google account (-1 = unlimited)
	Measured int64 `json:"measured"` // unix ms
}

type motionWindow struct {
	from, to int64 // unix ms
	open     bool  // motion is going on
}

func newDrive(app *App) *Drive {
	return &Drive{app: app, client: &http.Client{Timeout: 5 * time.Minute}, wake: make(chan struct{}, 1), folders: map[string]string{}, motion: map[string]*motionWindow{}}
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
	d.mu.Lock()
	d.folders = map[string]string{}
	d.mu.Unlock()
	return f.ID, nil
}

// subFolder returns the folder called name inside parent, creating it if needed; key
// caches it ("2026-09-28", "2026-09-28/Drawing Room").
func (d *Drive) subFolder(parent, name, key string) (string, error) {
	d.mu.Lock()
	id, ok := d.folders[key]
	d.mu.Unlock()
	if ok {
		return id, nil
	}
	q := url.QueryEscape(fmt.Sprintf("name = '%s' and '%s' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false", strings.ReplaceAll(name, "'", "\\'"), parent))
	var r struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
	}
	if _, err := d.api("GET", "https://www.googleapis.com/drive/v3/files?fields=files(id)&q="+q, nil, &r); err != nil {
		return "", err
	}
	if len(r.Files) > 0 {
		id = r.Files[0].ID
	} else {
		var f struct {
			ID string `json:"id"`
		}
		if _, err := d.api("POST", "https://www.googleapis.com/drive/v3/files?fields=id", map[string]any{
			"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": []string{parent},
		}, &f); err != nil {
			return "", err
		}
		id = f.ID
	}
	d.mu.Lock()
	d.folders[key] = id
	d.mu.Unlock()
	return id, nil
}

// clipFolder is where a clip goes: Sentinel/<day>/<camera>/.
func (d *Drive) clipFolder(c *Clip) (string, error) {
	root, err := d.folder()
	if err != nil {
		return "", err
	}
	day := time.UnixMilli(c.From).In(time.Local).Format("2006-01-02")
	dayID, err := d.subFolder(root, day, day)
	if err != nil {
		return "", err
	}
	cam := driveName(c.CameraName)
	return d.subFolder(dayID, cam, day+"/"+cam)
}

// driveName makes a name safe for Drive (which allows almost anything but "/").
func driveName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 32 {
			return '-'
		}
		return r
	}, strings.TrimSpace(s))
	if s == "" {
		return "Camera"
	}
	return s
}

// clipDriveName: "21.14.03 · Person, Cat.mp4" (motion), "21.14.03 · Night alert.mp4",
// or the name given to a saved clip.
func clipDriveName(c *Clip) string {
	what := c.Name
	switch {
	case c.Auto:
		// Named after who was seen (see flushMotion).
	case c.Alert:
		what = "Night alert"
	}
	return time.UnixMilli(c.From).In(time.Local).Format("15.04.05") + " · " + driveName(what) + ".mp4"
}

// migrateLayout moves backups made before the camera folders to Drive's trash (the
// user chose not to keep them); Drive empties its trash by itself after 30 days.
func (d *Drive) migrateLayout() {
	sec := d.app.secrets.Get()
	if sec.DriveLayout >= 2 || sec.DriveFolderID == "" {
		if sec.DriveLayout < 2 {
			_ = d.app.secrets.Update(func(s *Secrets) { s.DriveLayout = 2 })
		}
		return
	}
	root, err := d.folder()
	if err != nil {
		return
	}
	var r struct {
		Files []driveFile `json:"files"`
	}
	q := url.QueryEscape(fmt.Sprintf("'%s' in parents and trashed = false", root))
	if _, err := d.api("GET", "https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=files(id,name,mimeType)&q="+q, nil, &r); err != nil {
		logf("drive: listing old backups: %v", err)
		return
	}
	var files []driveFile
	if all, err := d.files(); err == nil {
		files = all
	}
	var bytes int64
	for _, f := range files {
		bytes += f.bytes()
	}
	for _, f := range r.Files {
		if _, err := d.api("PATCH", "https://www.googleapis.com/drive/v3/files/"+f.ID, map[string]any{"trashed": true}, nil); err != nil {
			logf("drive: moving %s to the trash: %v", f.Name, err)
			return // try again next time
		}
	}
	d.mu.Lock()
	d.folders = map[string]string{}
	d.usage.Measured = 0
	d.mu.Unlock()
	_ = d.app.secrets.Update(func(s *Secrets) { s.DriveLayout = 2 })
	if len(files) > 0 {
		logf("drive: moved %d old backups (%.1f GB) to the trash", len(files), float64(bytes)/1e9)
		d.app.incidents.Add("info", "", "Google Drive now keeps backups by day and camera; the %d older backups (%.1f GB) were moved to Drive's trash", len(files), float64(bytes)/1e9)
	}
}

func (d *Drive) Disconnect() {
	sec := d.app.secrets.Get()
	if sec.DriveRefreshToken != "" {
		_, _ = d.client.PostForm("https://oauth2.googleapis.com/revoke", url.Values{"token": {sec.DriveRefreshToken}})
	}
	_ = d.app.secrets.Update(func(s *Secrets) { s.DriveRefreshToken, s.DriveAccount, s.DriveFolderID, s.DriveLayout = "", "", "", 0 })
	d.mu.Lock()
	d.access, d.auth, d.lastErr = "", nil, ""
	d.folders, d.usage = map[string]string{}, driveUsage{}
	d.authSeq++
	d.mu.Unlock()
}

// ---- backup queue ----

// ClipReady is called when a clip finishes saving: queue it if the backup mode wants it.
func (d *Drive) ClipReady(id string) {
	b := d.app.settings.Get().Drive
	c, ok := d.app.clips.Get(id)
	if !ok {
		return
	}
	if !d.Connected() {
		if c.Auto {
			d.app.clips.Delete(id)
		}
		return
	}
	if c.Auto || c.Alert && b.Alerts || !c.Alert && b.Saved {
		d.Queue(id)
	}
}

// ---- motion backup ----

// Motion events are collected per camera into one window (10 s before the first motion
// to 10 s after the last, merging motion less than 20 s apart, at most 5 minutes) and
// saved as a hidden clip for upload.
const (
	motionPre   = 10 * time.Second
	motionPost  = 10 * time.Second
	motionMerge = 20 * time.Second
	motionMax   = 5 * time.Minute
)

func (d *Drive) wantsMotion(cam string) bool {
	b := d.app.settings.Get().Drive
	return b.Motion && d.Connected() && (len(b.MotionCameras) == 0 || contains(b.MotionCameras, cam))
}

func (d *Drive) MotionStart(cam string, at int64) {
	if !d.wantsMotion(cam) {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	w := d.motion[cam]
	if w == nil {
		w = &motionWindow{from: at - motionPre.Milliseconds()}
		d.motion[cam] = w
	}
	w.open, w.to = true, 0
}

func (d *Drive) MotionEnd(cam string, at int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if w := d.motion[cam]; w != nil {
		w.open, w.to = false, at+motionPost.Milliseconds()
	}
}

// flushMotion turns finished (or 5-minute) windows into clips; called every few seconds.
func (d *Drive) flushMotion() {
	now := time.Now().UnixMilli()
	type job struct {
		cam      string
		from, to int64
	}
	var jobs []job
	d.mu.Lock()
	for cam, w := range d.motion {
		switch {
		case w.open && now-w.from >= motionMax.Milliseconds():
			// Long motion: cut a 5-minute piece and carry on.
			jobs = append(jobs, job{cam, w.from, w.from + motionMax.Milliseconds()})
			w.from += motionMax.Milliseconds()
		case !w.open && w.to > 0 && now > w.to+motionMerge.Milliseconds():
			jobs = append(jobs, job{cam, w.from, min(w.to, w.from+motionMax.Milliseconds())})
			delete(d.motion, cam)
		}
	}
	for _, j := range jobs {
		d.waiting = append(d.waiting, motionJob{j.cam, j.from, j.to, time.Now()})
	}
	d.mu.Unlock()
}

// Motion windows wait at most this long for object detection; after that (or while
// detection isn't working) they're uploaded anyway: better one clip too many than a
// person missing from the backup.
const motionDecideWait = 30 * time.Minute

// decideMotion uploads the finished motion windows that should be: all of them, or (the
// default) only those where object detection saw a person, cat or dog. A window is
// decided once every event in it has been checked.
func (d *Drive) decideMotion() {
	s := d.app.settings.Get()
	d.mu.Lock()
	jobs := d.waiting
	d.waiting = nil
	d.mu.Unlock()
	var keep []motionJob
	for _, j := range jobs {
		labels, checked := []string{}, true
		for _, e := range d.app.events.List([]string{j.cam}, j.from, j.to, 1000) {
			if e.End != 0 && e.End < j.from || e.Start > j.to {
				continue
			}
			for _, l := range e.Labels {
				if !slices.Contains(labels, l) {
					labels = append(labels, l)
				}
			}
			if e.End == 0 || e.Scan == "" || e.Scan == "scanning" {
				checked = false
			}
		}
		detecting := d.app.detector.Available()
		switch {
		case s.Drive.MotionWho == "all" || !detecting || time.Since(j.since) > motionDecideWait:
		case len(labels) > 0:
		case checked:
			continue // nobody in it (laundry, light, leaves): not uploaded
		default:
			keep = append(keep, j) // not checked yet
			continue
		}
		what := "Motion"
		if len(labels) > 0 {
			what = describeLabels(labels)
		}
		if _, err := d.app.clips.create(Camera{ID: j.cam, Name: cameraName(s, j.cam)}, time.UnixMilli(j.from), time.UnixMilli(j.to), what, false, true); err != nil {
			logf("drive: motion backup for %s: %v", j.cam, err)
		}
	}
	d.mu.Lock()
	d.waiting = append(keep, d.waiting...)
	d.mu.Unlock()
}

// describeLabels: "Person", "Person, Cat", ... (people first).
func describeLabels(labels []string) string {
	out := []string{}
	for _, l := range watchLabels {
		if slices.Contains(labels, l) {
			out = append(out, strings.ToUpper(l[:1])+l[1:])
		}
	}
	return strings.Join(out, ", ")
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
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	lastPrune := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.wake:
		case <-tick.C:
		}
		d.flushMotion()
		d.decideMotion()
		if !d.Connected() {
			continue
		}
		d.migrateLayout()
		for ctx.Err() == nil {
			c := d.next()
			if c == nil {
				break
			}
			d.upload(c)
		}
		if time.Since(lastPrune) > time.Hour {
			lastPrune = time.Now()
			d.prune(0)
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
		return
	}
	d.mu.Lock()
	d.usage.Used += c.Size
	d.usage.Files++
	if d.usage.Free > 0 {
		d.usage.Free -= c.Size
	}
	d.mu.Unlock()
	if c.Auto {
		d.app.clips.Delete(c.ID) // the recording is still on disk; Drive has the copy
	} else {
		d.app.incidents.Add("info", c.Camera, "Clip backed up to Google Drive: %s", c.Name)
	}
}

// uploadFile sends the clip with a resumable upload, in chunks, resuming after errors.
func (d *Drive) uploadFile(c *Clip) (string, error) {
	folder, err := d.clipFolder(c)
	if err != nil {
		return "", err
	}
	if err := d.makeRoom(c.Size); err != nil {
		return "", err
	}
	f, err := os.Open(d.app.clips.videoPath(c))
	if err != nil {
		return "", errors.New("the clip file is gone")
	}
	defer f.Close()
	st, _ := f.Stat()
	size := st.Size()
	name := clipDriveName(c)

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

type driveFile struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Size    string   `json:"size"`
	Created string   `json:"createdTime"`
	Parents []string `json:"parents"`
}

// files lists every video Sentinel uploaded (drive.file only shows the app's own files),
// oldest first.
func (d *Drive) files() ([]driveFile, error) {
	var out []driveFile
	q := url.QueryEscape("mimeType != 'application/vnd.google-apps.folder' and trashed = false")
	token := ""
	for page := 0; page < 100; page++ {
		var r struct {
			Files []driveFile `json:"files"`
			Next  string      `json:"nextPageToken"`
		}
		u := "https://www.googleapis.com/drive/v3/files?pageSize=1000&orderBy=createdTime&fields=nextPageToken,files(id,name,size,createdTime,parents)&q=" + q
		if token != "" {
			u += "&pageToken=" + url.QueryEscape(token)
		}
		if _, err := d.api("GET", u, nil, &r); err != nil {
			return nil, err
		}
		out = append(out, r.Files...)
		if token = r.Next; token == "" {
			break
		}
	}
	return out, nil
}

func (f driveFile) bytes() int64 { n, _ := strconv.ParseInt(f.Size, 10, 64); return n }

// accountFree is the free space on the Google account (-1 = unlimited).
func (d *Drive) accountFree() int64 {
	var r struct {
		Quota struct {
			Limit string `json:"limit"`
			Usage string `json:"usage"`
		} `json:"storageQuota"`
	}
	if _, err := d.api("GET", "https://www.googleapis.com/drive/v3/about?fields=storageQuota(limit,usage)", nil, &r); err != nil || r.Quota.Limit == "" {
		return -1
	}
	limit, _ := strconv.ParseInt(r.Quota.Limit, 10, 64)
	usage, _ := strconv.ParseInt(r.Quota.Usage, 10, 64)
	return max(limit-usage, 0)
}

// Keep at least this much of the Google account free (Gmail and Photos share it).
const driveReserve = 1 << 30

// prune deletes backups past the retention and, to fit `need` more bytes, the oldest
// ones beyond Sentinel's space limit or the account's free space. Folders left empty
// are removed too.
func (d *Drive) prune(need int64) error {
	b := d.app.settings.Get().Drive
	files, err := d.files()
	if err != nil {
		return err
	}
	free := d.accountFree()
	var used int64
	for _, f := range files {
		used += f.bytes()
	}
	quota := int64(b.QuotaGB * 1e9)
	cut := ""
	if b.RetentionDays > 0 {
		cut = time.Now().Add(-time.Duration(b.RetentionDays) * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	removed, freed := 0, int64(0)
	touched := map[string]bool{}
	for _, f := range files {
		tooOld := cut != "" && f.Created < cut
		overQuota := quota > 0 && used-freed+need > quota
		accountFull := free >= 0 && free+freed-need < driveReserve
		if !tooOld && !overQuota && !accountFull {
			break
		}
		if _, err := d.api("DELETE", "https://www.googleapis.com/drive/v3/files/"+f.ID, nil, nil); err != nil {
			logf("drive: could not remove %s: %v", f.Name, err)
			continue
		}
		removed++
		freed += f.bytes()
		for _, p := range f.Parents {
			touched[p] = true
		}
	}
	d.removeEmpty(touched)
	d.mu.Lock()
	d.usage = driveUsage{Used: used - freed, Files: len(files) - removed, Free: free, Measured: time.Now().UnixMilli()}
	if free >= 0 {
		d.usage.Free = free + freed
	}
	d.mu.Unlock()
	if removed > 0 {
		// Routine once the space limit is reached (every upload): the add-on log only, or
		// it would push real problems off the System page.
		logf("drive: removed %d old backups (%.1f GB) to stay within limits", removed, float64(freed)/1e9)
	}
	if quota > 0 && need > quota {
		return fmt.Errorf("this clip (%.1f GB) is bigger than the Drive space limit", float64(need)/1e9)
	}
	if free >= 0 && free+freed-need < driveReserve && removed == 0 {
		return errors.New("your Google Drive is full")
	}
	return nil
}

// removeEmpty deletes the folders (camera, then day) that pruning left empty.
func (d *Drive) removeEmpty(folders map[string]bool) {
	root := d.app.secrets.Get().DriveFolderID
	for len(folders) > 0 {
		parents := map[string]bool{}
		for folder := range folders {
			if folder == root || folder == "" {
				continue
			}
			var r struct {
				Files []struct {
					ID string `json:"id"`
				} `json:"files"`
			}
			q := url.QueryEscape(fmt.Sprintf("'%s' in parents and trashed = false", folder))
			if _, err := d.api("GET", "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)&q="+q, nil, &r); err != nil || len(r.Files) > 0 {
				continue
			}
			var f struct {
				Parents []string `json:"parents"`
			}
			_, _ = d.api("GET", "https://www.googleapis.com/drive/v3/files/"+folder+"?fields=parents", nil, &f)
			if _, err := d.api("DELETE", "https://www.googleapis.com/drive/v3/files/"+folder, nil, nil); err != nil {
				continue
			}
			d.mu.Lock()
			for k, id := range d.folders {
				if id == folder {
					delete(d.folders, k)
				}
			}
			d.mu.Unlock()
			for _, p := range f.Parents {
				parents[p] = true
			}
		}
		folders = parents
	}
}

// makeRoom checks the limits before an upload, using the cached usage when it clearly
// fits and a fresh listing (with deletions) when it may not.
func (d *Drive) makeRoom(size int64) error {
	b := d.app.settings.Get().Drive
	d.mu.Lock()
	u := d.usage
	d.mu.Unlock()
	fresh := time.Since(time.UnixMilli(u.Measured)) < 6*time.Hour
	fits := (b.QuotaGB <= 0 || u.Used+size <= int64(b.QuotaGB*1e9)) && (u.Free < 0 || u.Free-size >= driveReserve)
	if fresh && fits {
		return nil
	}
	return d.prune(size)
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
	Usage      driveUsage `json:"usage"`
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
	st.Usage = d.usage
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
