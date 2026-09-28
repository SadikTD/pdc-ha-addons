package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Files are the source of truth; there is no database to corrupt. ffmpeg writes
//   20260928-113500-3fa2c91b.mp4                (in progress; name = system clock, UTC)
// and once complete Sentinel renames it to
//   20260928-113500-3fa2c91b.d60012.mp4         (duration 60.012 s, clock was right)
//   20260928-113500-3fa2c91b.d60012.o-65000.mp4 (clock was 65 s fast; true start = name - 65 s)
//   20260928-113500-3fa2c91b.d60012.u.mp4       (true time not known yet; fixed once it is)
// The session suffix (host boot tag + random) makes names unique, so a clock that jumps
// backwards after a power cut can never overwrite earlier footage.

var segRe = regexp.MustCompile(`^(\d{8}-\d{6})-([0-9a-f]{8})(?:\.d(\d+))?(?:\.o(-?\d+)|\.(u))?\.mp4$`)

type Segment struct {
	ID         string // "20260928-113500-3fa2c91b", stable across renames
	Cam        string
	Raw        time.Time // start per the system clock when recorded
	Session    string
	DurMs      int64
	OffMs      int64
	Unverified bool
	Active     bool
	Size       int64
	path       string
	mtime      time.Time
}

func (s *Segment) Start() time.Time { return s.Raw.Add(time.Duration(s.OffMs) * time.Millisecond) }

func (s *Segment) End() time.Time {
	if s.Active {
		// Growing file: its end is "now" in its own (corrected) clock.
		return s.mtime.Add(time.Duration(s.OffMs) * time.Millisecond)
	}
	return s.Start().Add(time.Duration(s.DurMs) * time.Millisecond)
}

func (s *Segment) fileName() string {
	if s.Active {
		return s.ID + ".mp4"
	}
	name := fmt.Sprintf("%s.d%d", s.ID, s.DurMs)
	if s.Unverified {
		name += ".u"
	} else if s.OffMs != 0 {
		name += fmt.Sprintf(".o%d", s.OffMs)
	}
	return name + ".mp4"
}

func parseSegmentName(cam, dir, name string) (*Segment, bool) {
	m := segRe.FindStringSubmatch(name)
	if m == nil {
		return nil, false
	}
	raw, err := time.ParseInLocation("20060102-150405", m[1], time.UTC)
	if err != nil {
		return nil, false
	}
	s := &Segment{ID: m[1] + "-" + m[2], Cam: cam, Raw: raw, Session: m[2], path: filepath.Join(dir, name)}
	if m[3] == "" {
		s.Active = true // not finalized (yet)
	} else {
		s.DurMs, _ = strconv.ParseInt(m[3], 10, 64)
	}
	if m[4] != "" {
		s.OffMs, _ = strconv.ParseInt(m[4], 10, 64)
	}
	s.Unverified = m[5] == "u"
	return s, true
}

type Store struct {
	mu        sync.RWMutex
	root      string // .../recordings
	clock     *Clock
	incidents *IncidentLog
	segs      map[string][]*Segment // per camera, sorted by Start
	byID      map[string]*Segment   // cam/id
	sessions  map[string]int        // session -> clock epoch (this process only)
	mp4cache  map[string]*MP4Index  // cam/id -> index of finalized files
}

func newStore(root string, clock *Clock, inc *IncidentLog) *Store {
	return &Store{root: root, clock: clock, incidents: inc, segs: map[string][]*Segment{}, byID: map[string]*Segment{}, sessions: map[string]int{}, mp4cache: map[string]*MP4Index{}}
}

func (st *Store) camDir(cam string) string { return filepath.Join(st.root, cam) }

// Load indexes everything on disk. Called once at startup, before any recorder runs,
// so any unfinalized file is left over from a crash or power cut and is finalized now.
func (st *Store) Load() {
	_ = os.MkdirAll(st.root, 0o755)
	cams, _ := os.ReadDir(st.root)
	total := 0
	for _, c := range cams {
		if !c.IsDir() {
			continue
		}
		cam := c.Name()
		dir := st.camDir(cam)
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			s, ok := parseSegmentName(cam, dir, e.Name())
			if !ok {
				continue
			}
			if info, err := e.Info(); err == nil {
				s.Size, s.mtime = info.Size(), info.ModTime()
			}
			if s.Active {
				st.finalize(s, -1)
				if s.path == "" {
					continue // was junk and got deleted
				}
			}
			st.insert(s)
			total++
		}
	}
	logf("indexed %d recordings", total)
}

