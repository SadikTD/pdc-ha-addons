package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppUsersAndAccess(t *testing.T) {
	s := openUserStore(filepath.Join(t.TempDir(), "users.json"))
	pw, cams := "correct horse", []string{"door"}
	name := "Viewer"
	if _, err := s.Create(UserInput{Username: &name, Password: &pw, Cameras: &cams}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Login("viewer", "wrong", "phone", "1.2.3.4:5"); err == nil {
		t.Fatal("wrong password accepted")
	}
	tok, u, err := s.Login("VIEWER", pw, "phone", "1.2.3.4:5")
	if err != nil || u.Username != "viewer" {
		t.Fatalf("login: %v", err)
	}
	au, sid, ok := s.Auth(tok, "1.2.3.4:5", "internet")
	if !ok || sid == "" || au.Username != "viewer" {
		t.Fatal("token not accepted")
	}
	if _, _, ok := s.Auth(tok+"x", "", ""); ok {
		t.Fatal("bad token accepted")
	}
	// Lockout after 5 wrong passwords, even for the right one.
	for range 5 {
		s.Login("viewer", "nope", "", "")
	}
	if _, _, err := s.Login("viewer", pw, "", ""); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("expected lockout, got %v", err)
	}

	rm := &Remote{app: &App{}}
	cases := []struct {
		method, url string
		want        bool
	}{
		{"GET", "/api/status", true},
		{"GET", "/api/settings", false},
		{"PUT", "/api/settings", false},
		{"GET", "/api/cameras/door/snapshot.jpg", true},
		{"GET", "/api/cameras/yard/snapshot.jpg", false},
		{"GET", "/api/vod.m3u8?camera=door", true},
		{"GET", "/api/vod.m3u8?camera=yard", false},
		{"GET", "/api/seg/yard/123", false},
		{"GET", "/api/preview/door/123.jpg", true},
		{"GET", "/go2rtc/api/stream.mp4?src=door_sub", true},
		{"GET", "/go2rtc/api/stream.mp4?src=yard", false},
		{"GET", "/go2rtc/api/config", false},
		{"POST", "/api/cameras/door/restart", false},
		{"GET", "/api/incidents", false},
		{"DELETE", "/api/recordings/door", false},
	}
	for _, c := range cases {
		if got := rm.allowed(au, httptest.NewRequest(c.method, c.url, nil)); got != c.want {
			t.Errorf("%s %s: allowed=%v, want %v", c.method, c.url, got, c.want)
		}
	}
	admin := &AppUser{Admin: true}
	if !rm.allowed(admin, httptest.NewRequest("POST", "/api/cameras/yard/restart", nil)) || rm.allowed(admin, httptest.NewRequest("GET", "/api/settings", nil)) {
		t.Error("admin rules wrong")
	}
}
