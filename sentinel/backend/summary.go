package main

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
)

// The daily summary: who was seen on which camera, when it was busiest, and whether
// every camera recorded the whole day. Shown on the web page and in the app, and sent to
// phones once a day.

type CamDay struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Counts      map[string]int `json:"counts"`   // person, cat, dog, motion (all events)
	RecordedPct float64        `json:"recorded"` // share of the day with footage
	Missing     int64          `json:"missing"`  // ms without footage
	FirstPerson int64          `json:"first_person,omitempty"`
	LastPerson  int64          `json:"last_person,omitempty"`
}

type Highlight struct {
	Event
	Label string  `json:"label"`
	Score float64 `json:"score"`
}

type DaySummary struct {
	Date       string         `json:"date"` // YYYY-MM-DD, local time
	From       int64          `json:"from"`
	To         int64          `json:"to"` // end of the day, or now for today
	Totals     map[string]int `json:"totals"`
	Cameras    []CamDay       `json:"cameras"`
	Hours      [24][4]int     `json:"hours"` // per hour: motion, person, cat, dog
	Highlights []Highlight    `json:"highlights"`
	Pending    int            `json:"pending"` // events not checked for people yet
	Problems   int            `json:"problems"`
	Text       string         `json:"text"`
}

// Summary sums up the local day d for the cameras allowed (all when nil).
func (a *App) Summary(d time.Time, allowed func(string) bool) DaySummary {
	day := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.Local)
	end := day.AddDate(0, 0, 1)
	now := time.Now()
	if end.After(now) {
		end = now
	}
	sum := DaySummary{Date: day.Format("2006-01-02"), From: day.UnixMilli(), To: end.UnixMilli(), Totals: map[string]int{}, Cameras: []CamDay{}, Highlights: []Highlight{}}
	s := a.settings.Get()
	var cams []string
	for _, c := range s.Cameras {
		if c.Enabled && (allowed == nil || allowed(c.ID)) {
			cams = append(cams, c.ID)
		}
	}
	if len(cams) == 0 {
		sum.Text = "No cameras."
		return sum
	}
	events := a.events.Filter(cams, sum.From, sum.To, 0, func(e *Event) bool { return e.Start >= sum.From })
	byCam := map[string]*CamDay{}
	for _, c := range s.Cameras {
		if !slices.Contains(cams, c.ID) {
			continue
		}
		cd := &CamDay{ID: c.ID, Name: c.Name, Counts: map[string]int{}}
		if c.Record {
			var have int64
			for _, sp := range a.store.Coverage(c.ID, day, end) {
				have += min(sp.End, sum.To) - max(sp.Start, sum.From)
			}
			span := sum.To - sum.From
			if span > 0 {
				cd.RecordedPct = min(100, float64(have)*100/float64(span))
				cd.Missing = max(0, span-have)
			}
		}
		byCam[c.ID] = cd
	}
	var highlights []Highlight
	for i := range events {
		e := &events[i]
		cd := byCam[e.Cam]
		if cd == nil {
			continue
		}
		h := time.UnixMilli(e.Start).Hour()
		cd.Counts["motion"]++
		sum.Totals["motion"]++
		sum.Hours[h][0]++
		if e.Scan == "" || e.Scan == "scanning" {
			sum.Pending++
		}
		for _, l := range e.Labels {
			cd.Counts[l]++
			sum.Totals[l]++
			sum.Hours[h][1+slices.Index(watchLabels, l)]++
		}
		if e.Has("person") {
			if cd.FirstPerson == 0 || e.Start < cd.FirstPerson {
				cd.FirstPerson = e.Start
			}
			cd.LastPerson = max(cd.LastPerson, e.Start)
		}
		if e.Snap && len(e.Objects) > 0 {
			highlights = append(highlights, Highlight{Event: *e, Label: e.Objects[0].Label, Score: e.Objects[0].Score})
		}
	}
	for _, id := range cams {
		sum.Cameras = append(sum.Cameras, *byCam[id])
	}
	// Highlights: the clearest sightings, people first, at most two per camera and spread
	// over the day (not ten pictures of one visit).
	sort.SliceStable(highlights, func(i, j int) bool {
		pi, pj := highlights[i].Label == "person", highlights[j].Label == "person"
		if pi != pj {
			return pi
		}
		return highlights[i].Score > highlights[j].Score
	})
	perCam := map[string]int{}
	for _, h := range highlights {
		if len(sum.Highlights) == 8 {
			break
		}
		if perCam[h.Cam] >= 2 || slices.ContainsFunc(sum.Highlights, func(x Highlight) bool {
			return x.Cam == h.Cam && abs64(x.Start-h.Start) < 10*60_000
		}) {
			continue
		}
		perCam[h.Cam]++
		sum.Highlights = append(sum.Highlights, h)
	}
	sort.Slice(sum.Highlights, func(i, j int) bool { return sum.Highlights[i].Start < sum.Highlights[j].Start })
	for _, in := range a.incidents.List(1000) {
		if in.Time >= sum.From && in.Time < sum.To && in.Level == "error" && (in.Camera == "" || slices.Contains(cams, in.Camera)) {
			sum.Problems++
		}
	}
	sum.Text = summaryText(sum, s)
	return sum
}

