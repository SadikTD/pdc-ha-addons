package main

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Search understands plain questions about events, e.g. "person on the roof last
// night", "cats yesterday after 10pm", "dog ground floor this morning", "people 2 days
// ago between 1 and 4am". It runs here, so the web page and the app understand the same
// things. Anything it doesn't recognise is ignored, and it says how it read the question
// (Chips) so a wrong guess is easy to spot.

type SearchQuery struct {
	Labels  []string `json:"labels"`  // person, cat, dog; empty = any
	Motion  bool     `json:"motion"`  // plain motion only (nobody recognised)
	Cameras []string `json:"cameras"` // empty = all
	From    int64    `json:"from"`
	To      int64    `json:"to"`
	// Time of day in minutes after midnight, applied on every day in [From, To]
	// (HourFrom > HourTo wraps past midnight). -1 = any time.
	DayFrom int      `json:"day_from"`
	DayTo   int      `json:"day_to"`
	Chips   []string `json:"chips"`
}

var labelWords = map[string][]string{
	"person": {"person", "persons", "people", "human", "humans", "man", "men", "woman", "women", "someone", "somebody", "anyone", "anybody", "visitor", "visitors", "intruder", "intruders", "guy", "guys", "kid", "kids", "child", "children"},
	"cat":    {"cat", "cats", "kitten", "kittens", "kitty"},
	"dog":    {"dog", "dogs", "puppy", "puppies", "doggy"},
}

// Words that mean "the camera", not which one.
var cameraFiller = map[string]bool{"cam": true, "camera": true, "cameras": true, "floor": true, "room": true, "the": true, "outdoor": false}

var (
	reLastN   = regexp.MustCompile(`\b(?:last|past)\s+(\d+)\s*(minute|min|hour|hr|day|week)s?\b`)
	reAgo     = regexp.MustCompile(`\b(\d+)\s*(day|week)s?\s+ago\b`)
	reBetween = regexp.MustCompile(`\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:and|to|-)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`)
	reAfter   = regexp.MustCompile(`\b(after|since|before|until|at|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b`)
	reISO     = regexp.MustCompile(`\b(\d{4})-(\d{1,2})-(\d{1,2})\b`)
	reDM      = regexp.MustCompile(`\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b`)
	reMD      = regexp.MustCompile(`\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b`)
	reSlash   = regexp.MustCompile(`\b(\d{1,2})/(\d{1,2})\b`)
)

var rePunct = regexp.MustCompile(`[^a-z0-9:/ -]+`)

var months = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}

