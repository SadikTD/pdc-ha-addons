package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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
	// Who was seen (object detection, see labels.go): "person", "cat", "dog", best
	// first. Empty with Scan "done" means plain motion.
	Labels  []string `json:"labels,omitempty"`
	Objects []Object `json:"objects,omitempty"`
	// "" not checked yet, "done", or "none" (couldn't be checked, e.g. no footage).
	Scan string `json:"scan,omitempty"`
	Snap bool   `json:"snap,omitempty"` // a picture of what was seen (snap.jpg)
	// What the fast model thought it saw but the big model didn't confirm (for checking
	// how well detection does; not shown as a label).
	Rejected []Object `json:"rejected,omitempty"`
	// Who the people were, when recognised (see faces.go), and whether their faces have
	// been looked at ("done").
	Who   []Who  `json:"who,omitempty"`
	Faces string `json:"faces,omitempty"`
}

// Object is one kind of thing seen in an event, at its clearest moment.
type Object struct {
	Label string  `json:"label"`
	Score float64 `json:"score"`         // the verifying model's confidence
	Box   Rect    `json:"box"`           // normalised to the frame
	T     int64   `json:"t"`             // unix ms of that frame
	Why   string  `json:"why,omitempty"` // (rejected only) why it didn't count
}

func (e *Event) Has(label string) bool { return slices.Contains(e.Labels, label) }

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
				if e.Scan == "scanning" { // interrupted: check it again
					e.Scan = ""
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

func (es *EventStore) SnapPath(cam, id string) string {
	return filepath.Join(es.root, cam, "snaps", id+".jpg")
}

// SetScan stores what object detection found in an event.
func (es *EventStore) SetScan(cam, id, scan string, objs, rejected []Object, snap bool) (Event, bool) {
	es.mu.Lock()
	defer es.mu.Unlock()
	list := es.events[cam]
	for i := len(list) - 1; i >= 0; i-- {
		if e := list[i]; e.ID == id {
			e.Scan, e.Objects, e.Rejected, e.Snap = scan, objs, rejected, e.Snap || snap
			e.Labels = nil
			for _, o := range objs {
				if !slices.Contains(e.Labels, o.Label) {
					e.Labels = append(e.Labels, o.Label)
				}
			}
			if scan == "done" && !e.Has("person") {
				e.Who, e.Faces = nil, ""
			}
			es.persistDay(cam, dayKey(e.Start))
			return *e, true
		}
	}
	return Event{}, false
}

// SetWho stores who the people in an event were (only when it changed).
func (es *EventStore) SetWho(cam, id string, who []Who) {
	es.mu.Lock()
	defer es.mu.Unlock()
	list := es.events[cam]
	for i := len(list) - 1; i >= 0; i-- {
		if e := list[i]; e.ID == id {
			if !slices.Equal(e.Who, who) {
				e.Who = who
				es.persistDay(cam, dayKey(e.Start))
			}
			return
		}
	}
}

// SetFacesDone: the event's faces have been looked at.
func (es *EventStore) SetFacesDone(cam, id string) {
	es.mu.Lock()
	defer es.mu.Unlock()
	list := es.events[cam]
	for i := len(list) - 1; i >= 0; i-- {
		if e := list[i]; e.ID == id {
			e.Faces = "done"
			es.persistDay(cam, dayKey(e.Start))
			return
		}
	}
}

// ForFaces: finished person events whose faces haven't been looked at, newest first.
func (es *EventStore) ForFaces(since int64, limit int) []Event {
	es.mu.Lock()
	defer es.mu.Unlock()
	var out []Event
	for _, list := range es.events {
		for _, e := range list {
			if e.End != 0 && e.Start >= since && e.Faces == "" && e.Scan == "done" && e.Has("person") {
				out = append(out, *e)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// RemoveLabel takes a wrong label off an event (the user said so). It returns the
// object that was removed.
func (es *EventStore) RemoveLabel(cam, id, label string) (Object, bool) {
	es.mu.Lock()
	defer es.mu.Unlock()
	for _, e := range es.events[cam] {
		if e.ID != id {
			continue
		}
		i := slices.IndexFunc(e.Objects, func(o Object) bool { return o.Label == label })
		if i < 0 {
			return Object{}, false
		}
		o := e.Objects[i]
		e.Objects = slices.Delete(slices.Clone(e.Objects), i, i+1)
		e.Labels = slices.DeleteFunc(slices.Clone(e.Labels), func(l string) bool { return l == label })
		e.Rejected = append(e.Rejected, Object{Label: "not " + label, Score: o.Score, Box: o.Box, T: o.T})
		if label == "person" {
			e.Who = nil
		}
		if len(e.Objects) == 0 {
			e.Snap = false
			removePicture(es.SnapPath(cam, id))
		}
		es.persistDay(cam, dayKey(e.Start))
		return o, true
	}
	return Object{}, false
}

// Rescan forgets detection results of events that started in [from, to] (on these
// cameras, all when empty), so they're checked again. It returns how many. seenOnly:
// just the events where something was seen (labelled, or with rejected sightings), and
// their current labels stay until they're checked again.
func (es *EventStore) Rescan(cams []string, from, to int64, seenOnly bool) int {
	es.mu.Lock()
	defer es.mu.Unlock()
	n := 0
	for cam, list := range es.events {
		if len(cams) > 0 && !contains(cams, cam) {
			continue
		}
		days := map[string]bool{}
		for _, e := range list {
			if e.Start >= from && e.Start <= to && e.End != 0 && e.Scan != "scanning" {
				if seenOnly {
					if len(e.Labels) > 0 || len(e.Rejected) > 0 {
						e.Scan = ""
						days[dayKey(e.Start)] = true
						n++
					}
					continue
				}
				e.Scan, e.Labels, e.Objects, e.Rejected, e.Snap = "", nil, nil, nil, false
				removePicture(es.SnapPath(cam, e.ID))
				days[dayKey(e.Start)] = true
				n++
			}
		}
		for d := range days {
			es.persistDay(cam, d)
		}
	}
	return n
}

// Unscanned returns finished events object detection hasn't looked at yet, newest first.
func (es *EventStore) Unscanned(since int64, limit int) []Event {
	es.mu.Lock()
	defer es.mu.Unlock()
	var out []Event
	for cam, list := range es.events {
		if es.open[cam] != nil {
			list = list[:len(list)-1]
		}
		for _, e := range list {
			if e.Scan == "" && e.End != 0 && e.Start >= since {
				out = append(out, *e)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
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
	return es.Filter(cams, from, to, limit, nil)
}

// Filter lists events on these cameras (all when empty) overlapping [from, to] that
// match keep (all when nil), newest first.
func (es *EventStore) Filter(cams []string, from, to int64, limit int, keep func(*Event) bool) []Event {
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
			if end >= from && e.Start <= to && (keep == nil || keep(e)) {
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
// the recordings that contain motion longer than the rest. With keep, only the events
// it accepts count.
func (es *EventStore) Spans(pad time.Duration, keep func(*Event) bool) map[string][]Span {
	es.mu.Lock()
	defer es.mu.Unlock()
	out := map[string][]Span{}
	p := pad.Milliseconds()
	now := time.Now().UnixMilli()
	for cam, list := range es.events {
		var spans []Span
		for _, e := range list {
			if keep != nil && !keep(e) {
				continue
			}
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

// Cleanup removes events older than days(event) days (with their pictures).
func (es *EventStore) Cleanup(days func(cam string, e *Event) int) {
	es.mu.Lock()
	defer es.mu.Unlock()
	now := time.Now()
	for cam, list := range es.events {
		oldest := 0
		touched := map[string]bool{}
		keep := list[:0]
		for _, e := range list {
			d := days(cam, e)
			oldest = max(oldest, d)
			cutoff := now.Add(-time.Duration(d) * 24 * time.Hour).UnixMilli()
			if e.End != 0 && e.End < cutoff {
				removePicture(es.ThumbPath(cam, e.ID))
				removePicture(es.SnapPath(cam, e.ID))
				touched[dayKey(e.Start)] = true
				continue
			}
			keep = append(keep, e)
		}
		clear(list[len(keep):])
		es.events[cam] = keep
		// Drop day files entirely outside retention; rewrite the rest when events went.
		cutDay := dayKey(now.Add(-time.Duration(oldest) * 24 * time.Hour).UnixMilli())
		files, _ := filepath.Glob(filepath.Join(es.root, cam, "*.json"))
		for _, f := range files {
			if strings.TrimSuffix(filepath.Base(f), ".json") < cutDay {
				_ = os.Remove(f)
			}
		}
		for day := range touched {
			if day >= cutDay {
				es.persistDay(cam, day)
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
