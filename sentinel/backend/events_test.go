package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Naming someone changes the people in many events at once: every one must be stored,
// with each day's file written once, and the store usable meanwhile.
func TestSetWhoMany(t *testing.T) {
	dir := t.TempDir()
	es := newEventStore(dir)
	day1 := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC).UnixMilli()
	day2 := day1 + 24*3600*1000
	who := map[EventKey][]Who{}
	for i := 0; i < 300; i++ {
		start := day1 + int64(i)*60_000
		if i >= 150 {
			start = day2 + int64(i)*60_000
		}
		e := &Event{ID: "cam-" + time.UnixMilli(start).Format("150405.000"), Cam: "cam", Start: start, End: start + 10_000}
		es.events["cam"] = append(es.events["cam"], e)
		who[EventKey{"cam", e.ID}] = []Who{{Person: "p1", Name: "Dad", By: "face"}}
	}
	began := time.Now()
	es.SetWhoMany(who)
	es.Flush()
	took := time.Since(began)

	for k := range who {
		e, ok := es.Get(k.Cam, k.ID)
		if !ok || len(e.Who) != 1 || e.Who[0].Name != "Dad" {
			t.Fatalf("event %s: who not stored: %+v", k.ID, e.Who)
		}
	}
	files, _ := filepath.Glob(filepath.Join(dir, "cam", "*.json"))
	if len(files) != 2 {
		t.Fatalf("want 2 day files, got %v", files)
	}
	// Reloading from disk gives the same.
	es2 := newEventStore(dir)
	if n := len(es2.events["cam"]); n != 300 {
		t.Fatalf("reloaded %d events, want 300", n)
	}
	for _, e := range es2.events["cam"] {
		if len(e.Who) != 1 {
			t.Fatalf("reloaded event %s lost who", e.ID)
		}
	}
	// Unchanged: nothing is written again.
	for _, f := range files {
		_ = os.Chtimes(f, time.Unix(0, 0), time.Unix(0, 0))
	}
	es.SetWhoMany(who)
	es.Flush()
	for _, f := range files {
		if st, _ := os.Stat(f); st.ModTime().Unix() != 0 {
			t.Fatalf("%s rewritten although nothing changed", f)
		}
	}
	t.Logf("300 events over 2 days stored in %s", took)
}