// ParseSearch reads a question. now is the current time; cams are the cameras to match
// names against.
func ParseSearch(q string, now time.Time, cams []Camera) SearchQuery {
	s := " " + strings.Join(strings.Fields(rePunct.ReplaceAllString(strings.ToLower(q), " ")), " ") + " "
	out := SearchQuery{DayFrom: -1, DayTo: -1}
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	today := day(now)
	setRange := func(from, to time.Time, chip string) {
		if out.From == 0 {
			out.From, out.To = from.UnixMilli(), to.UnixMilli()
			out.Chips = append(out.Chips, chip)
		}
	}
	take := func(re *regexp.Regexp) []string {
		m := re.FindStringSubmatch(s)
		if m != nil {
			s = strings.Replace(s, m[0], " ", 1)
		}
		return m
	}
	has := func(phrase string) bool {
		if strings.Contains(s, " "+phrase+" ") {
			s = strings.Replace(s, " "+phrase+" ", " ", 1)
			return true
		}
		return false
	}

	// What.
	for _, label := range watchLabels {
		for _, w := range labelWords[label] {
			if has(w) {
				if !slices.Contains(out.Labels, label) {
					out.Labels = append(out.Labels, label)
				}
			}
		}
	}
	if has("animal") || has("animals") || has("pet") || has("pets") {
		for _, l := range []string{"cat", "dog"} {
			if !slices.Contains(out.Labels, l) {
				out.Labels = append(out.Labels, l)
			}
		}
	}
	if len(out.Labels) == 0 && (has("only motion") || has("just motion") || has("plain motion") || has("nobody") || has("no one")) {
		out.Motion = true
	}

	// Which camera: its whole name, or a distinctive word of it ("roof", "ground").
	for _, c := range cams {
		name := strings.ToLower(c.Name)
		if strings.Contains(s, " "+name+" ") || strings.Contains(s, " "+strings.ToLower(c.ID)+" ") ||
			strings.Contains(s, " "+strings.ReplaceAll(strings.ToLower(c.ID), "_", " ")+" ") {
			out.Cameras = append(out.Cameras, c.ID)
			s = strings.Replace(strings.Replace(s, " "+name+" ", " ", 1), " "+strings.ToLower(c.ID)+" ", " ", 1)
			continue
		}
		for _, w := range strings.Fields(name) {
			if len(w) < 3 || cameraFiller[w] {
				continue
			}
			if strings.Contains(s, " "+w+" ") && !cameraWordShared(w, c.ID, cams) {
				out.Cameras = append(out.Cameras, c.ID)
				break
			}
		}
	}
	for _, id := range out.Cameras {
		out.Chips = append(out.Chips, cameraName(Settings{Cameras: cams}, id))
	}

	// When: a day or a span.
	yesterday := today.AddDate(0, 0, -1)
	switch {
	case has("last night"):
		setRange(yesterday.Add(18*time.Hour), today.Add(7*time.Hour), "Last night")
	case has("tonight"):
		setRange(today.Add(18*time.Hour), today.Add(31*time.Hour), "Tonight")
	case has("this morning"):
		setRange(today.Add(5*time.Hour), today.Add(12*time.Hour), "This morning")
	case has("this afternoon"):
		setRange(today.Add(12*time.Hour), today.Add(17*time.Hour), "This afternoon")
	case has("this evening"):
		setRange(today.Add(17*time.Hour), today.Add(22*time.Hour), "This evening")
	}
	if m := take(reLastN); m != nil {
		n, _ := strconv.Atoi(m[1])
		unit := map[string]time.Duration{"minute": time.Minute, "min": time.Minute, "hour": time.Hour, "hr": time.Hour, "day": 24 * time.Hour, "week": 7 * 24 * time.Hour}[m[2]]
		setRange(now.Add(-time.Duration(n)*unit), now, fmt.Sprintf("Last %d %s", n, plural(n, strings.TrimSuffix(m[2], "s"))))
	}
	if m := take(reAgo); m != nil {
		n, _ := strconv.Atoi(m[1])
		if m[2] == "week" {
			n *= 7
		}
		d := today.AddDate(0, 0, -n)
		setRange(d, d.AddDate(0, 0, 1), fmtDay(d, now))
	}
	switch {
	case has("today"):
		setRange(today, today.AddDate(0, 0, 1), "Today")
	case has("yesterday"):
		setRange(yesterday, today, "Yesterday")
	case has("this week"):
		setRange(today.AddDate(0, 0, -6), now, "This week")
	}
	for i := 0; i < 7; i++ {
		d := today.AddDate(0, 0, -i)
		wd := strings.ToLower(d.Weekday().String())
		if has(wd) || has(wd[:3]) {
			setRange(d, d.AddDate(0, 0, 1), d.Weekday().String())
			break
		}
	}
	if m := take(reISO); m != nil {
		y, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		dd, _ := strconv.Atoi(m[3])
		d := time.Date(y, time.Month(mo), dd, 0, 0, 0, 0, now.Location())
		setRange(d, d.AddDate(0, 0, 1), fmtDay(d, now))
	}
	dm := take(reDM)
	if dm == nil {
		if m := take(reMD); m != nil {
			dm = []string{m[0], m[2], m[1]}
		}
	}
	if dm != nil {
		dd, _ := strconv.Atoi(dm[1])
		mo := slices.Index(months, dm[2][:3]) + 1
		d := time.Date(now.Year(), time.Month(mo), dd, 0, 0, 0, 0, now.Location())
		if d.After(now) {
			d = d.AddDate(-1, 0, 0)
		}
		setRange(d, d.AddDate(0, 0, 1), fmtDay(d, now))
	} else if m := take(reSlash); m != nil {
		dd, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		if mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31 {
			d := time.Date(now.Year(), time.Month(mo), dd, 0, 0, 0, 0, now.Location())
			if d.After(now) {
				d = d.AddDate(-1, 0, 0)
			}
			setRange(d, d.AddDate(0, 0, 1), fmtDay(d, now))
		}
	}

	// Time of day.
	clock := func(h, m, ampm string, hint int) int {
		hh, _ := strconv.Atoi(h)
		mm, _ := strconv.Atoi(m)
		switch {
		case ampm == "pm" && hh < 12:
			hh += 12
		case ampm == "am" && hh == 12:
			hh = 0
		case ampm == "" && hint >= 12*60 && hh < 12:
			hh += 12 // "between 8 and 11pm"
		}
		return (hh%24)*60 + mm
	}
	if m := take(reBetween); m != nil {
		to := clock(m[4], m[5], m[6], -1)
		ap := m[3]
		if ap == "" && m[6] == "pm" {
			if a, _ := strconv.Atoi(m[1]); a <= mustAtoi(m[4]) {
				ap = "pm"
			}
		}
		from := clock(m[1], m[2], ap, -1)
		out.DayFrom, out.DayTo = from, to
		out.Chips = append(out.Chips, fmt.Sprintf("%s–%s", fmtClock(from), fmtClock(to)))
	} else if m := take(reAfter); m != nil {
		t := clock(m[2], m[3], m[4], -1)
		switch m[1] {
		case "after", "since":
			out.DayFrom, out.DayTo = t, 24*60
			out.Chips = append(out.Chips, "After "+fmtClock(t))
		case "before", "until":
			out.DayFrom, out.DayTo = 0, t
			out.Chips = append(out.Chips, "Before "+fmtClock(t))
		case "at":
			out.DayFrom, out.DayTo = (t-30+1440)%1440, (t+30)%1440
			out.Chips = append(out.Chips, "Around "+fmtClock(t))
		case "around":
			out.DayFrom, out.DayTo = (t-60+1440)%1440, (t+60)%1440
			out.Chips = append(out.Chips, "Around "+fmtClock(t))
		}
	} else {
		parts := map[string][2]int{"morning": {5 * 60, 12 * 60}, "afternoon": {12 * 60, 17 * 60}, "evening": {17 * 60, 22 * 60}, "night": {21 * 60, 6 * 60}, "at night": {21 * 60, 6 * 60}, "midnight": {23 * 60, 1 * 60}, "dawn": {4 * 60, 7 * 60}}
		for _, w := range []string{"at night", "morning", "afternoon", "evening", "midnight", "dawn", "night"} {
			if has(w) {
				p := parts[w]
				out.DayFrom, out.DayTo = p[0], p[1]
				out.Chips = append(out.Chips, strings.ToUpper(w[:1])+w[1:])
				break
			}
		}
	}

	if out.From == 0 {
		out.From, out.To = now.Add(-backfillWindow).UnixMilli(), now.UnixMilli()
	}
	switch {
	case out.Motion:
		out.Chips = append([]string{"Plain motion"}, out.Chips...)
	case len(out.Labels) == 0:
		out.Chips = append([]string{"All events"}, out.Chips...)
	default:
		names := []string{}
		for _, l := range out.Labels {
			names = append(names, objectNames[l])
		}
		out.Chips = append([]string{strings.Join(names, " or ")}, out.Chips...)
	}
	return out
}

