package main

import (
	"context"
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
	today := []bodyRef{{person: "mom", t: 0, night: true, v: unitVec(2)}}
	if p, _, _ := decideWho(unitVec(2), 1000, false, nil, nil, today); p != "" {
		t.Fatal("matched an IR outfit in daylight")
	}
	if p, by, _ := decideWho(unitVec(2), 1000, true, nil, nil, today); p != "mom" || by != "outfit" {
		t.Fatalf("got %q %q", p, by)
	}
}

func TestDecideOutfitAcrossMidnight(t *testing.T) {
	at := time.Date(2026, 10, 11, 23, 5, 0, 0, time.Local).UnixMilli()
	today := []bodyRef{{person: "mom", t: at - 35*60*1000, night: true, v: unitVec(2)}}     // 22:30
	if p, _, _ := decideWho(unitVec(2), at+90*60*1000, true, nil, nil, today); p != "mom" { // 00:35
		t.Fatal("outfit memory must use time, not the calendar day")
	}
	if p, _, _ := decideWho(unitVec(2), at+13*3600*1000, true, nil, nil, today); p != "" {
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
