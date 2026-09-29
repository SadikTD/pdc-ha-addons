package main

import (
	"slices"
	"testing"
	"time"
)

func TestParseSearch(t *testing.T) {
	loc := time.FixedZone("BD", 6*3600)
	now := time.Date(2026, 9, 29, 15, 30, 0, 0, loc) // a Tuesday
	cams := []Camera{
		{ID: "outdoor_cam", Name: "Drawing Room"}, {ID: "roof_cam", Name: "Roof"}, {ID: "floor3_cam", Name: "3rd Floor"},
		{ID: "ground_floor", Name: "Ground Floor"}, {ID: "2nd_floor", Name: "2nd Floor"}, {ID: "outdoor_1", Name: "Outdoor 1"},
		{ID: "outdoor_2", Name: "Outdoor 2"}, {ID: "shop", Name: "Shop"},
	}
	at := func(d, h, m int) int64 { return time.Date(2026, 9, d, h, m, 0, 0, loc).UnixMilli() }
	tests := []struct {
		q              string
		labels         []string
		cams           []string
		from, to       int64
		dayFrom, dayTo int
	}{
		{"person on the roof last night", []string{"person"}, []string{"roof_cam"}, at(28, 18, 0), at(29, 7, 0), -1, -1},
		{"cats yesterday after 10pm", []string{"cat"}, nil, at(28, 0, 0), at(29, 0, 0), 22 * 60, 24 * 60},
		{"Dog, ground floor, this morning?", []string{"dog"}, []string{"ground_floor"}, at(29, 5, 0), at(29, 12, 0), -1, -1},
		{"people 2 days ago between 1 and 4am", []string{"person"}, nil, at(27, 0, 0), at(28, 0, 0), 60, 4 * 60},
		{"animals in the drawing room today", []string{"cat", "dog"}, []string{"outdoor_cam"}, at(29, 0, 0), at(30, 0, 0), -1, -1},
		{"someone at 3rd floor between 10pm and 2am", []string{"person"}, []string{"floor3_cam"}, 0, 0, 22 * 60, 2 * 60},
		{"outdoor 2 sunday", nil, []string{"outdoor_2"}, at(27, 0, 0), at(28, 0, 0), -1, -1},
		{"people 27 sep", []string{"person"}, nil, at(27, 0, 0), at(28, 0, 0), -1, -1},
		{"last 3 hours", nil, nil, now.Add(-3 * time.Hour).UnixMilli(), now.UnixMilli(), -1, -1},
		{"person at night", []string{"person"}, nil, 0, 0, 21 * 60, 6 * 60},
	}
	for _, tc := range tests {
		q := ParseSearch(tc.q, now, cams, nil)
		if !slices.Equal(q.Labels, tc.labels) && !(len(q.Labels) == 0 && len(tc.labels) == 0) {
			t.Errorf("%q: labels %v, want %v", tc.q, q.Labels, tc.labels)
		}
		if !slices.Equal(q.Cameras, tc.cams) && !(len(q.Cameras) == 0 && len(tc.cams) == 0) {
			t.Errorf("%q: cameras %v, want %v", tc.q, q.Cameras, tc.cams)
		}
		if tc.from != 0 && (q.From != tc.from || q.To != tc.to) {
			t.Errorf("%q: range %v – %v, want %v – %v", tc.q, time.UnixMilli(q.From).In(loc), time.UnixMilli(q.To).In(loc), time.UnixMilli(tc.from).In(loc), time.UnixMilli(tc.to).In(loc))
		}
		if q.DayFrom != tc.dayFrom || q.DayTo != tc.dayTo {
			t.Errorf("%q: time of day %d–%d, want %d–%d", tc.q, q.DayFrom, q.DayTo, tc.dayFrom, tc.dayTo)
		}
		t.Logf("%q → %v", tc.q, q.Chips)
	}
}

func TestSearchMatchTimeOfDay(t *testing.T) {
	q := SearchQuery{Labels: []string{"person"}, DayFrom: 22 * 60, DayTo: 2 * 60}
	mk := func(h int, labels ...string) *Event {
		return &Event{Start: time.Date(2026, 9, 29, h, 0, 0, 0, time.Local).UnixMilli(), Labels: labels, Scan: "done"}
	}
	if !q.Match(mk(23, "person")) || !q.Match(mk(1, "person")) {
		t.Error("should match inside a window across midnight")
	}
	if q.Match(mk(12, "person")) || q.Match(mk(23, "cat")) {
		t.Error("should not match outside the window or another label")
	}
	if !(SearchQuery{Motion: true, DayFrom: -1}).Match(&Event{Scan: "done"}) || (SearchQuery{Motion: true, DayFrom: -1}).Match(&Event{Scan: ""}) {
		t.Error("plain motion: only checked events without labels")
	}
}

func TestVerifyRect(t *testing.T) {
	r := verifyRect(Rect{X: 0.9, Y: 0.9, W: 0.05, H: 0.08}, 16.0/9)
	if r.X+r.W > 1.0001 || r.Y+r.H > 1.0001 || r.X < 0 || r.Y < 0 {
		t.Fatalf("out of frame: %+v", r)
	}
	if r.H < 0.35-1e-9 {
		t.Errorf("too small: %+v", r)
	}
}

func TestParseSearchPeople(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.Local)
	people := []Person{{ID: "p1", Name: "Abir"}, {ID: "p2", Name: "Big Mom"}}
	q := ParseSearch("abir yesterday", now, nil, people)
	if len(q.People) != 1 || q.People[0] != "p1" || q.Chips[0] != "Abir" {
		t.Fatalf("abir: %+v", q)
	}
	q = ParseSearch("big mom on the roof", now, []Camera{{ID: "roof_cam", Name: "Roof"}}, people)
	if len(q.People) != 1 || q.People[0] != "p2" || len(q.Cameras) != 1 {
		t.Fatalf("big mom: %+v", q)
	}
	e := &Event{Who: []Who{{Person: "p2", Name: "Big Mom", By: "face"}}}
	if !q.Match(e) || (SearchQuery{People: []string{"p1"}, DayFrom: -1}).Match(e) {
		t.Fatal("match by person")
	}
}
