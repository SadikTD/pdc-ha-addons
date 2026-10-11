package main

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"
)

func unitVec(i int) []float32 { v := make([]float32, 4); v[i] = 1; return v }

func TestDecideSureFromLongGallery(t *testing.T) {
	long := []bodyRef{{person: "dad", v: unitVec(0)}, {person: "mom", v: unitVec(1)}}
	if p, by, _ := decideWho(unitVec(0), 0, false, nil, long, nil); p != "dad" || by != "sure" {
		t.Fatalf("got %q %q", p, by)
	}
}

func TestDecideRespectsNot(t *testing.T) {
	long := []bodyRef{{person: "dad", v: unitVec(0)}}
	today := []bodyRef{{person: "dad", v: unitVec(0)}}
	if p, _, _ := decideWho(unitVec(0), 0, false, []string{"dad"}, long, today); p != "" {
		t.Fatalf("named %q although the user said it isn't", p)
	}
}

func TestDecideOutfitSameLightOnly(t *testing.T) {
	today := []bodyRef{{person: "mom", t: 0, night: true, v: unitVec(2)}, {person: "dad", t: 0, v: unitVec(1)}}
	if p, _, _ := decideWho(unitVec(2), 1000, false, nil, nil, today); p != "" {
		t.Fatal("matched an IR outfit in daylight")
	}
	if p, by, _ := decideWho(unitVec(1), 1000, false, nil, nil, today); p != "dad" || by != "outfit" {
		t.Fatalf("got %q %q", p, by)
	}
}

func TestDecideNoOutfitAtNight(t *testing.T) {
	// At night the outfit memory is often one person: a stranger in infrared would
	// "clearly" match them. Until night is measured, no naming by outfit at night.
	today := []bodyRef{{person: "dad", t: 0, night: true, v: unitVec(2)}}
	if p, _, _ := decideWho(unitVec(2), 1000, true, nil, nil, today); p != "" {
		t.Fatalf("named %q by an infrared outfit", p)
	}
}

func TestEventPeopleSameNameTwoBoxes(t *testing.T) {
	ss := []*Seen{{T: 0, Box: Rect{X: .05, Y: .1, W: .2, H: .6}, Person: "dad", By: "outfit"},
		{T: 0, Box: Rect{X: .6, Y: .1, W: .2, H: .6}, Person: "dad", By: "sure"}}
	if got := eventPeople(ss); len(got) != 0 {
		t.Fatalf("two people at once can't both be Dad, got %v", got)
	}
	ss[1].By = "you" // the user's own name stands
	if got := eventPeople(ss); !slices.Equal(got, []string{"dad"}) {
		t.Fatalf("got %v", got)
	}
}

func TestNameBodyOnlySighting(t *testing.T) {
	f := &Faces{people: []Person{{ID: "dad", Name: "Dad"}}, seen: map[string]*Seen{"a": {ID: "a", T: 1, body: unitVec(0)}}, dirty: map[string]bool{}, whoQ: map[EventKey][]Who{}}
	p, err := f.Name([]string{"a"}, "dad", "")
	if err != nil || f.seen["a"].Person != p.ID || f.seen["a"].By != "you" {
		t.Fatalf("naming a sighting without a face did nothing: %+v %v", f.seen["a"], err)
	}
	if got := f.PersonFaces(p.ID, 10); len(got) != 1 {
		t.Fatalf("a person's page must list sightings without a face (to correct them), got %d", len(got))
	}
}

func TestAlertNamesTimeout(t *testing.T) {
	began := time.Now()
	got := namesWithin(50*time.Millisecond, "Person", func() []string { time.Sleep(time.Second); return []string{"Dad"} })
	if got != nil || time.Since(began) > 500*time.Millisecond {
		t.Fatalf("alert waited %v for names %v", time.Since(began), got)
	}
	if got := namesWithin(time.Second, "Person", func() []string { return []string{"Dad"} }); !slices.Equal(got, []string{"Dad"}) {
		t.Fatalf("got %v", got)
	}
	if got := namesWithin(time.Second, "Cat", func() []string { t.Fatal("no names for cats"); return nil }); got != nil {
		t.Fatal(got)
	}
}

func TestDecideOutfitAcrossMidnight(t *testing.T) {
	at := time.Date(2026, 10, 11, 23, 5, 0, 0, time.Local).UnixMilli()
	today := []bodyRef{{person: "mom", t: at - 35*60*1000, v: unitVec(2)}}                   // 22:30
	if p, _, _ := decideWho(unitVec(2), at+90*60*1000, false, nil, nil, today); p != "mom" { // 00:35
		t.Fatal("outfit memory must use time, not the calendar day")
	}
	if p, _, _ := decideWho(unitVec(2), at+13*3600*1000, false, nil, nil, today); p != "" {
		t.Fatal("outfit memory must expire after outfitWindow")
	}
}

func TestDecideAmbiguousAbstains(t *testing.T) {
	long := []bodyRef{{person: "a", v: unitVec(0)}, {person: "b", v: unitVec(0)}}
	if p, _, _ := decideWho(unitVec(0), 0, false, nil, long, nil); p != "" {
		t.Fatal("two equally alike people must give no name")
	}
}

