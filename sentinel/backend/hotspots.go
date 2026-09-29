package main

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Hotspots are places in a camera's picture where lookalikes keep fooling detection:
// laundry on a line, a coat on a hook, a poster, a garden statue. Each is learned from
// sightings the big model rejected, things that sat anchored in one spot, and the user
// saying "that's not a person". Something seen only inside a hotspot doesn't count; a
// real person or animal is also seen moving elsewhere in the picture.

type Hotspot struct {
	Box  Rect    `json:"box"`
	Hits float64 `json:"hits"` // evidence; decays by half every hotspotHalfLife
	Last int64   `json:"last"` // unix ms of the last hit
}

const (
	hotspotHalfLife = 3 * 24 * time.Hour
	hotspotActive   = 3.0 // hits for a spot to count
	hotspotIoU      = 0.4
	userHits        = 6.0 // "not a person" from the user counts this much
)

type Hotspots struct {
	mu    sync.Mutex
	path  string
	spots map[string][]Hotspot // camera -> spots
	dirty bool
}

func loadHotspots(path string) *Hotspots {
	h := &Hotspots{path: path, spots: map[string][]Hotspot{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &h.spots)
	}
	return h
}

func decayed(s Hotspot, now time.Time) float64 {
	age := now.Sub(time.UnixMilli(s.Last))
	if age <= 0 {
		return s.Hits
	}
	f := 1.0
	for d := age; d >= hotspotHalfLife; d -= hotspotHalfLife {
		f /= 2
	}
	return s.Hits * f
}

// Add records evidence of a lookalike at box.
func (h *Hotspots) Add(cam string, box Rect, hits float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	list := h.spots[cam]
	for i := range list {
		if iou(list[i].Box, box) >= 0.5 {
			s := &list[i]
			s.Hits = decayed(*s, now) + hits
			s.Last = now.UnixMilli()
			// Follow the thing a little (laundry sways).
			s.Box = Rect{X: (s.Box.X*3 + box.X) / 4, Y: (s.Box.Y*3 + box.Y) / 4, W: (s.Box.W*3 + box.W) / 4, H: (s.Box.H*3 + box.H) / 4}
			h.dirty = true
			return
		}
	}
	// Forget spots that have faded away.
	keep := list[:0]
	for _, s := range list {
		if decayed(s, now) >= 0.5 {
			keep = append(keep, s)
		}
	}
	h.spots[cam] = append(keep, Hotspot{Box: box, Hits: hits, Last: now.UnixMilli()})
	h.dirty = true
}

// Suspect: is box inside a known lookalike spot?
func (h *Hotspots) Suspect(cam string, box Rect) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	for _, s := range h.spots[cam] {
		if decayed(s, now) >= hotspotActive && (iou(s.Box, box) >= hotspotIoU || overlapOfSmaller(s.Box, box) >= 0.8) {
			return true
		}
	}
	return false
}

func (h *Hotspots) List(cam string) []Hotspot {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	out := []Hotspot{}
	for _, s := range h.spots[cam] {
		s.Hits = decayed(s, now)
		out = append(out, s)
	}
	return out
}

func (h *Hotspots) Clear(cam string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.spots, cam)
	h.dirty = true
}

func (h *Hotspots) Save() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.dirty {
		return
	}
	b, _ := json.Marshal(h.spots)
	if writeFileAtomic(h.path, b, 0o644) == nil {
		h.dirty = false
	}
}
