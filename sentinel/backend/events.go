package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Event struct {
	ID    string  `json:"id"`
	Cam   string  `json:"camera"`
	Start int64   `json:"start"` // unix ms
	End   int64   `json:"end"`   // 0 while ongoing
	Peak  float64 `json:"peak"`  // highest % of frame changing
	Thumb bool    `json:"thumb"`
}

func dayKey(ms int64) string { return time.UnixMilli(ms).UTC().Format("20060102") }

// EventStore keeps motion events in memory, persisted as one JSON file per camera per day.
type EventStore struct {
	mu     sync.Mutex
	root   string
	events map[string][]*Event // per camera, sorted by start
	open   map[string]*Event   // ongoing event per camera
}

func newEventStore(root string) *EventStore {
	es := &EventStore{root: root, events: map[string][]*Event{}, open: map[string]*Event{}}
	cams, _ := os.ReadDir(root)
	for _, c := range cams {
		if !c.IsDir() {
			continue
		}
		files, _ := filepath.Glob(filepath.Join(root, c.Name(), "*.json"))
		for _, f := range files {
			data, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			var list []*Event
			if json.Unmarshal(data, &list) != nil {
				continue
			}
			for _, e := range list {
				if e.End == 0 { // cut short by a restart or power cut
					e.End = e.Start + 10_000
				}
			}
			es.events[c.Name()] = append(es.events[c.Name()], list...)
		}
		sort.Slice(es.events[c.Name()], func(i, j int) bool { return es.events[c.Name()][i].Start < es.events[c.Name()][j].Start })
	}
	return es
}

func (es *EventStore) ThumbPath(cam, id string) string {
	return filepath.Join(es.root, cam, "thumbs", id+".jpg")
}

func (es *EventStore) Start(cam string, at time.Time, score float64) *Event {
	es.mu.Lock()
	defer es.mu.Unlock()
	ms := at.UnixMilli()
	e := &Event{ID: fmt.Sprintf("%s-%d", cam, ms), Cam: cam, Start: ms, Peak: score}
	es.events[cam] = append(es.events[cam], e)
	es.open[cam] = e
	es.persistDay(cam, dayKey(ms))
	return e
}

func (es *EventStore) Update(cam string, score float64) {
	es.mu.Lock()
	defer es.mu.Unlock()
	if e := es.open[cam]; e != nil && score > e.Peak {
		e.Peak = score
	}
}

func (es *EventStore) End(cam string, at time.Time) *Event {
	es.mu.Lock()
	defer es.mu.Unlock()
	e := es.open[cam]
	if e == nil {
		return nil
	}
	delete(es.open, cam)
	e.End = at.UnixMilli()
	es.persistDay(cam, dayKey(e.Start))
	cp := *e
	return &cp
}

func (es *EventStore) SetThumb(cam, id string) {
	es.mu.Lock()
	defer es.mu.Unlock()
	for i := len(es.events[cam]) - 1; i >= 0; i-- {
		if e := es.events[cam][i]; e.ID == id {
			e.Thumb = true
			es.persistDay(cam, dayKey(e.Start))
			return
		}
	}
}

// persistDay rewrites one day file; caller holds the lock.
func (es *EventStore) persistDay(cam, day string) {
	var list []*Event
	for _, e := range es.events[cam] {
		if dayKey(e.Start) == day {
			list = append(list, e)
		}
	}
	data, _ := json.Marshal(list)
	_ = writeFileAtomic(filepath.Join(es.root, cam, day+".json"), data, 0o644)
}

