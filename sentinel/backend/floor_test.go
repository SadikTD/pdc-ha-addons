package main

import (
	"testing"
	"time"
)

// A full disk removes plain footage first, then motion only, then footage with people,
// oldest first within each.
func TestFloorOrder(t *testing.T) {
	st := newStore(t.TempDir(), newClock(), nil)
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	add := func(id string, min int) {
		st.insert(&Segment{ID: id, Cam: "cam", Raw: base.Add(time.Duration(min) * time.Minute), DurMs: 60_000})
	}
	add("person-old", 0)
	add("motion-old", 1)
	add("plain-old", 2)
	add("person-new", 3)
	add("plain-new", 4)
	add("motion-new", 5)
	span := func(min int) Span {
		s := base.Add(time.Duration(min)*time.Minute + 20*time.Second).UnixMilli()
		return Span{s, s + 5000}
	}
	people := map[string][]Span{"cam": {span(0), span(3)}}
	motion := map[string][]Span{"cam": {span(0), span(1), span(3), span(5)}}
	var got []string
	for _, s := range st.floorOrder(motion, people) {
		got = append(got, s.ID)
	}
	want := []string{"plain-old", "plain-new", "motion-old", "motion-new", "person-old", "person-new"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
