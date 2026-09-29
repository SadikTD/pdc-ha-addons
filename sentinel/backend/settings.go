package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Rect is a motion mask in normalised (0..1) frame coordinates.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type Camera struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	MainURL    string `json:"main_url"`
	SubURL     string `json:"sub_url"`
	Enabled    bool   `json:"enabled"`
	Record     bool   `json:"record"`
	Audio      bool   `json:"audio"`
	Motion     bool   `json:"motion"`
	RetainDays int    `json:"retain_days"`
	// Footage with motion is kept this long (0 = same as RetainDays); the rest of the
	// 24/7 recording is removed after RetainDays.
	MotionRetainDays int `json:"motion_retain_days"`
	// Footage in which a person was seen is kept this long (0 = same as motion).
	PersonRetainDays  int `json:"person_retain_days"`
	MotionSensitivity int `json:"motion_sensitivity"` // 1..100, higher = more sensitive
	// Switched on only now and then (e.g. a shop camera): no "not recording" alerts, and
	// being offline isn't shown as a problem.
	Occasional  bool   `json:"occasional"`
	MotionMasks []Rect `json:"motion_masks"`
	// Ignore zones drawn as polygons (normalised points); motion inside is ignored.
	MotionZones []Zone `json:"motion_zones"`
}

type Zone struct {
	Name   string       `json:"name"`
	Points [][2]float64 `json:"points"`
}

// MotionURL is the stream motion detection decodes: the substream when there is one.
func (c Camera) MotionURL() string {
	if c.SubURL != "" {
		return c.SubURL
	}
	return c.MainURL
}

type Settings struct {
	Cameras []Camera `json:"cameras"`
	// Oldest recordings are deleted early if free disk space drops below this.
	MinFreeGB float64 `json:"min_free_gb"`
	// e.g. "notify.mobile_app_phone"; empty = persistent notification only.
	NotifyService string `json:"notify_service"`
	// Alert when a camera hasn't recorded for this many minutes.
	NotifyAfterMinutes int `json:"notify_after_minutes"`
	// Daily "HH:MM-HH:MM" windows (local time) with no outage alerts, e.g. a scheduled router restart.
	QuietWindows []string `json:"quiet_windows"`
	MQTTEnabled  bool     `json:"mqtt_enabled"`
	// Saved clips are deleted after this many days unless pinned (0 = keep forever).
	ClipRetentionDays int         `json:"clip_retention_days"`
	NightAlerts       NightAlerts `json:"night_alerts"`
	WhatsApp          WhatsApp    `json:"whatsapp"`
	Drive             DriveBackup `json:"drive"`
	// Once a day, yesterday's summary goes to the phones with the app.
	DailySummary DailySummary `json:"daily_summary"`
}

type DailySummary struct {
	Enabled bool   `json:"enabled"`
	Time    string `json:"time"` // "08:00" local time
}

// NightAlerts sends a WhatsApp snapshot when motion starts inside a daily time window.
type NightAlerts struct {
	Enabled bool   `json:"enabled"`
	From    string `json:"from"` // "23:00" local time
	To      string `json:"to"`   // "06:00"
	// Cameras that alert; empty = all.
	Cameras []string `json:"cameras"`
	// Minimum gap between two alerts from one camera. Motion during the gap isn't lost:
	// it's sent when the gap ends.
	CooldownSeconds int `json:"cooldown_seconds"`
	// While motion continues, send another picture this often (0 = only the first).
	FollowupSeconds int `json:"followup_seconds"`
	// Safety limit per camera per hour (0 = no limit), e.g. a swaying tree at night.
	MaxPerHour int `json:"max_per_hour"`
	// Motion must last this many seconds (filters insects, rain and IR flicker).
	MinSeconds int `json:"min_seconds"`
	// Alert on any motion. Off (the default): only when a person, cat or dog that
	// wasn't there before is seen.
	AnyMotion bool `json:"any_motion"`
	// Save a clip of each alerted event (and back it up if Drive backup is on).
	SaveClip bool `json:"save_clip"`
}

// WhatsApp delivery through the PDC WhatsApp Bridge add-on. The API token is kept in
// secrets.json, never in these settings.
type WhatsApp struct {
	// Group JID ("...@g.us") or the bridge's recipient number ("+880...").
	To     string `json:"to"`
	ToName string `json:"to_name"`
	// Night alerts about cats and dogs go here instead ("" = the same chat).
	AnimalsTo     string `json:"animals_to"`
	AnimalsToName string `json:"animals_to_name"`
	// A picture of last night's people each morning (at the daily summary time).
	MorningReport bool `json:"morning_report"`
	// Empty = find the bridge add-on automatically.
	BridgeURL string `json:"bridge_url"`
}