func TestEventPeopleConflictCancels(t *testing.T) {
	box := Rect{X: .1, Y: .1, W: .2, H: .6}
	ss := []*Seen{{T: 0, Box: box, Person: "dad", By: "sure"}, {T: 1000, Box: box, Person: "uncle", By: "outfit"}}
	if got := eventPeople(ss); len(got) != 0 {
		t.Fatalf("conflicting names on one person kept: %v", got)
	}
}

func TestEventPeopleTwoApart(t *testing.T) {
	ss := []*Seen{{T: 0, Box: Rect{X: .05, Y: .1, W: .2, H: .6}, Person: "dad", By: "sure"},
		{T: 0, Box: Rect{X: .6, Y: .1, W: .2, H: .6}, Person: "mom", By: "sure"}}
	if got := eventPeople(ss); !slices.Equal(got, []string{"dad", "mom"}) {
		t.Fatalf("got %v", got)
	}
}

func TestEventPeopleUserWins(t *testing.T) {
	box := Rect{X: .1, Y: .1, W: .2, H: .6}
	ss := []*Seen{{T: 0, Box: box, Person: "dad", By: "you"}, {T: 500, Box: box, Person: "uncle", By: "outfit"}}
	if got := eventPeople(ss); !slices.Equal(got, []string{"dad"}) {
		t.Fatalf("got %v", got)
	}
}

func TestWhoByLabel(t *testing.T) {
	for by, want := range map[string]string{"you": "face", "face": "face", "sure": "face", "outfit": "clothing"} {
		if got := whoBy(by); got != want {
			t.Fatalf("%s -> %s, want %s", by, got, want)
		}
	}
}

func TestAlertLabel(t *testing.T) {
	cases := []struct {
		what  string
		names []string
		want  string
	}{
		{"Person", nil, "Person"},
		{"Person", []string{"Dad"}, "Dad"},
		{"2 people", []string{"Dad", "Mom"}, "Dad, Mom"},
		{"2 people", []string{"Dad"}, "Dad + 1 more"},
		{"Cat", []string{"Dad"}, "Cat"},
	}
	for _, c := range cases {
		if got := alertLabel(c.what, c.names); got != c.want {
			t.Errorf("alertLabel(%q, %v) = %q, want %q", c.what, c.names, got, c.want)
		}
	}
}

func TestWhoAtNoModel(t *testing.T) {
	f := &Faces{app: &App{detector: &Detector{model: "/nonexistent/yolox_s.onnx"}}}
	if got := f.WhoAt(context.Background(), "x", time.Now()); got != nil {
		t.Fatalf("no model must give no names, got %v", got)
	}
}

func TestLoadWhoGallery(t *testing.T) {
	p := t.TempDir() + "/who_gallery.json"
	if g := loadWhoGallery(p); g != nil {
		t.Fatal("no file must give no gallery")
	}
	if err := os.WriteFile(p, []byte(`[{"person":"dad","night":true,"emb":"`+encodeVec(unitVec(1))+`"},{"person":"x","emb":"bad"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	g := loadWhoGallery(p)
	if len(g) != 1 || g[0].person != "dad" || !g[0].night || g[0].v[1] != 1 {
		t.Fatalf("got %+v", g)
	}
}

func TestFaceEmbedderFromModels(t *testing.T) {
	dir := t.TempDir()
	if got := faceEmbedderIn(dir); got != "" {
		t.Fatalf("no file: got %q", got)
	}
	if err := os.WriteFile(dir+"/face_r50.onnx", []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := faceEmbedderIn(dir); got != "r50" {
		t.Fatalf("got %q", got)
	}
}

func TestOldFingerprintsAreNotCompared(t *testing.T) {
	old := faceEmbedder
	defer func() { faceEmbedder = old }()
	faceEmbedder = "r50"
	if (&Seen{emb: unitVec(0)}).hasFace() {
		t.Fatal("a MobileFaceNet fingerprint must not be compared with R50 ones")
	}
	if !(&Seen{emb: unitVec(0), EmbBy: "r50"}).hasFace() {
		t.Fatal("current fingerprint ignored")
	}
}

func TestThumbFace(t *testing.T) {
	row := func(score, x float64) []float64 {
		r := make([]float64, 17+4)
		r[0], r[1], r[2], r[3], r[4] = score, x, 0.25, 0.4, 0.5
		r[17] = 1
		return r
	}
	// The thumbnail is centred on the face: the centred face wins over a sharper edge one.
	if v := thumbFace([][]float64{row(0.95, 0.0), row(0.8, 0.3)}); v == nil || len(v) != 4 {
		t.Fatal("no face picked")
	}
	if v := thumbFace([][]float64{row(0.95, 0.0)}); v != nil {
		t.Fatal("a face at the edge of the thumbnail isn't the person's")
	}
	if thumbFace(nil) != nil {
		t.Fatal("nothing found must give nil")
	}
}