// summaryText is the one-paragraph version (the phone notification).
func summaryText(sum DaySummary, s Settings) string {
	var parts []string
	for _, l := range watchLabels {
		if n := sum.Totals[l]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, countWord(l, n)))
		}
	}
	var b strings.Builder
	if len(parts) == 0 {
		fmt.Fprintf(&b, "No people or animals seen")
	} else {
		fmt.Fprintf(&b, "%s", joinAnd(parts))
	}
	fmt.Fprintf(&b, " · %d motion event%s.", sum.Totals["motion"], map[bool]string{true: "", false: "s"}[sum.Totals["motion"] == 1])
	if busiest := busiestPersonCam(sum); busiest != "" {
		fmt.Fprintf(&b, " Most people: %s.", busiest)
	}
	var gaps []string
	for _, c := range sum.Cameras {
		cam := cameraConfig(s, c.ID)
		if cam.Record && !cam.Occasional && c.Missing > 5*60_000 {
			gaps = append(gaps, fmt.Sprintf("%s missed %s", c.Name, humanDuration(time.Duration(c.Missing)*time.Millisecond)))
		}
	}
	if len(gaps) == 0 {
		b.WriteString(" All cameras recorded the whole time.")
	} else {
		b.WriteString(" " + strings.Join(gaps, ", ") + ".")
	}
	return b.String()
}

func countWord(label string, n int) string {
	switch {
	case label == "person" && n == 1:
		return "person"
	case label == "person":
		return "people sightings"
	case n == 1:
		return label
	}
	return label + "s"
}

func joinAnd(p []string) string {
	if len(p) <= 1 {
		return strings.Join(p, "")
	}
	return strings.Join(p[:len(p)-1], ", ") + " and " + p[len(p)-1]
}

func busiestPersonCam(sum DaySummary) string {
	best, n := "", 0
	for _, c := range sum.Cameras {
		if c.Counts["person"] > n {
			best, n = c.Name, c.Counts["person"]
		}
	}
	return best
}

// summaryDue sends yesterday's summary to phones at the configured time (once a day).
func (a *App) summaryDue(now time.Time) {
	s := a.settings.Get()
	if !s.DailySummary.Enabled {
		return
	}
	at := hhmm(s.DailySummary.Time)
	if at < 0 || now.Hour()*60+now.Minute() < at {
		return
	}
	today := now.Format("2006-01-02")
	a.mu.Lock()
	sent := a.summarySent == today
	a.summarySent = today
	a.mu.Unlock()
	if sent {
		return
	}
	// Once per day, even across restarts.
	if prev, _ := readFileLimit(a.media+"/summary-sent", 64); string(prev) == today {
		return
	}
	_ = writeFileAtomic(a.media+"/summary-sent", []byte(today), 0o644)
	y := now.AddDate(0, 0, -1)
	a.push.Summary(y.Format("2006-01-02"), func(allowed func(string) bool) string { return a.Summary(y, allowed).Text })
}
