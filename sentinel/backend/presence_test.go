package main

import (
	"testing"
	"time"
)

func TestPresence(t *testing.T) {
	es := newEventStore(t.TempDir())
	day := time.Now().Add(-24 * time.Hour).Truncate(24 * time.Hour)
	at := func(h, m int) int64 {
		return day.Add(time.Duration(h)*time.Hour + time.Duration(m)*time.Minute).UnixMilli()
	}
	add := func(cam string, start int64, by string) {
		es.events[cam] = append(es.events[cam], &Event{ID: cam + time.UnixMilli(start).Format("1504"), Cam: cam, Start: start, End: start + 20_000,
			Who: []Who{{Person: "dad", Name: "Dad", By: by}}})
	}
	add("stairs", at(8, 0), "face")    // home in the morning
	add("gate", at(9, 0), "face")      // out through the gate...
	add("gate", at(12, 0), "clothing") // ...back at noon
	add("stairs", at(12, 5), "face")
	add("stairs", at(23, 0), "face") // bed: not seen all night, last seen inside
	add("stairs", at(31, 0), "face") // next morning
	a := &App{events: es, faces: &Faces{people: []Person{{ID: "dad", Name: "Dad"}}, seen: map[string]*Seen{}}}
	pr := Presence{Entrances: []string{"gate"}, AwayMinutes: 45, ArriveOn: "any", Clothing: true}

	entries, now := a.presence(pr, at(0, 0), at(40, 0))
	if len(entries) != 2 {
		t.Fatalf("want 2 entries, got %+v", entries)
	}
	back, out := entries[0], entries[1]
	if out.Kind != "left" || out.T != at(9, 0)+20_000 || out.Cam != "gate" {
		t.Errorf("left: %+v", out)
	}
	if back.Kind != "arrived" || back.T != at(12, 0) || back.For < 2*3600_000 {
		t.Errorf("arrived: %+v", back)
	}
	if len(now) != 1 || now[0].State != "home" {
		t.Errorf("now: %+v", now)
	}

	// Clothing sightings off: noon (clothing) doesn't count; back at 12:05 instead.
	pr.Clothing = false
	entries, _ = a.presence(pr, at(0, 0), at(40, 0))
	if len(entries) != 2 || entries[0].T != at(12, 5) {
		t.Errorf("without clothing: %+v", entries)
	}
	// Arrivals only at an entrance: 12:05 on the stairs isn't one (home, not logged).
	pr.ArriveOn = "entrance"
	entries, _ = a.presence(pr, at(0, 0), at(40, 0))
	if len(entries) != 1 || entries[0].Kind != "left" {
		t.Errorf("entrance-only arrivals: %+v", entries)
	}
	// Only someone else is logged: nothing.
	pr.People = []string{"mom"}
	if entries, _ = a.presence(pr, at(0, 0), at(40, 0)); len(entries) != 0 {
		t.Errorf("filtered people: %+v", entries)
	}
}
