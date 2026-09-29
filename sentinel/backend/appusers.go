package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

// Accounts for the Sentinel app. Admins create them on the Settings page; every phone
// that logs in gets its own session token, which can be revoked on its own.

type AppUser struct {
	ID        string   `json:"id"`
	Username  string   `json:"username"`
	Name      string   `json:"name"`
	Admin     bool     `json:"admin"`
	Cameras   []string `json:"cameras"` // empty: all cameras
	Disabled  bool     `json:"disabled"`
	Created   int64    `json:"created"`
	LastLogin int64    `json:"last_login"`
	PassHash  string   `json:"pass_hash,omitempty"`
}

// CanSee reports whether the user may view a camera.
func (u *AppUser) CanSee(cam string) bool {
	return u.Admin || len(u.Cameras) == 0 || slices.Contains(u.Cameras, cam)
}

func (u AppUser) public() AppUser {
	u.PassHash = ""
	if u.Cameras == nil {
		u.Cameras = []string{}
	}
	return u
}

type AppSession struct {
	ID        string `json:"id"`
	TokenHash string `json:"token_hash,omitempty"`
	UserID    string `json:"user_id"`
	Device    string `json:"device"`
	Created   int64  `json:"created"`
	LastSeen  int64  `json:"last_seen"`
	Addr      string `json:"addr"`
	Via       string `json:"via"`                  // "home" or "internet", on the last request
	PushToken string `json:"push_token,omitempty"` // Firebase token for notifications
}

type userFile struct {
	Users    []AppUser    `json:"users"`
	Sessions []AppSession `json:"sessions"`
}

type UserStore struct {
	path  string
	mu    sync.Mutex
	data  userFile
	dirty time.Time // last unsaved change to last-seen times
	fails map[string]*loginFails
}

type loginFails struct {
	n     int
	until time.Time
}

func openUserStore(path string) *UserStore {
	s := &UserStore{path: path, fails: map[string]*loginFails{}}
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, &s.data); err != nil {
			logf("app users: %s is damaged: %v", path, err)
		}
	}
	return s
}

func (s *UserStore) saveLocked() error {
	b, _ := json.MarshalIndent(s.data, "", "  ")
	s.dirty = time.Time{}
	return writeFileAtomic(s.path, b, 0o600)
}

func randID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Passwords: argon2id, about 0.1 s on a Raspberry Pi 5.
func hashPassword(pw string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	h := argon2.IDKey([]byte(pw), salt, 2, 32*1024, 2, 32)
	return "argon2id$2$32768$2$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(h)
}

func checkPassword(hash, pw string) bool {
	var t, m uint32
	var p uint8
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[0] != "argon2id" {
		return false
	}
	if _, err := fmt.Sscanf(parts[1]+" "+parts[2]+" "+parts[3], "%d %d %d", &t, &m, &p); err != nil {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func tokenHash(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(h[:])
}

var usernameRe = regexp.MustCompile(`^[a-z0-9._-]{2,32}$`)

type UserInput struct {
	Username *string   `json:"username"`
	Name     *string   `json:"name"`
	Password *string   `json:"password"`
	Admin    *bool     `json:"admin"`
	Cameras  *[]string `json:"cameras"`
	Disabled *bool     `json:"disabled"`
}

func (s *UserStore) List() []AppUser {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AppUser, 0, len(s.data.Users))
	for _, u := range s.data.Users {
		out = append(out, u.public())
	}
	return out
}

func (s *UserStore) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.data.Users)
}

func (s *UserStore) apply(u *AppUser, in UserInput, creating bool) error {
	if in.Username != nil {
		name := strings.ToLower(strings.TrimSpace(*in.Username))
		if !usernameRe.MatchString(name) {
			return errors.New("usernames are 2–32 characters: letters, digits, dot, dash or underscore")
		}
		for _, o := range s.data.Users {
			if o.Username == name && o.ID != u.ID {
				return errors.New("that username is taken")
			}
		}
		u.Username = name
	} else if creating {
		return errors.New("a username is needed")
	}
	if in.Name != nil {
		u.Name = strings.TrimSpace(*in.Name)
		if len(u.Name) > 64 {
			u.Name = u.Name[:64]
		}
	}
	if in.Password != nil {
		if len(*in.Password) < 8 {
			return errors.New("passwords need at least 8 characters")
		}
		u.PassHash = hashPassword(*in.Password)
	} else if creating {
		return errors.New("a password is needed")
	}
	if in.Admin != nil {
		u.Admin = *in.Admin
	}
	if in.Cameras != nil {
		u.Cameras = slices.Clone(*in.Cameras)
	}
	if in.Disabled != nil {
		u.Disabled = *in.Disabled
	}
	return nil
}

func (s *UserStore) Create(in UserInput) (AppUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := AppUser{ID: randID(6), Created: time.Now().UnixMilli()}
	if err := s.apply(&u, in, true); err != nil {
		return AppUser{}, err
	}
	s.data.Users = append(s.data.Users, u)
	return u.public(), s.saveLocked()
}