func (st *Store) insert(s *Segment) {
	st.mu.Lock()
	defer st.mu.Unlock()
	key := s.Cam + "/" + s.ID
	if old, ok := st.byID[key]; ok {
		*old = *s
		st.sortCam(s.Cam)
		return
	}
	st.byID[key] = s
	list := append(st.segs[s.Cam], s)
	st.segs[s.Cam] = list
	// Appends are almost always newest-last; only sort when needed.
	if n := len(list); n > 1 && list[n-1].Start().Before(list[n-2].Start()) {
		st.sortCam(s.Cam)
	}
}

func (st *Store) sortCam(cam string) {
	list := st.segs[cam]
	sort.SliceStable(list, func(i, j int) bool { return list[i].Start().Before(list[j].Start()) })
}

func (st *Store) remove(s *Segment) {
	st.mu.Lock()
	defer st.mu.Unlock()
	key := s.Cam + "/" + s.ID
	delete(st.byID, key)
	delete(st.mp4cache, key)
	list := st.segs[s.Cam]
	for i, x := range list {
		if x.ID == s.ID {
			st.segs[s.Cam] = append(list[:i], list[i+1:]...)
			break
		}
	}
}

// RegisterSession remembers which clock epoch a recorder session started in.
func (st *Store) RegisterSession(session string, epoch int) {
	st.mu.Lock()
	st.sessions[session] = epoch
	st.mu.Unlock()
}

// SyncSession is called by a recorder every couple of seconds. It indexes the session's
// files, finalizes all but the newest (or all, when final), and returns the active one.
func (st *Store) SyncSession(cam, session string, final bool) (active *Segment) {
	dir := st.camDir(cam)
	matches, _ := filepath.Glob(filepath.Join(dir, "*-"+session+".mp4"))
	sort.Strings(matches)
	st.mu.RLock()
	epoch, ok := st.sessions[session]
	st.mu.RUnlock()
	if !ok {
		epoch = -1
	}
	for i, p := range matches {
		s, ok := parseSegmentName(cam, dir, filepath.Base(p))
		if !ok {
			continue
		}
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		s.Size, s.mtime = info.Size(), info.ModTime()
		if off, known := st.clock.OffsetFor(max(epoch, 0)); known && epoch >= 0 {
			s.OffMs = off
		}
		if i == len(matches)-1 && !final {
			st.insert(s)
			active = s
			continue
		}
		st.finalize(s, epoch)
		if s.path != "" {
			st.insert(s)
		}
	}
	return active
}

// finalize measures a finished file and renames it with its duration and clock state.
func (st *Store) finalize(s *Segment, epoch int) {
	idx, err := parseMP4(s.path)
	if err != nil || len(idx.Fragments) == 0 || idx.Duration < 0.2 {
		// Nothing playable (camera dropped right after the file was opened).
		_ = os.Remove(s.path)
		st.remove(s)
		s.path = ""
		return
	}
	s.Active = false
	s.DurMs = int64(idx.Duration * 1000)
	s.OffMs, s.Unverified = 0, false
	if epoch >= 0 {
		if off, known := st.clock.OffsetFor(epoch); known {
			s.OffMs = off
		} else {
			s.Unverified = true
		}
	} else {
		// Left over from before this process started: we can't know its clock state.
		// Assume it was right unless it's from this boot and the clock is still unverified.
		if strings.HasPrefix(s.Session, st.clock.BootTag()) {
			if off, known := st.clock.OffsetFor(0); known {
				s.OffMs = off
			} else {
				s.Unverified = true
			}
		}
	}
	newPath := filepath.Join(filepath.Dir(s.path), s.fileName())
	if newPath != s.path {
		if err := os.Rename(s.path, newPath); err == nil {
			s.path = newPath
		}
	}
	st.mu.Lock()
	st.mp4cache[s.Cam+"/"+s.ID] = idx
	st.mu.Unlock()
}