func (es *EventStore) List(cams []string, from, to int64, limit int) []Event {
	es.mu.Lock()
	defer es.mu.Unlock()
	var out []Event
	for cam, list := range es.events {
		if len(cams) > 0 && !contains(cams, cam) {
			continue
		}
		for _, e := range list {
			end := e.End
			if end == 0 {
				end = time.Now().UnixMilli()
			}
			if end >= from && e.Start <= to {
				out = append(out, *e)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	if out == nil {
		out = []Event{}
	}
	return out
}

func (es *EventStore) Get(cam, id string) (Event, bool) {
	es.mu.Lock()
	defer es.mu.Unlock()
	list := es.events[cam]
	for i := len(list) - 1; i >= 0; i-- {
		if list[i].ID == id {
			return *list[i], true
		}
	}
	return Event{}, false
}

func (es *EventStore) Last(cam string) *Event {
	es.mu.Lock()
	defer es.mu.Unlock()
	if l := es.events[cam]; len(l) > 0 {
		cp := *l[len(l)-1]
		return &cp
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Spans returns each camera's motion as merged [start-pad, end+pad] spans, for keeping
// the recordings that contain motion longer than the rest.
func (es *EventStore) Spans(pad time.Duration) map[string][]Span {
	es.mu.Lock()
	defer es.mu.Unlock()
	out := map[string][]Span{}
	p := pad.Milliseconds()
	now := time.Now().UnixMilli()
	for cam, list := range es.events {
		var spans []Span
		for _, e := range list {
			end := e.End
			if end == 0 {
				end = now
			}
			a, b := e.Start-p, end+p
			if n := len(spans); n > 0 && a <= spans[n-1].End {
				spans[n-1].End = max(spans[n-1].End, b)
				continue
			}
			spans = append(spans, Span{a, b})
		}
		out[cam] = spans
	}
	return out
}

func (es *EventStore) Cleanup(retain map[string]int, defaultDays int) {
	es.mu.Lock()
	defer es.mu.Unlock()
	for cam, list := range es.events {
		days, ok := retain[cam]
		if !ok {
			days = defaultDays
		}
		cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
		keep := list[:0]
		for _, e := range list {
			if e.End != 0 && e.End < cutoff {
				_ = os.Remove(es.ThumbPath(cam, e.ID))
				continue
			}
			keep = append(keep, e)
		}
		es.events[cam] = keep
		// Drop day files entirely outside retention.
		cutDay := dayKey(cutoff)
		files, _ := filepath.Glob(filepath.Join(es.root, cam, "*.json"))
		for _, f := range files {
			if strings.TrimSuffix(filepath.Base(f), ".json") < cutDay {
				_ = os.Remove(f)
			}
		}
	}
}

// ActivityStore keeps the peak motion score per 10-second bucket (8640 per day) for the
// timeline heatmap. One byte per bucket: score in tenths of a percent, capped at 25.5 %.
type ActivityStore struct {
	mu    sync.Mutex
	root  string
	days  map[string][]byte // cam/day -> buckets
	dirty map[string]bool
}

const bucketsPerDay = 8640

func newActivityStore(root string) *ActivityStore {
	return &ActivityStore{root: root, days: map[string][]byte{}, dirty: map[string]bool{}}
}

func (as *ActivityStore) file(key string) string {
	cam, day, _ := strings.Cut(key, "/")
	return filepath.Join(as.root, cam, day+".bin")
}

func (as *ActivityStore) day(key string) []byte {
	if b, ok := as.days[key]; ok {
		return b
	}
	b := make([]byte, bucketsPerDay)
	if data, err := os.ReadFile(as.file(key)); err == nil && len(data) == bucketsPerDay {
		copy(b, data)
	}
	as.days[key] = b
	return b
}

func (as *ActivityStore) Record(cam string, at time.Time, score float64) {
	v := int(score*10 + 0.5)
	if v > 255 {
		v = 255
	}
	if v == 0 {
		return
	}
	u := at.UTC()
	key := cam + "/" + u.Format("20060102")
	idx := (u.Hour()*3600 + u.Minute()*60 + u.Second()) / 10
	as.mu.Lock()
	defer as.mu.Unlock()
	b := as.day(key)
	if byte(v) > b[idx] {
		b[idx] = byte(v)
		as.dirty[key] = true
	}
}

func (as *ActivityStore) Flush() {
	as.mu.Lock()
	defer as.mu.Unlock()
	today := time.Now().UTC().Format("20060102")
	for key := range as.dirty {
		_ = writeFileAtomic(as.file(key), as.days[key], 0o644)
		delete(as.dirty, key)
	}
	// Keep only today's buckets in memory.
	for key := range as.days {
		if !strings.HasSuffix(key, "/"+today) {
			delete(as.days, key)
		}
	}
}

// Range returns [unix ms, score %] pairs for non-zero buckets, merged to `step` resolution.
func (as *ActivityStore) Range(cam string, from, to time.Time, step time.Duration) [][2]float64 {
	if step < 10*time.Second {
		step = 10 * time.Second
	}
	as.mu.Lock()
	defer as.mu.Unlock()
	out := [][2]float64{}
	var curBucket int64 = -1
	var curMax byte
	for d := from.UTC().Truncate(24 * time.Hour); d.Before(to); d = d.Add(24 * time.Hour) {
		key := cam + "/" + d.Format("20060102")
		_, cached := as.days[key]
		b := as.day(key)
		for i, v := range b {
			if v == 0 {
				continue
			}
			t := d.Add(time.Duration(i) * 10 * time.Second)
			if t.Before(from) || !t.Before(to) {
				continue
			}
			bucket := t.UnixMilli() / step.Milliseconds()
			if bucket != curBucket {
				if curBucket >= 0 {
					out = append(out, [2]float64{float64(curBucket * step.Milliseconds()), float64(curMax) / 10})
				}
				curBucket, curMax = bucket, 0
			}
			if v > curMax {
				curMax = v
			}
		}
		if !cached && !as.dirty[key] {
			delete(as.days, key)
		}
	}
	if curBucket >= 0 {
		out = append(out, [2]float64{float64(curBucket * step.Milliseconds()), float64(curMax) / 10})
	}
	return out
}

func (as *ActivityStore) Cleanup(retain map[string]int, defaultDays int) {
	cams, _ := os.ReadDir(as.root)
	for _, c := range cams {
		days, ok := retain[c.Name()]
		if !ok {
			days = defaultDays
		}
		cutDay := time.Now().Add(-time.Duration(days+1) * 24 * time.Hour).UTC().Format("20060102")
		files, _ := filepath.Glob(filepath.Join(as.root, c.Name(), "*.bin"))
		for _, f := range files {
			if strings.TrimSuffix(filepath.Base(f), ".bin") < cutDay {
				_ = os.Remove(f)
			}
		}
	}
}