// Update changes a user. A new password or disabling the account signs out all of
// that user's phones.
func (s *UserStore) Update(id string, in UserInput) (AppUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.data.Users, func(u AppUser) bool { return u.ID == id })
	if i < 0 {
		return AppUser{}, errors.New("user not found")
	}
	u := s.data.Users[i]
	if err := s.apply(&u, in, false); err != nil {
		return AppUser{}, err
	}
	s.data.Users[i] = u
	if in.Password != nil || u.Disabled {
		s.data.Sessions = slices.DeleteFunc(s.data.Sessions, func(x AppSession) bool { return x.UserID == id })
	}
	return u.public(), s.saveLocked()
}

func (s *UserStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.data.Users)
	s.data.Users = slices.DeleteFunc(s.data.Users, func(u AppUser) bool { return u.ID == id })
	if len(s.data.Users) == n {
		return errors.New("user not found")
	}
	s.data.Sessions = slices.DeleteFunc(s.data.Sessions, func(x AppSession) bool { return x.UserID == id })
	return s.saveLocked()
}

// Login checks a password and starts a session. Wrong passwords lock the username for
// a growing time after 5 tries, so passwords can't be guessed from the internet.
func (s *UserStore) Login(username, password, device, addr string) (string, AppUser, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	s.mu.Lock()
	f := s.fails[username]
	if f != nil && time.Now().Before(f.until) {
		wait := time.Until(f.until).Round(time.Second)
		s.mu.Unlock()
		return "", AppUser{}, fmt.Errorf("too many wrong passwords: try again in %s", wait)
	}
	var user *AppUser
	for i := range s.data.Users {
		if s.data.Users[i].Username == username {
			user = &s.data.Users[i]
		}
	}
	hash := "argon2id$2$32768$2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if user != nil {
		hash = user.PassHash
	}
	s.mu.Unlock()
	ok := checkPassword(hash, password) && user != nil // same time whether the user exists or not
	s.mu.Lock()
	defer s.mu.Unlock()
	if !ok {
		if f == nil {
			f = &loginFails{}
			s.fails[username] = f
		}
		f.n++
		if f.n >= 5 {
			f.until = time.Now().Add(min(time.Minute<<(f.n-5), time.Hour))
		}
		return "", AppUser{}, errors.New("wrong username or password")
	}
	delete(s.fails, username)
	if user.Disabled {
		return "", AppUser{}, errors.New("this account is switched off")
	}
	tok := randID(32)
	now := time.Now().UnixMilli()
	if len(device) > 64 {
		device = device[:64]
	}
	user.LastLogin = now
	s.data.Sessions = append(s.data.Sessions, AppSession{ID: randID(6), TokenHash: tokenHash(tok), UserID: user.ID, Device: device, Created: now, LastSeen: now, Addr: addr})
	return tok, user.public(), s.saveLocked()
}

// Auth returns the user and session for a token.
func (s *UserStore) Auth(tok, addr, via string) (*AppUser, string, bool) {
	if tok == "" {
		return nil, "", false
	}
	h := tokenHash(tok)
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Sessions {
		se := &s.data.Sessions[i]
		if subtle.ConstantTimeCompare([]byte(se.TokenHash), []byte(h)) != 1 {
			continue
		}
		for _, u := range s.data.Users {
			if u.ID == se.UserID && !u.Disabled {
				now := time.Now()
				if now.UnixMilli()-se.LastSeen > 60_000 || se.Addr != addr {
					se.LastSeen, se.Addr, se.Via = now.UnixMilli(), addr, via
					if s.dirty.IsZero() {
						s.dirty = now
					}
					if now.Sub(s.dirty) > 5*time.Minute {
						s.saveLocked()
					}
				}
				u := u
				return &u, se.ID, true
			}
		}
		return nil, "", false
	}
	return nil, "", false
}

func (s *UserStore) Logout(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Sessions = slices.DeleteFunc(s.data.Sessions, func(x AppSession) bool { return x.ID == sessionID })
	s.saveLocked()
}

func (s *UserStore) SetPushToken(sessionID, token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Sessions {
		if s.data.Sessions[i].ID == sessionID {
			s.data.Sessions[i].PushToken = token
		}
	}
	s.saveLocked()
}

type SessionView struct {
	AppSession
	Username string `json:"username"`
	Push     bool   `json:"push"`
}

func (s *UserStore) Sessions() []SessionView {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []SessionView{}
	for _, se := range s.data.Sessions {
		v := SessionView{AppSession: se, Push: se.PushToken != ""}
		v.TokenHash, v.PushToken = "", ""
		for _, u := range s.data.Users {
			if u.ID == se.UserID {
				v.Username = u.Username
			}
		}
		out = append(out, v)
	}
	return out
}

// PushTargets lists the notification tokens of users who may see a camera.
func (s *UserStore) PushTargets(cam string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, se := range s.data.Sessions {
		if se.PushToken == "" {
			continue
		}
		for _, u := range s.data.Users {
			if u.ID == se.UserID && !u.Disabled && (cam == "" || u.CanSee(cam)) {
				out = append(out, se.PushToken)
			}
		}
	}
	return out
}

func (s *UserStore) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty.IsZero() {
		s.saveLocked()
	}
}
