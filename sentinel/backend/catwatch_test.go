package main

import (
	"slices"
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
	if got := catNearby(weak, cat, cat.W*cat.H, 0.2); len(got) != 0 {
		t.Errorf("just after, the door is out of reach: %v", got)
	}
	if got := catNearby(weak, cat, cat.W*cat.H, 0.2+0.08*10); len(got) != 1 || got[0].Box.X != 0.37 {
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

func TestCatBlob(t *testing.T) {
	floor := make([]byte, patchW*patchH)
	for i := range floor {
		floor[i] = byte(120 + i%5*4)
	}
	put := func(g []byte, r Rect, v byte) {
		for y := int(r.Y * patchH); y < int((r.Y+r.H)*patchH); y++ {
			for x := int(r.X * patchW); x < int((r.X+r.W)*patchW); x++ {
				g[y*patchW+x] = v
			}
		}
	}
	slippers := Rect{X: 0.47, Y: 0.84, W: 0.06, H: 0.05}
	door := Rect{X: 0.36, Y: 0.79, W: 0.07, H: 0.18}
	stairs := Rect{X: 0.14, Y: 0.36, W: 0.08, H: 0.07}
	atDoor := append([]byte(nil), floor...)
	put(atDoor, slippers, 30)
	put(atDoor, door, 240)
	onStairs := append([]byte(nil), floor...)
	put(onStairs, slippers, 30)
	put(onStairs, stairs, 40)

	before := spots(atDoor, floor)
	if len(before) != 2 {
		t.Fatalf("blobs at the door: %v", before)
	}
	// Still at the door.
	if b, ok := catBlob(before, nil, door, door.W*door.H, 0.3, 16.0/9); !ok || overlapOfSmaller(b, door) < 0.5 {
		t.Errorf("at the door: %v %v", b, ok)
	}
	// Walked to the stairs between two looks: the new blob, not the slippers nearby.
	now := spots(onStairs, floor)
	b, ok := catBlob(now, before, door, door.W*door.H, 0.8, 16.0/9)
	if !ok || overlapOfSmaller(b, stairs) < 0.5 {
		t.Errorf("moved to the stairs: %v %v", b, ok)
	}
	// Without knowing the look before, only its own spot counts.
	if b, ok := catBlob(now, nil, door, door.W*door.H, 0.8, 16.0/9); ok {
		t.Errorf("no look before: %v", b)
	}
	// The stairs blob appeared while someone was in view (it's among the old ones).
	if b, ok := catBlob(now, append(slices.Clone(before), now...), door, door.W*door.H, 0.8, 16.0/9); ok {
		t.Errorf("jumped although someone was just in view: %v", b)
	}
}

func TestSpotsIgnoreClockText(t *testing.T) {
	floor := make([]byte, patchW*patchH)
	for i := range floor {
		floor[i] = 120
	}
	g := append([]byte(nil), floor...)
	for y := patchH * 3 / 100; y < patchH*8/100; y++ { // clock digits at the top
		for x := patchW * 20 / 100; x < patchW*30/100; x++ {
			g[y*patchW+x] = 250
		}
	}
	if got := spots(g, floor); len(got) != 0 {
		t.Errorf("the clock text is a spot: %v", got)
	}
}

func TestCatBlobIgnoresSmallLightPatches(t *testing.T) {
	floor := make([]byte, patchW*patchH)
	for i := range floor {
		floor[i] = 120
	}
	g := append([]byte(nil), floor...)
	// A small patch of evening light where the cat was (about 25 points at blob size).
	for y := patchH * 28 / 100; y < patchH*28/100+10; y++ {
		for x := patchW * 17 / 100; x < patchW*17/100+10; x++ {
			g[y*patchW+x] = 160
		}
	}
	cat := Rect{X: 0.15, Y: 0.26, W: 0.06, H: 0.09}
	if b, ok := catBlob(spots(g, floor), nil, cat, 0.016, 0.3, 16.0/9); ok {
		t.Errorf("a patch of light kept the cat: %v", b)
	}
}

func TestCatBlobNotAStandingPerson(t *testing.T) {
	floor := make([]byte, patchW*patchH)
	for i := range floor {
		floor[i] = 120
	}
	g := append([]byte(nil), floor...)
	person := Rect{X: 0.06, Y: 0.11, W: 0.06, H: 0.30} // someone on the stairs
	for y := int(person.Y * patchH); y < int((person.Y+person.H)*patchH); y++ {
		for x := int(person.X * patchW); x < int((person.X+person.W)*patchW); x++ {
			g[y*patchW+x] = 40
		}
	}
	cat := Rect{X: 0.07, Y: 0.20, W: 0.05, H: 0.10}
	if b, ok := catBlob(spots(g, floor), nil, cat, 0.016, 0.5, 16.0/9); ok {
		t.Errorf("a standing person was taken for the cat: %v", b)
	}
}