// DriveBackup uploads clips to Google Drive; credentials live in secrets.json.
type DriveBackup struct {
	Mode   string `json:"mode,omitempty"` // pre-1.4 setting, migrated to the flags below
	Alerts bool   `json:"backup_alerts"`  // night alert clips
	Saved  bool   `json:"backup_saved"`   // clips saved by hand
	Motion bool   `json:"backup_motion"`  // every motion event
	// Cameras whose motion is backed up; empty = all.
	MotionCameras []string `json:"motion_cameras"`
	// Sentinel never uses more than this on Drive (0 = no limit); the oldest backups
	// are deleted to make room.
	QuotaGB float64 `json:"quota_gb"`
	// Files Sentinel uploaded are removed from Drive after this many days (0 = never).
	RetentionDays int `json:"retention_days"`
}

func defaultSettings() Settings {
	return Settings{
		Cameras:            []Camera{},
		MinFreeGB:          10,
		NotifyAfterMinutes: 5,
		QuietWindows:       []string{},
		MQTTEnabled:        true,
		ClipRetentionDays:  30,
		NightAlerts: NightAlerts{
			From: "23:00", To: "06:00", Cameras: []string{}, CooldownSeconds: 30, FollowupSeconds: 60, MaxPerHour: 30,
			MinSeconds: 2, SaveClip: true,
		},
		Drive:        DriveBackup{Alerts: true, MotionCameras: []string{}, QuotaGB: 10, RetentionDays: 90},
		DailySummary: DailySummary{Enabled: true, Time: "08:00"},
		WhatsApp:     WhatsApp{MorningReport: true},
	}
}