// ApplyClockFix re-labels files recorded in an epoch once its true offset is known.
func (st *Store) ApplyClockFix(epoch int, offMs int64) {
	boot := st.clock.BootTag()
	st.mu.Lock()
	var todo []*Segment
	for _, list := range st.segs {
		for _, s := range list {
			if s.Active {
				continue
			}
			e, ok := st.sessions[s.Session]
			match := (ok && e == epoch) || (!ok && epoch == 0 && s.Unverified && strings.HasPrefix(s.Session, boot))
			if match && (s.Unverified || s.OffMs != offMs) {
				todo = append(todo, s)
			}
		}
	}
	st.mu.Unlock()
	if len(todo) == 0 {
		return
	}
	for _, s := range todo {
		st.mu.Lock()
		s.OffMs, s.Unverified = offMs, false
		newPath := filepath.Join(filepath.Dir(s.path), s.fileName())
		if err := os.Rename(s.path, newPath); err == nil {
			s.path = newPath
		}
		st.mu.Unlock()
	}
	st.mu.Lock()
	for cam := range st.segs {
		st.sortCam(cam)
	}
	st.mu.Unlock()
	st.incidents.Add("info", "", "Corrected timestamps of %d recordings (clock was off by %.1f s)", len(todo), float64(-offMs)/1000)
}

func (st *Store) Get(cam, id string) (*Segment, bool) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	s, ok := st.byID[cam+"/"+id]
	if !ok {
		return nil, false
	}
	cp := *s
	return &cp, true
}

func (st *Store) Path(cam, id string) string {
	st.mu.RLock()
	defer st.mu.RUnlock()
	if s, ok := st.byID[cam+"/"+id]; ok {
		return s.path
	}
	return ""
}

// Index returns the fragment map of a segment (cached once the file is final).
func (st *Store) Index(s *Segment) (*MP4Index, error) {
	key := s.Cam + "/" + s.ID
	if !s.Active {
		st.mu.RLock()
		idx, ok := st.mp4cache[key]
		st.mu.RUnlock()
		if ok {
			return idx, nil
		}
	}
	idx, err := parseMP4(st.Path(s.Cam, s.ID))
	if err != nil {
		return nil, err
	}
	if !s.Active {
		st.mu.Lock()
		if len(st.mp4cache) > 5000 {
			st.mp4cache = map[string]*MP4Index{}
		}
		st.mp4cache[key] = idx
		st.mu.Unlock()
	}
	return idx, nil
}

// Range returns copies of segments overlapping [from, to).
func (st *Store) Range(cam string, from, to time.Time) []Segment {
	st.mu.RLock()
	defer st.mu.RUnlock()
	list := st.segs[cam]
	// First segment that ends after `from` (segments are ~60 s, so back off a little).
	i := sort.Search(len(list), func(i int) bool { return !list[i].Start().Before(from.Add(-5 * time.Minute)) })
	var out []Segment
	for ; i < len(list); i++ {
		s := list[i]
		if !s.Start().Before(to) {
			break
		}
		if s.End().After(from) {
			out = append(out, *s)
		}
	}
	return out
}

type Span struct {
	Start int64 `json:"s"`
	End   int64 `json:"e"`
}

// Coverage merges recorded time into spans (unix ms); gaps under 3 s are ignored.
func (st *Store) Coverage(cam string, from, to time.Time) []Span {
	var spans []Span
	for _, s := range st.Range(cam, from, to) {
		a, b := s.Start().UnixMilli(), s.End().UnixMilli()
		if n := len(spans); n > 0 && a <= spans[n-1].End+3000 {
			if b > spans[n-1].End {
				spans[n-1].End = b
			}
			continue
		}
		spans = append(spans, Span{a, b})
	}
	if spans == nil {
		spans = []Span{}
	}
	return spans
}

type CamStorage struct {
	Bytes  int64 `json:"bytes"`
	Count  int   `json:"count"`
	Oldest int64 `json:"oldest"` // unix ms
	Newest int64 `json:"newest"`
	// Average write rate over the last 24 h, bytes/hour.
	RateBph int64 `json:"rate_bph"`
	// Share of the last 24 h (or since recording began) that is on disk, 0..100.
	Uptime24h float64 `json:"uptime_24h"`
}

func (st *Store) Stats() map[string]CamStorage {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := map[string]CamStorage{}
	dayAgo := time.Now().Add(-24 * time.Hour)
	for cam, list := range st.segs {
		var cs CamStorage
		var recent int64
		var recentMs int64
		var covered time.Duration
		for _, s := range list {
			cs.Bytes += s.Size
			cs.Count++
			if s.Start().After(dayAgo) {
				recent += s.Size
				recentMs += s.End().Sub(s.Start()).Milliseconds()
			}
			if e := s.End(); e.After(dayAgo) {
				b := s.Start()
				if b.Before(dayAgo) {
					b = dayAgo
				}
				covered += e.Sub(b)
			}
		}
		if len(list) > 0 {
			cs.Oldest = list[0].Start().UnixMilli()
			cs.Newest = list[len(list)-1].End().UnixMilli()
			from := dayAgo
			if o := list[0].Start(); o.After(from) {
				from = o
			}
			if win := time.Since(from); win > time.Minute {
				cs.Uptime24h = min(100, float64(covered)*100/float64(win))
			}
		}
		if recentMs > 60_000 {
			cs.RateBph = recent * 3_600_000 / recentMs
		}
		out[cam] = cs
	}
	return out
}

