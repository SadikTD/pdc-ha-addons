package main

import (
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Preview frames (small JPEGs every couple of seconds) make timeline scrubbing instant:
// the player shows these while you drag, then seeks the real video when you let go.
// Frames are appended to one file per camera per UTC hour:
//   [8-byte unix ms][4-byte length][JPEG] ...
// A power cut can only truncate the last record, which the reader skips.

const previewInterval = 2 * time.Second

type previewEntry struct {
	t   int64
	off int64
	n   uint32
}

type PreviewStore struct {
	mu      sync.Mutex
	root    string
	files   map[string]*os.File         // cam -> open file for the current hour
	hourOf  map[string]string           // cam -> hour key of the open file
	index   map[string][]previewEntry   // cam/hour -> entries
	latest  map[string][]byte           // cam -> newest frame
	lastAt  map[string]time.Time
}

func newPreviewStore(root string) *PreviewStore {
	return &PreviewStore{root: root, files: map[string]*os.File{}, hourOf: map[string]string{}, index: map[string][]previewEntry{}, latest: map[string][]byte{}, lastAt: map[string]time.Time{}}
}

func hourKey(t time.Time) string { return t.UTC().Format("20060102-15") }

func (ps *PreviewStore) path(cam, hour string) string {
	return filepath.Join(ps.root, cam, hour+".bin")
}

// Add stores a frame taken at t (true time). Frames closer than previewInterval are dropped.
func (ps *PreviewStore) Add(cam string, t time.Time, jpeg []byte) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.latest[cam] = jpeg
	if t.Sub(ps.lastAt[cam]) < previewInterval-200*time.Millisecond && t.After(ps.lastAt[cam]) {
		return
	}
	ps.lastAt[cam] = t
	hour := hourKey(t)
	f := ps.files[cam]
	if f == nil || ps.hourOf[cam] != hour {
		if f != nil {
			f.Close()
		}
		_ = os.MkdirAll(filepath.Join(ps.root, cam), 0o755)
		var err error
		f, err = os.OpenFile(ps.path(cam, hour), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			delete(ps.files, cam)
			return
		}
		ps.files[cam], ps.hourOf[cam] = f, hour
		if _, ok := ps.index[cam+"/"+hour]; !ok {
			ps.index[cam+"/"+hour] = ps.scan(cam, hour)
		}
	}
	st, err := f.Stat()
	if err != nil {
		return
	}
	var hdr [12]byte
	binary.BigEndian.PutUint64(hdr[0:8], uint64(t.UnixMilli()))
	binary.BigEndian.PutUint32(hdr[8:12], uint32(len(jpeg)))
	if _, err := f.Write(append(hdr[:], jpeg...)); err != nil {
		return
	}
	key := cam + "/" + hour
	ps.index[key] = append(ps.index[key], previewEntry{t: t.UnixMilli(), off: st.Size() + 12, n: uint32(len(jpeg))})
}

// scan reads an hour file's record headers; caller holds the lock.
func (ps *PreviewStore) scan(cam, hour string) []previewEntry {
	f, err := os.Open(ps.path(cam, hour))
	if err != nil {
		return nil
	}
	defer f.Close()
	st, _ := f.Stat()
	size := st.Size()
	var out []previewEntry
	var hdr [12]byte
	for off := int64(0); off+12 <= size; {
		if _, err := f.ReadAt(hdr[:], off); err != nil && err != io.EOF {
			break
		}
		t := int64(binary.BigEndian.Uint64(hdr[0:8]))
		n := binary.BigEndian.Uint32(hdr[8:12])
		if n == 0 || n > 4<<20 || off+12+int64(n) > size {
			break
		}
		out = append(out, previewEntry{t: t, off: off + 12, n: n})
		off += 12 + int64(n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].t < out[j].t })
	return out
}

func (ps *PreviewStore) entries(cam, hour string) []previewEntry {
	key := cam + "/" + hour
	if e, ok := ps.index[key]; ok {
		return e
	}
	e := ps.scan(cam, hour)
	if len(ps.index) > 400 { // bound memory: drop cached hours (they re-scan quickly)
		for k := range ps.index {
			if !strings.HasSuffix(k, "/"+ps.hourOf[strings.SplitN(k, "/", 2)[0]]) {
				delete(ps.index, k)
			}
		}
	}
	ps.index[key] = e
	return e
}

// Get returns the frame nearest to t (within 6 s), and its timestamp.
func (ps *PreviewStore) Get(cam string, t time.Time) ([]byte, int64, bool) {
	ps.mu.Lock()
	var best previewEntry
	var bestHour string
	bestD := int64(6000)
	for _, h := range []time.Time{t, t.Add(-time.Hour), t.Add(time.Hour)} {
		hour := hourKey(h)
		list := ps.entries(cam, hour)
		i := sort.Search(len(list), func(i int) bool { return list[i].t >= t.UnixMilli() })
		for _, j := range []int{i - 1, i} {
			if j < 0 || j >= len(list) {
				continue
			}
			d := list[j].t - t.UnixMilli()
			if d < 0 {
				d = -d
			}
			if d < bestD {
				bestD, best, bestHour = d, list[j], hour
			}
		}
	}
	ps.mu.Unlock()
	if bestHour == "" {
		return nil, 0, false
	}
	f, err := os.Open(ps.path(cam, bestHour))
	if err != nil {
		return nil, 0, false
	}
	defer f.Close()
	buf := make([]byte, best.n)
	if _, err := f.ReadAt(buf, best.off); err != nil {
		return nil, 0, false
	}
	return buf, best.t, true
}

func (ps *PreviewStore) Latest(cam string) []byte {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.latest[cam]
}

func (ps *PreviewStore) Cleanup(retain map[string]int, defaultDays int) {
	cams, _ := os.ReadDir(ps.root)
	for _, c := range cams {
		days, ok := retain[c.Name()]
		if !ok {
			days = defaultDays
		}
		cut := hourKey(time.Now().Add(-time.Duration(days) * 24 * time.Hour))
		files, _ := filepath.Glob(filepath.Join(ps.root, c.Name(), "*.bin"))
		for _, f := range files {
			hour := strings.TrimSuffix(filepath.Base(f), ".bin")
			if hour < cut {
				ps.mu.Lock()
				delete(ps.index, c.Name()+"/"+hour)
				ps.mu.Unlock()
				_ = os.Remove(f)
			}
		}
	}
}

func (ps *PreviewStore) Close() {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for _, f := range ps.files {
		f.Close()
	}
}

// splitJPEGs cuts an MJPEG byte stream (ffmpeg image2pipe) into frames.
func splitJPEGs(r io.Reader, emit func([]byte)) {
	buf := make([]byte, 0, 64*1024)
	chunk := make([]byte, 32*1024)
	for {
		n, err := r.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			for {
				start := indexPair(buf, 0xFF, 0xD8, 0)
				if start < 0 {
					buf = buf[:0]
					break
				}
				end := indexPair(buf, 0xFF, 0xD9, start+2)
				if end < 0 {
					if start > 0 {
						buf = append(buf[:0], buf[start:]...)
					}
					break
				}
				frame := make([]byte, end+2-start)
				copy(frame, buf[start:end+2])
				emit(frame)
				buf = append(buf[:0], buf[end+2:]...)
			}
			if len(buf) > 8<<20 { // garbage; resync
				buf = buf[:0]
			}
		}
		if err != nil {
			return
		}
	}
}

func indexPair(b []byte, x, y byte, from int) int {
	for i := from; i+1 < len(b); i++ {
		if b[i] == x && b[i+1] == y {
			return i
		}
	}
	return -1
}
