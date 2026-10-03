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

func TestCatNearby(t *testing.T) {
	cat := Rect{X: 0.25, Y: 0.42, W: 0.07, H: 0.1} // last seen walking
	weak := []Detection{
		{Label: "person", Score: 0.4, Box: Rect{X: 0.3, Y: 0.4, W: 0.25, H: 0.5}},    // a person: too big
		{Label: "person", Score: 0.4, Box: Rect{X: 0.37, Y: 0.79, W: 0.09, H: 0.17}}, // the cat by the door, called a person
	}
	if got := catNearby(weak, cat, 0.2); len(got) != 0 {
		t.Errorf("just after, the door is out of reach: %v", got)
	}
	if got := catNearby(weak, cat, 0.2+0.08*10); len(got) != 1 || got[0].Box.X != 0.37 {
		t.Errorf("10 s later it's in reach: %v", got)
	}
}

func TestCatPatch(t *testing.T) {
	floor := make([]byte, patchW*patchH)
	for i := range floor {
		floor[i] = byte(100 + i%7*10) // tiles
	}
	withCat := append([]byte(nil), floor...)
	box := Rect{X: 0.4, Y: 0.5, W: 0.1, H: 0.2}
	for y := patchH * 55 / 100; y < patchH*65/100; y++ {
		for x := patchW * 42 / 100; x < patchW*48/100; x++ {
			withCat[y*patchW+x] = 240
		}
	}
	empty, cat := catPatch(floor, box), catPatch(withCat, box)
	if sim, diff := patchSim(empty, empty); sim < 0.99 || diff != 0 {
		t.Errorf("same patch: %.2f %.1f", sim, diff)
	}
	if sim, diff := patchSim(cat, empty); sim >= stillMaxEmptySim || diff < stillMinDiff {
		t.Errorf("cat vs empty floor: %.2f %.1f", sim, diff)
	}
}
