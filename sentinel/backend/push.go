package main

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Push notifications to the Sentinel app through Firebase Cloud Messaging. Messages
// carry only a type, camera and time; the app fetches any picture itself over its
// encrypted connection, so no image passes through Google.
//
// Setup is one file: the Firebase project's service account key. Sentinel registers
// the app (app.sentinel.nvr) in that project and hands its public config to the app,
// which then needs no rebuild.

const pushPackage = "app.sentinel.nvr"

type FirebaseAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

// FirebaseClient is the app's public Firebase config (safe to give to logged-in phones).
type FirebaseClient struct {
	APIKey    string `json:"api_key"`
	AppID     string `json:"app_id"`
	ProjectID string `json:"project_id"`
	SenderID  string `json:"sender_id"`
}

type Push struct {
	app    *App
	client *http.Client

	mu       sync.Mutex
	token    string
	tokenExp time.Time
	lastErr  string
	lastOK   int64
	sent     int64
	motion   map[string]time.Time // session/camera -> last motion push
}

func newPush(app *App) *Push {
	return &Push{app: app, client: &http.Client{Timeout: 20 * time.Second}, motion: map[string]time.Time{}}
}

func (p *Push) account() (*FirebaseAccount, *FirebaseClient) {
	sec := p.app.secrets.Get()
	if sec.FirebaseAccount == "" {
		return nil, nil
	}
	var a FirebaseAccount
	if json.Unmarshal([]byte(sec.FirebaseAccount), &a) != nil || a.ProjectID == "" {
		return nil, nil
	}
	var c *FirebaseClient
	if sec.FirebaseClient != "" {
		c = &FirebaseClient{}
		if json.Unmarshal([]byte(sec.FirebaseClient), c) != nil || c.AppID == "" {
			c = nil
		}
	}
	return &a, c
}

// Enabled: notifications can be sent.
func (p *Push) Enabled() bool {
	a, c := p.account()
	return a != nil && c != nil
}

// ClientConfig for the app (nil when push isn't set up).
func (p *Push) ClientConfig() *FirebaseClient {
	_, c := p.account()
	return c
}

func (p *Push) Status() map[string]any {
	a, c := p.account()
	p.mu.Lock()
	defer p.mu.Unlock()
	st := map[string]any{"configured": a != nil && c != nil, "error": p.lastErr, "last_ok": p.lastOK, "sent": p.sent}
	if a != nil {
		st["project"] = a.ProjectID
	}
	return st
}

