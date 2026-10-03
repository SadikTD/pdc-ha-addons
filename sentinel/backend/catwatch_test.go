package main

import (
	"testing"
	"time"
)

func TestCatRegions(t *testing.T) {
	for _, aspect := range []float64{16.0 / 9, 4.0 / 3, 2, 32.0 / 9} {
		rs := catRegions(aspect)
		if len(rs) < 2 {
			t.Fatalf("aspect %.2f: %d regions", aspect, len(rs))
		}
		// Covers the frame, with overlap, each part about square in pixels.
		if rs[0].X != 0 || rs[len(rs)-1].X+rs[len(rs)-1].W < 0.999 {
			t.Errorf("aspect %.2f: %v doesn't cover the frame", aspect, rs)
		}
		for i, r := range rs {
			if px := r.W * aspect / r.H; px < 0.9 || px > 1.4 {
				t.Errorf("aspect %.2f: region %v is %.2f:1", aspect, r, px)
			}
			if i > 0 && rs[i-1].X+rs[i-1].W <= r.X+0.05 {
				t.Errorf("aspect %.2f: regions %v and %v barely overlap", aspect, rs[i-1], r)
			}
		}
	}
	if rs := catRegions(1); len(rs) != 1 || rs[0] != fullFrame {
		t.Errorf("square frame: %v", rs)
	}
}

func TestFmtStay(t *testing.T) {
	for d, want := range map[time.Duration]string{
		5 * time.Second: "5 s", 90 * time.Second: "1 min 30 s", 10 * time.Minute: "10 min", 75 * time.Minute: "1 h 15 min",
	} {
		if got := fmtStay(d); got != want {
			t.Errorf("fmtStay(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestCatWatchSettings(t *testing.T) {
	s := defaultSettings()
	s.CatWatch.Enabled = true
	if err := s.normalize(); err == nil {
		t.Error("enabled without a camera should be refused")
	}
	s.CatWatch.Cameras = []string{"floor3_cam"}
	s.CatWatch.RepeatSeconds = 2
	s.CatWatch.Hours = "18:00 - 08:00"
	if err := s.normalize(); err != nil {
		t.Fatal(err)
	}
	if s.CatWatch.RepeatSeconds != 10 || s.CatWatch.Hours != "18:00-08:00" || s.CatWatch.SlowSeconds < 10 {
		t.Errorf("normalised badly: %+v", s.CatWatch)
	}
	s.CatWatch.AlexaEntity = "light.kitchen"
	if err := s.normalize(); err == nil {
		t.Error("a non-media_player Echo should be refused")
	}
}
