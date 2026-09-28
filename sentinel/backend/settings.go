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
	ID                string `json:"id"`
	Name              string `json:"name"`
	MainURL           string `json:"main_url"`
	SubURL            string `json:"sub_url"`
	Enabled           bool   `json:"enabled"`
	Record            bool   `json:"record"`
	Audio             bool   `json:"audio"`
	Motion            bool   `json:"motion"`
	RetainDays        int    `json:"retain_days"`
	MotionSensitivity int    `json:"motion_sensitivity"` // 1..100, higher = more sensitive
	MotionMasks       []Rect `json:"motion_masks"`
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
	ClipRetentionDays int `json:"clip_retention_days"`
}

func defaultSettings() Settings {
	return Settings{
		Cameras:            []Camera{},
		MinFreeGB:          10,
		NotifyAfterMinutes: 5,
		QuietWindows:       []string{},
		MQTTEnabled:        true,
		ClipRetentionDays:  30,
	}
}

var (
	idRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,31}$`)
	windowRe = regexp.MustCompile(`^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$`)
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
		if c.MotionSensitivity < 1 || c.MotionSensitivity > 100 {
			c.MotionSensitivity = 50
		}
		if c.MotionMasks == nil {
			c.MotionMasks = []Rect{}
		}
	}
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