func mustAtoi(s string) int { n, _ := strconv.Atoi(s); return n }

// cameraWordShared: the word appears in another camera's name too ("floor", "outdoor"),
// so it doesn't pick one camera.
func cameraWordShared(w, id string, cams []Camera) bool {
	for _, c := range cams {
		if c.ID != id && slices.Contains(strings.Fields(strings.ToLower(c.Name)), w) {
			return true
		}
	}
	return false
}

func plural(n int, w string) string {
	if n == 1 {
		return w
	}
	return w + "s"
}

func fmtClock(m int) string {
	h, mm := (m/60)%24, m%60
	ap := "am"
	if h >= 12 {
		ap = "pm"
	}
	h12 := h % 12
	if h12 == 0 {
		h12 = 12
	}
	if mm == 0 {
		return fmt.Sprintf("%d %s", h12, ap)
	}
	return fmt.Sprintf("%d:%02d %s", h12, mm, ap)
}

func fmtDay(d, now time.Time) string {
	if d.Year() != now.Year() {
		return d.Format("2 Jan 2006")
	}
	return d.Format("Mon 2 Jan")
}

// Match: does the event fit the query (time span, camera and time of day are checked by
// the caller except the time of day)?
func (q SearchQuery) Match(e *Event) bool {
	switch {
	case q.Motion:
		if e.Scan != "done" || len(e.Labels) > 0 {
			return false
		}
	case len(q.Labels) > 0:
		if !slices.ContainsFunc(q.Labels, e.Has) {
			return false
		}
	}
	if q.DayFrom >= 0 {
		t := time.UnixMilli(e.Start)
		m := t.Hour()*60 + t.Minute()
		if q.DayFrom <= q.DayTo {
			if m < q.DayFrom || m >= q.DayTo {
				return false
			}
		} else if m < q.DayFrom && m >= q.DayTo {
			return false
		}
	}
	return true
}