// accessToken signs a JWT with the service account key and swaps it for an OAuth token.
func (p *Push) accessToken(a *FirebaseAccount) (string, error) {
	p.mu.Lock()
	if p.token != "" && time.Until(p.tokenExp) > time.Minute {
		t := p.token
		p.mu.Unlock()
		return t, nil
	}
	p.mu.Unlock()
	block, _ := pem.Decode([]byte(a.PrivateKey))
	if block == nil {
		return "", errors.New("the service account key is damaged")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("service account key: %w", err)
	}
	key, ok := k.(*rsa.PrivateKey)
	if !ok {
		return "", errors.New("the service account key isn't an RSA key")
	}
	aud := a.TokenURI
	if aud == "" {
		aud = "https://oauth2.googleapis.com/token"
	}
	now := time.Now()
	enc := base64.RawURLEncoding
	hdr := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss":   a.ClientEmail,
		"scope": "https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/cloud-platform",
		"aud":   aud,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	})
	unsigned := hdr + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {unsigned + "." + enc.EncodeToString(sig)}}
	resp, err := p.client.PostForm(aud, form)
	if err != nil {
		return "", fmt.Errorf("can't reach Google: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error_description"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.AccessToken == "" {
		return "", fmt.Errorf("Google refused the service account key: %s", out.Error)
	}
	p.mu.Lock()
	p.token, p.tokenExp = out.AccessToken, now.Add(time.Duration(out.ExpiresIn)*time.Second)
	p.mu.Unlock()
	return out.AccessToken, nil
}

func (p *Push) google(a *FirebaseAccount, method, u string, body any, out any) error {
	tok, err := p.accessToken(a)
	if err != nil {
		return err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, u, rd)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error struct {
				Message string `json:"message"`
				Status  string `json:"status"`
				Details []struct {
					ErrorCode string `json:"errorCode"`
				} `json:"details"`
			} `json:"error"`
		}
		json.Unmarshal(data, &e)
		msg := e.Error.Message
		for _, d := range e.Error.Details {
			if d.ErrorCode != "" {
				msg = d.ErrorCode + ": " + msg
			}
		}
		return &googleError{code: resp.StatusCode, status: e.Error.Status, msg: msg}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

type googleError struct {
	code        int
	status, msg string
}

func (e *googleError) Error() string { return fmt.Sprintf("HTTP %d %s", e.code, e.msg) }

// Setup saves the service account key and registers the app in the Firebase project.
// clientJSON (google-services.json) is only needed if Sentinel can't read the app's
// config itself.
func (p *Push) Setup(accountJSON, clientJSON []byte) error {
	var a FirebaseAccount
	if len(accountJSON) > 0 {
		if err := json.Unmarshal(accountJSON, &a); err != nil || a.ProjectID == "" || a.PrivateKey == "" || a.ClientEmail == "" {
			return errors.New("that isn't a Firebase service account key (a .json file from Project settings → Service accounts)")
		}
		p.mu.Lock()
		p.token = ""
		p.mu.Unlock()
		if _, err := p.accessToken(&a); err != nil {
			return err
		}
		if err := p.app.secrets.Update(func(s *Secrets) { s.FirebaseAccount = string(accountJSON); s.FirebaseClient = "" }); err != nil {
			return err
		}
	} else if acc, _ := p.account(); acc != nil {
		a = *acc
	} else {
		return errors.New("upload the service account key first")
	}
	var c *FirebaseClient
	var err error
	if len(clientJSON) > 0 {
		c, err = parseGoogleServices(clientJSON)
	} else {
		c, err = p.registerApp(&a)
	}
	if err != nil {
		return err
	}
	if c.ProjectID != a.ProjectID {
		return fmt.Errorf("google-services.json is for project %s, but the key is for %s", c.ProjectID, a.ProjectID)
	}
	b, _ := json.Marshal(c)
	return p.app.secrets.Update(func(s *Secrets) { s.FirebaseClient = string(b) })
}

// ErrNeedClientConfig: the service account may not manage apps; ask for google-services.json.
var ErrNeedClientConfig = errors.New("need google-services.json")

func (p *Push) registerApp(a *FirebaseAccount) (*FirebaseClient, error) {
	base := "https://firebase.googleapis.com/v1beta1/projects/" + a.ProjectID
	var list struct {
		Apps []struct {
			AppID       string `json:"appId"`
			PackageName string `json:"packageName"`
		} `json:"apps"`
	}
	if err := p.google(a, "GET", base+"/androidApps", nil, &list); err != nil {
		return nil, fmt.Errorf("%w (%v)", ErrNeedClientConfig, err)
	}
	appID := ""
	for _, x := range list.Apps {
		if x.PackageName == pushPackage {
			appID = x.AppID
		}
	}
	if appID == "" {
		var op struct {
			Name string `json:"name"`
		}
		if err := p.google(a, "POST", base+"/androidApps", map[string]string{"packageName": pushPackage, "displayName": "Sentinel"}, &op); err != nil {
			return nil, fmt.Errorf("%w (%v)", ErrNeedClientConfig, err)
		}
		for i := 0; i < 30 && appID == ""; i++ {
			time.Sleep(time.Second)
			var st struct {
				Done     bool `json:"done"`
				Response struct {
					AppID string `json:"appId"`
				} `json:"response"`
			}
			if err := p.google(a, "GET", "https://firebase.googleapis.com/v1beta1/"+op.Name, nil, &st); err != nil {
				return nil, err
			}
			if st.Done {
				appID = st.Response.AppID
			}
		}
		if appID == "" {
			return nil, errors.New("Firebase didn't finish registering the app; try again")
		}
	}
	var cfg struct {
		Contents string `json:"configFileContents"`
	}
	if err := p.google(a, "GET", base+"/androidApps/"+appID+"/config", nil, &cfg); err != nil {
		return nil, fmt.Errorf("%w (%v)", ErrNeedClientConfig, err)
	}
	raw, err := base64.StdEncoding.DecodeString(cfg.Contents)
	if err != nil {
		return nil, err
	}
	return parseGoogleServices(raw)
}

func parseGoogleServices(b []byte) (*FirebaseClient, error) {
	var g struct {
		ProjectInfo struct {
			ProjectNumber string `json:"project_number"`
			ProjectID     string `json:"project_id"`
		} `json:"project_info"`
		Client []struct {
			ClientInfo struct {
				AppID   string `json:"mobilesdk_app_id"`
				Android struct {
					Package string `json:"package_name"`
				} `json:"android_client_info"`
			} `json:"client_info"`
			APIKey []struct {
				Key string `json:"current_key"`
			} `json:"api_key"`
		} `json:"client"`
	}
	if err := json.Unmarshal(b, &g); err != nil || g.ProjectInfo.ProjectID == "" {
		return nil, errors.New("that isn't a google-services.json file")
	}
	for _, c := range g.Client {
		if c.ClientInfo.Android.Package == pushPackage && len(c.APIKey) > 0 {
			return &FirebaseClient{APIKey: c.APIKey[0].Key, AppID: c.ClientInfo.AppID, ProjectID: g.ProjectInfo.ProjectID, SenderID: g.ProjectInfo.ProjectNumber}, nil
		}
	}
	return nil, fmt.Errorf("google-services.json has no Android app %s: add it in Firebase first", pushPackage)
}

func (p *Push) Disconnect() error {
	p.mu.Lock()
	p.token, p.lastErr = "", ""
	p.mu.Unlock()
	return p.app.secrets.Update(func(s *Secrets) { s.FirebaseAccount, s.FirebaseClient = "", "" })
}

// PushPrefs: what one phone wants to hear about.
type PushPrefs struct {
	Alerts bool     `json:"alerts"` // night alerts (people/animals)
	Status bool     `json:"status"` // camera stopped / started recording
	Motion []string `json:"motion"` // any motion on these cameras
	// The daily summary (nil = on, for phones set up before it existed).
	Summary *bool `json:"summary,omitempty"`
}

func (p PushPrefs) WantsSummary() bool { return p.Summary == nil || *p.Summary }

func defaultPushPrefs() PushPrefs { return PushPrefs{Alerts: true, Status: true} }

// send delivers one data message to every phone chosen by want.
func (p *Push) send(cam string, data map[string]string, want func(PushPrefs, *AppSession) bool) {
	if p.app.remote == nil || !p.Enabled() {
		return
	}
	a, _ := p.account()
	targets := p.app.remote.users.PushSessions(cam)
	for _, t := range targets {
		if !want(t.prefs, t.session) {
			continue
		}
		msg := map[string]any{"message": map[string]any{
			"token":   t.session.PushToken,
			"data":    data,
			"android": map[string]any{"priority": "high", "ttl": "600s"},
		}}
		err := p.google(a, "POST", "https://fcm.googleapis.com/v1/projects/"+a.ProjectID+"/messages:send", msg, nil)
		p.mu.Lock()
		if err != nil {
			p.lastErr = err.Error()
		} else {
			p.lastErr, p.lastOK = "", time.Now().UnixMilli()
			p.sent++
		}
		p.mu.Unlock()
		var ge *googleError
		if errors.As(err, &ge) && (ge.code == 404 || strings.Contains(ge.msg, "UNREGISTERED")) {
			p.app.remote.users.SetPushToken(t.session.ID, "") // the app was uninstalled
		} else if err != nil {
			logf("push: %v", err)
		}
	}
}

func ms(t time.Time) string { return fmt.Sprint(t.UnixMilli()) }

// Alert: a night alert (someone or an animal seen), with the moment of the picture.
func (p *Push) Alert(cam, name string, at time.Time, what, event string) {
	if what == "" {
		what = "Motion"
	}
	go p.send(cam, map[string]string{"type": "alert", "camera": cam, "name": name, "t": ms(at), "what": what, "event": event},
		func(pr PushPrefs, _ *AppSession) bool { return pr.Alerts })
}

// Summary: yesterday's summary, worded for each phone's user (only their cameras).
func (p *Push) Summary(date string, textFor func(allowed func(string) bool) string) {
	if !p.Enabled() || p.app.remote == nil {
		return
	}
	go func() {
		texts := map[string]string{}
		for _, t := range p.app.remote.users.PushSessions("") {
			if !t.prefs.WantsSummary() {
				continue
			}
			u, ok := p.app.remote.users.User(t.session.UserID)
			if !ok {
				continue
			}
			text, ok := texts[u.ID]
			if !ok {
				text = textFor(u.CanSee)
				texts[u.ID] = text
			}
			sid := t.session.ID
			p.send("", map[string]string{"type": "summary", "date": date, "text": text, "t": ms(time.Now())},
				func(_ PushPrefs, s *AppSession) bool { return s.ID == sid })
		}
	}()
}

// CameraState: a camera stopped or resumed recording.
func (p *Push) CameraState(cam, name string, down bool, msg string) {
	kind := "up"
	if down {
		kind = "down"
	}
	go p.send(cam, map[string]string{"type": "status", "state": kind, "camera": cam, "name": name, "t": ms(time.Now()), "text": msg},
		func(pr PushPrefs, _ *AppSession) bool { return pr.Status })
}

// Motion: any motion, for phones that asked for this camera (at most once a minute each).
func (p *Push) Motion(cam, name string, at time.Time) {
	if !p.Enabled() {
		return
	}
	go p.send(cam, map[string]string{"type": "motion", "camera": cam, "name": name, "t": ms(at)},
		func(pr PushPrefs, s *AppSession) bool {
			if !contains(pr.Motion, cam) {
				return false
			}
			key := s.ID + "/" + cam
			p.mu.Lock()
			defer p.mu.Unlock()
			if time.Since(p.motion[key]) < time.Minute {
				return false
			}
			p.motion[key] = time.Now()
			return true
		})
}

// Test sends a test notification to every phone that has notifications on.
func (p *Push) Test(onlySession string) (int, error) {
	if !p.Enabled() {
		return 0, errors.New("notifications aren't set up")
	}
	n := 0
	a, _ := p.account()
	var lastErr error
	for _, t := range p.app.remote.users.PushSessions("") {
		if onlySession != "" && t.session.ID != onlySession {
			continue
		}
		msg := map[string]any{"message": map[string]any{"token": t.session.PushToken, "data": map[string]string{"type": "test", "t": ms(time.Now())}, "android": map[string]any{"priority": "high"}}}
		if err := p.google(a, "POST", "https://fcm.googleapis.com/v1/projects/"+a.ProjectID+"/messages:send", msg, nil); err != nil {
			lastErr = err
			continue
		}
		n++
	}
	if n == 0 && lastErr != nil {
		return 0, lastErr
	}
	return n, nil
}