var (
	idRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,31}$`)
	timeRe   = regexp.MustCompile(`^([01]?\d|2[0-3]):[0-5]\d$`)
	windowRe = regexp.MustCompile(`^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$`)
	waChatRe = regexp.MustCompile(`^(\+[1-9]\d{7,14}|[\d-]{5,40}@g\.us)$`)
)

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "_") {
				b.WriteByte('_')
			}
		}
	}
	out := strings.Trim(b.String(), "_")
	if len(out) > 32 {
		out = out[:32]
	}
	if out == "" {
		out = "camera"
	}
	return out
}

func validStreamURL(u string) bool {
	p, err := url.Parse(u)
	if err != nil || p.Host == "" {
		return false
	}
	switch p.Scheme {
	case "rtsp", "rtsps", "http", "https", "rtmp":
		return true
	}
	return false
}

// normalize fills defaults and validates; it returns a user-facing error.
func (s *Settings) normalize() error {
	if s.Cameras == nil {
		s.Cameras = []Camera{}
	}
	if s.QuietWindows == nil {
		s.QuietWindows = []string{}
	}
	if s.MinFreeGB < 1 {
		s.MinFreeGB = 1
	}
	if s.ClipRetentionDays < 0 {
		s.ClipRetentionDays = 0
	}
	if s.NotifyAfterMinutes < 1 {
		s.NotifyAfterMinutes = 1
	}
	s.NotifyService = strings.TrimSpace(s.NotifyService)
	if !timeRe.MatchString(s.DailySummary.Time) {
		s.DailySummary.Time = "08:00"
	}
	seen := map[string]bool{}
	for i := range s.Cameras {
		c := &s.Cameras[i]
		c.Name = strings.TrimSpace(c.Name)
		c.MainURL = strings.TrimSpace(c.MainURL)
		c.SubURL = strings.TrimSpace(c.SubURL)
		if c.Name == "" {
			return fmt.Errorf("camera %d needs a name", i+1)
		}
		if c.ID == "" {
			c.ID = slugify(c.Name)
			for base, n := c.ID, 2; seen[c.ID]; n++ {
				c.ID = fmt.Sprintf("%s_%d", base, n)
			}
		}
		if !idRe.MatchString(c.ID) {
			return fmt.Errorf("camera id %q may only use a-z, 0-9 and _", c.ID)
		}
		if seen[c.ID] {
			return fmt.Errorf("two cameras share the id %q", c.ID)
		}
		seen[c.ID] = true
		if !validStreamURL(c.MainURL) {
			return fmt.Errorf("%s: main stream must be an rtsp:// (or http) URL", c.Name)
		}
		if c.SubURL != "" && !validStreamURL(c.SubURL) {
			return fmt.Errorf("%s: substream must be an rtsp:// (or http) URL", c.Name)
		}
		if c.RetainDays < 1 {
			c.RetainDays = 1
		}
		if c.RetainDays > 365 {
			c.RetainDays = 365
		}
		if c.MotionRetainDays != 0 && c.MotionRetainDays <= c.RetainDays {
			c.MotionRetainDays = 0
		}
		c.MotionRetainDays = min(max(c.MotionRetainDays, 0), 365)
		if c.PersonRetainDays != 0 && c.PersonRetainDays <= max(c.RetainDays, c.MotionRetainDays) {
			c.PersonRetainDays = 0
		}
		c.PersonRetainDays = min(max(c.PersonRetainDays, 0), 365)
		if c.MotionSensitivity < 1 || c.MotionSensitivity > 100 {
			c.MotionSensitivity = 50
		}
		if c.MotionMasks == nil {
			c.MotionMasks = []Rect{}
		}
		zones := []Zone{}
		for _, z := range c.MotionZones {
			if len(z.Points) < 3 || len(z.Points) > 64 {
				continue
			}
			for i := range z.Points {
				z.Points[i][0] = min(max(z.Points[i][0], 0), 1)
				z.Points[i][1] = min(max(z.Points[i][1], 0), 1)
			}
			z.Name = strings.TrimSpace(z.Name)
			zones = append(zones, z)
		}
		c.MotionZones = zones
	}
	n := &s.NightAlerts
	if n.Cameras == nil {
		n.Cameras = []string{}
	}
	if n.From == "" {
		n.From = "23:00"
	}
	if n.To == "" {
		n.To = "06:00"
	}
	if !windowRe.MatchString(n.From + "-" + n.To) {
		return fmt.Errorf("night alert hours must look like 23:00 and 06:00")
	}
	n.CooldownSeconds = min(max(n.CooldownSeconds, 0), 3600)
	n.FollowupSeconds = min(max(n.FollowupSeconds, 0), 600)
	if n.FollowupSeconds > 0 && n.FollowupSeconds < 10 {
		n.FollowupSeconds = 10
	}
	n.MaxPerHour = min(max(n.MaxPerHour, 0), 1000)
	n.MinSeconds = min(max(n.MinSeconds, 0), 30)
	w := &s.WhatsApp
	w.To, w.BridgeURL = strings.TrimSpace(w.To), strings.TrimRight(strings.TrimSpace(w.BridgeURL), "/")
	w.AnimalsTo = strings.TrimSpace(w.AnimalsTo)
	if w.To != "" && !waChatRe.MatchString(w.To) || w.AnimalsTo != "" && !waChatRe.MatchString(w.AnimalsTo) {
		return fmt.Errorf("WhatsApp chat must be a group or a +international number")
	}
	if w.BridgeURL != "" && !strings.HasPrefix(w.BridgeURL, "http://") && !strings.HasPrefix(w.BridgeURL, "https://") {
		return fmt.Errorf("bridge address must start with http://")
	}
	switch s.Drive.Mode {
	case "off":
		s.Drive.Alerts, s.Drive.Saved = false, false
	case "alerts":
		s.Drive.Alerts, s.Drive.Saved = true, false
	case "all":
		s.Drive.Alerts, s.Drive.Saved = true, true
	}
	s.Drive.Mode = ""
	if s.Drive.MotionCameras == nil {
		s.Drive.MotionCameras = []string{}
	}
	s.Drive.QuotaGB = min(max(s.Drive.QuotaGB, 0), 100000)
	s.Drive.RetentionDays = max(s.Drive.RetentionDays, 0)
	for _, w := range s.QuietWindows {
		if !windowRe.MatchString(w) {
			return fmt.Errorf("quiet window %q must look like 03:55-04:15", w)
		}
	}
	return nil
}

type SettingsStore struct {
	mu   sync.RWMutex
	path string
	s    Settings
}

func loadSettings(path string) (*SettingsStore, error) {
	st := &SettingsStore{path: path, s: defaultSettings()}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return st, st.save()
	}
	if err != nil {
		return nil, err
	}
	s := defaultSettings()
	if err := json.Unmarshal(data, &s); err != nil {
		// Never refuse to record over a bad file: keep a copy and start from defaults.
		_ = os.WriteFile(path+".broken", data, 0o600)
		logf("settings: %s is unreadable (%v); saved a copy as .broken and started fresh", path, err)
		return st, st.save()
	}
	if err := s.normalize(); err != nil {
		logf("settings: %v", err)
	}
	st.s = s
	return st, nil
}

func (st *SettingsStore) Get() Settings {
	st.mu.RLock()
	defer st.mu.RUnlock()
	b, _ := json.Marshal(st.s)
	var cp Settings
	_ = json.Unmarshal(b, &cp)
	return cp
}

func (st *SettingsStore) Set(s Settings) error {
	if err := s.normalize(); err != nil {
		return err
	}
	st.mu.Lock()
	st.s = s
	st.mu.Unlock()
	return st.save()
}

// save writes atomically so a power cut can't leave a half-written file.
func (st *SettingsStore) save() error {
	st.mu.RLock()
	data, err := json.MarshalIndent(st.s, "", "  ")
	st.mu.RUnlock()
	if err != nil {
		return err
	}
	return writeFileAtomic(st.path, data, 0o600)
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var credRe = regexp.MustCompile(`(?i)([a-z]+://)[^/@\s]*@`)

// redact hides stream credentials in anything that might be logged or shown.
func redact(s string) string { return credRe.ReplaceAllString(s, "${1}***@") }
