package main

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Comings and goings: when the people you named came home and went out, worked out
// from where Sentinel recognised them (see Presence in settings.go). Nothing is stored:
// the log is worked out from the events whenever it's asked for, so naming someone
// later, or changing the settings, fixes the past too.

type PresenceEntry struct {
	Person string `json:"person"`
	Name   string `json:"name"`
	Kind   string `json:"kind"` // "arrived" or "left"
	T      int64  `json:"t"`    // when (unix ms): first seen back, or last seen before going
	Cam    string `json:"cam"`
	Event  string `json:"event"`
	By     string `json:"by"`              // recognised by "face" or "clothing"
	For    int64  `json:"for,omitempty"`   // arrived: how long they were out (ms)
	Known  int64  `json:"known,omitempty"` // left: when it became sure (T + away time)
}

type PresenceNow struct {
	Person   string `json:"person"`
	Name     string `json:"name"`
	State    string `json:"state"` // "home", "away" or "unknown"
	Since    int64  `json:"since,omitempty"`
	LastSeen int64  `json:"last_seen,omitempty"`
	LastCam  string `json:"last_cam,omitempty"`
}

type presenceSighting struct {
	t, end     int64
	cam, event string
	by         string
}

// presenceLookback: how far before the asked range the log starts working, so the
// state at its start is known.
const presenceLookback = 2 * 24 * time.Hour

// presence works out the comings and goings between from and to (unix ms), newest
// first, and where everyone stands now.
func (a *App) presence(pr Presence, from, to int64) ([]PresenceEntry, []PresenceNow) {
	people := a.faces.People()
	tracked := map[string]string{} // id -> name
	for _, p := range people {
		if p.Unnamed && !slices.Contains(pr.People, p.ID) {
			continue
		}
		if len(pr.People) == 0 || slices.Contains(pr.People, p.ID) {
			tracked[p.ID] = p.Name
		}
	}
	now := time.Now().UnixMilli()
	start := from - presenceLookback.Milliseconds()
	events := a.events.Filter(nil, start, to, 0, func(e *Event) bool { return len(e.Who) > 0 })
	seen := map[string][]presenceSighting{}
	for _, e := range events {
		end := e.End
		if end == 0 {
			end = now
		}
		for _, w := range e.Who {
			if tracked[w.Person] == "" || w.By == "clothing" && !pr.Clothing {
				continue
			}
			seen[w.Person] = append(seen[w.Person], presenceSighting{e.Start, end, e.Cam, e.ID, w.By})
		}
	}
	away := int64(pr.AwayMinutes) * 60_000
	entrance := func(cam string) bool { return slices.Contains(pr.Entrances, cam) }

	var log []PresenceEntry
	var status []PresenceNow
	for id, name := range tracked {
		list := seen[id]
		sort.Slice(list, func(i, j int) bool { return list[i].t < list[j].t })
		st := PresenceNow{Person: id, Name: name, State: "unknown"}
		var last *presenceSighting
		var leftAt int64
		goOut := func(upTo int64) {
			// Last seen at an entrance and not since, for long enough: gone out.
			if st.State == "home" && last != nil && entrance(last.cam) && upTo-last.end >= away {
				log = append(log, PresenceEntry{Person: id, Name: name, Kind: "left", T: last.end, Cam: last.cam, Event: last.event, By: last.by, Known: last.end + away})
				st.State, st.Since, leftAt = "away", last.end, last.end
			}
		}
		for i := range list {
			s := &list[i]
			goOut(s.t)
			switch {
			case st.State == "away" && (pr.ArriveOn == "any" || entrance(s.cam)):
				log = append(log, PresenceEntry{Person: id, Name: name, Kind: "arrived", T: s.t, Cam: s.cam, Event: s.event, By: s.by, For: s.t - leftAt})
				st.State, st.Since = "home", s.t
			case st.State != "home":
				// First sighting in the window, or back without passing an entrance
				// camera (when arrivals count only there): home, but not logged.
				st.State, st.Since = "home", s.t
			}
			if last == nil || s.end > last.end {
				last = s
			}
		}
		goOut(now)
		if last != nil {
			st.LastSeen, st.LastCam = last.end, last.cam
		}
		status = append(status, st)
	}
	out := []PresenceEntry{}
	for _, e := range log {
		if e.T >= from && e.T <= to {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T > out[j].T })
	sort.Slice(status, func(i, j int) bool { return strings.ToLower(status[i].Name) < strings.ToLower(status[j].Name) })
	return out, status
}

// presenceWatch sends notifications for new comings and goings and keeps Home
// Assistant's home/away trackers up to date.
type presenceWatch struct {
	mu      sync.Mutex
	told    map[string]bool   // entries already notified
	state   map[string]string // person -> last published "home"/"not_home"
	started bool
}

func presenceKey(e PresenceEntry) string { return fmt.Sprintf("%s/%s/%d", e.Person, e.Kind, e.T) }

func (a *App) presenceLoop(ctx context.Context) {
	w := &presenceWatch{told: map[string]bool{}, state: map[string]string{}}
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		a.presenceCheck(w)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (a *App) presenceCheck(w *presenceWatch) {
	s := a.settings.Get()
	pr := s.Presence
	if !pr.Enabled {
		a.mqtt.SetPresence(nil)
		return
	}
	now := time.Now()
	entries, status := a.presence(pr, now.Add(-6*time.Hour).UnixMilli(), now.UnixMilli())

	states := map[string]string{}
	for _, st := range status {
		switch st.State {
		case "home":
			states[st.Person] = "home"
		case "away":
			states[st.Person] = "not_home"
		}
	}
	if pr.HomeAssistant {
		a.mqtt.SetPresence(states)
	} else {
		a.mqtt.SetPresence(nil)
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	first := !w.started
	w.started = true
	for _, e := range entries {
		k := presenceKey(e)
		if w.told[k] {
			continue
		}
		w.told[k] = true
		// At start everything already logged counts as told; later only what just
		// became known (recognition can lag, and naming someone fills in the past).
		sure := e.T
		if e.Kind == "left" {
			sure = e.Known
		}
		if first || now.UnixMilli()-sure > 30*60_000 {
			continue
		}
		if !pr.Notify || e.Kind == "arrived" && !pr.NotifyArrive || e.Kind == "left" && !pr.NotifyLeave {
			continue
		}
		if len(pr.NotifyPeople) > 0 && !slices.Contains(pr.NotifyPeople, e.Person) {
			continue
		}
		if q := strings.SplitN(pr.Quiet, "-", 2); len(q) == 2 && inWindow(q[0], q[1], now) {
			continue
		}
		a.push.Presence(e, cameraName(s, e.Cam))
	}
	if len(w.told) > 5000 {
		w.told = map[string]bool{}
		for _, e := range entries {
			w.told[presenceKey(e)] = true
		}
	}
}

// presenceText words an entry for a notification: "Dad came home" / "Mom went out".
func presenceText(e PresenceEntry, camName string) (string, string) {
	at := time.UnixMilli(e.T).In(time.Local).Format("3:04 PM")
	if e.Kind == "arrived" {
		body := fmt.Sprintf("%s · %s", camName, at)
		if e.For > 0 {
			body += " · out for " + humanDuration(time.Duration(e.For)*time.Millisecond)
		}
		return e.Name + " came home", body
	}
	return e.Name + " went out", fmt.Sprintf("Last seen on %s at %s", camName, at)
}