type DiskUsage struct {
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
	Used  uint64 `json:"used"`
}

func diskUsage(path string) DiskUsage {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return DiskUsage{}
	}
	total := fs.Blocks * uint64(fs.Bsize)
	free := fs.Bavail * uint64(fs.Bsize)
	return DiskUsage{Total: total, Free: free, Used: total - fs.Bfree*uint64(fs.Bsize)}
}

// Retention is how long a camera's footage is kept: everything for Days, and the files
// that contain motion for MotionDays (when longer).
type Retention struct {
	Days       int
	MotionDays int
}

func (r Retention) Longest() int { return max(r.Days, r.MotionDays) }

// Cleanup enforces retention and the free-space floor. It never touches files being written.
// motion holds each camera's motion spans (merged, sorted, already padded).
func (st *Store) Cleanup(pol map[string]Retention, def Retention, minFreeGB float64, motion map[string][]Span) {
	now := time.Now()
	boot := st.clock.BootTag()
	var expired []*Segment
	st.mu.RLock()
	for cam, list := range st.segs {
		r, ok := pol[cam]
		if !ok {
			r = def
		}
		cutoff := now.Add(-time.Duration(r.Days) * 24 * time.Hour)
		motionCutoff := now.Add(-time.Duration(r.Longest()) * 24 * time.Hour)
		for _, s := range list {
			if !s.End().Before(cutoff) {
				break
			}
			// A file from this boot whose time we haven't verified may only *look* old
			// (clock set back after a power cut); keep it until the clock is known.
			if s.Active || (s.Unverified && strings.HasPrefix(s.Session, boot)) {
				continue
			}
			if s.End().After(motionCutoff) && overlaps(motion[cam], s.Start().UnixMilli(), s.End().UnixMilli()) {
				continue
			}
			expired = append(expired, s)
		}
	}
	st.mu.RUnlock()
	for _, s := range expired {
		st.delete(s)
	}
	if len(expired) > 0 {
		logf("retention: removed %d old recordings", len(expired))
	}

	// Free-space floor: drop the oldest recordings across all cameras.
	floor := uint64(minFreeGB * 1e9)
	removed := 0
	for diskUsage(st.root).Free < floor {
		s := st.oldest()
		if s == nil {
			break
		}
		st.delete(s)
		removed++
		if removed%50 == 0 && diskUsage(st.root).Free >= floor {
			break
		}
	}
	if removed > 0 {
		st.incidents.Add("warn", "", "Disk nearly full: removed %d oldest recordings to keep %.0f GB free", removed, minFreeGB)
	}
}

// overlaps reports whether [from, to] touches any of the sorted, merged spans.
func overlaps(spans []Span, from, to int64) bool {
	i := sort.Search(len(spans), func(i int) bool { return spans[i].End >= from })
	return i < len(spans) && spans[i].Start <= to
}

func (st *Store) oldest() *Segment {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var best *Segment
	for _, list := range st.segs {
		for _, s := range list {
			if s.Active {
				continue
			}
			if best == nil || s.Start().Before(best.Start()) {
				best = s
			}
			break
		}
	}
	return best
}

func (st *Store) delete(s *Segment) {
	st.mu.RLock()
	p := s.path
	st.mu.RUnlock()
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		logf("delete %s: %v", p, err)
		return
	}
	st.remove(s)
}

// DeleteCamera removes every recording of a camera (used when the user asks to).
func (st *Store) DeleteCamera(cam string) {
	st.mu.RLock()
	list := append([]*Segment(nil), st.segs[cam]...)
	st.mu.RUnlock()
	for _, s := range list {
		if !s.Active {
			st.delete(s)
		}
	}
}

func (st *Store) Cameras() []string {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []string
	for cam := range st.segs {
		out = append(out, cam)
	}
	sort.Strings(out)
	return out
}
