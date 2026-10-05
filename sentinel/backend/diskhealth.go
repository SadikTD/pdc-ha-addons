package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DiskHealth watches the two disks the Pi depends on — Home Assistant's (an SSD) and
// the recordings disk (a memory card) — for the System dashboard: how busy each is,
// how long writes take, stalls, and the SSD's own SMART health and wear.
type DiskHealth struct {
	recDisk *RecDisk

	mu    sync.Mutex
	state map[string]any
	disks map[string]*diskTrack // by kind: "ha", "rec"
	smart map[string]any
}

type diskTrack struct {
	name   string // whole disk, e.g. sda
	last   diskSample
	busy   float64 // % of the last minute
	rMBs   float64
	wMBs   float64
	wAwait float64 // ms per write, last minute
	peak   float64 // worst 2 s write latency, last minute (ms)
	stalls []int64 // unix seconds of 2 s windows that stalled, last hour
	win    []diskSample
}

type diskSample struct {
	t                  time.Time
	reads, rsect, rms  uint64
	writes, wsect, wms uint64
	ioTicks            uint64
}

func newDiskHealth(rd *RecDisk) *DiskHealth {
	return &DiskHealth{recDisk: rd, disks: map[string]*diskTrack{}}
}

func (h *DiskHealth) State() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state
}

func (h *DiskHealth) Run(ctx context.Context, publish func(map[string]any)) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	var lastPub, lastSmart time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			h.sample(now)
			if now.Sub(lastSmart) > 10*time.Minute {
				lastSmart = now
				go h.readSmart()
			}
			if now.Sub(lastPub) >= time.Minute {
				lastPub = now
				st := h.snapshot()
				h.mu.Lock()
				h.state = st
				h.mu.Unlock()
				publish(st)
			}
		}
	}
}

// diskOf returns the whole-disk name holding the filesystem at path (sda for sda8).
func diskOf(path string) string {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	defer f.Close()
	best, dev := "", ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		if len(fs) < 5 {
			continue
		}
		mp := fs[4]
		if (path == mp || strings.HasPrefix(path, strings.TrimSuffix(mp, "/")+"/")) && len(mp) > len(best) {
			best, dev = mp, fs[2]
		}
	}
	if dev == "" {
		return ""
	}
	link, err := filepath.EvalSymlinks("/sys/dev/block/" + dev)
	if err != nil {
		return ""
	}
	// .../block/sda/sda8 → sda; .../block/sda → sda
	if _, err := os.Stat(filepath.Join(link, "partition")); err == nil {
		return filepath.Base(filepath.Dir(link))
	}
	return filepath.Base(link)
}

func readDiskstats() map[string]diskSample {
	raw, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return nil
	}
	now := time.Now()
	out := map[string]diskSample{}
	for _, line := range strings.Split(string(raw), "\n") {
		fs := strings.Fields(line)
		if len(fs) < 13 {
			continue
		}
		n := func(i int) uint64 { v, _ := strconv.ParseUint(fs[i], 10, 64); return v }
		out[fs[2]] = diskSample{t: now, reads: n(3), rsect: n(5), rms: n(6), writes: n(7), wsect: n(9), wms: n(10), ioTicks: n(12)}
	}
	return out
}

func (h *DiskHealth) sample(now time.Time) {
	stats := readDiskstats()
	want := map[string]string{"ha": diskOf("/media")}
	if h.recDisk.Mounted() {
		want["rec"] = diskOf(h.recDisk.Base())
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for kind, name := range want {
		s, ok := stats[name]
		if name == "" || !ok {
			delete(h.disks, kind)
			continue
		}
		d := h.disks[kind]
		if d == nil || d.name != name {
			d = &diskTrack{name: name}
			h.disks[kind] = d
		}
		if !d.last.t.IsZero() {
			dw, dwms := s.writes-d.last.writes, s.wms-d.last.wms
			// A write that took over half a second on average across a 2 s window is a
			// stall: whatever waits on this disk (a database, a recorder) stops with it.
			if dw > 0 && float64(dwms)/float64(dw) > 500 || s.ioTicks-d.last.ioTicks > 1900 && dw == 0 && s.reads == d.last.reads {
				d.stalls = append(d.stalls, now.Unix())
			}
		}
		d.last = s
		d.win = append(d.win, s)
		for len(d.win) > 0 && now.Sub(d.win[0].t) > 62*time.Second {
			d.win = d.win[1:]
		}
		for len(d.stalls) > 0 && now.Unix()-d.stalls[0] > 3600 {
			d.stalls = d.stalls[1:]
		}
		if len(d.win) >= 2 {
			a, b := d.win[0], d.win[len(d.win)-1]
			sec := b.t.Sub(a.t).Seconds()
			d.busy = min(100, float64(b.ioTicks-a.ioTicks)/10/sec)
			d.rMBs = float64(b.rsect-a.rsect) * 512 / 1e6 / sec
			d.wMBs = float64(b.wsect-a.wsect) * 512 / 1e6 / sec
			d.wAwait = 0
			if w := b.writes - a.writes; w > 0 {
				d.wAwait = float64(b.wms-a.wms) / float64(w)
			}
			d.peak = 0
			for i := 1; i < len(d.win); i++ {
				if w := d.win[i].writes - d.win[i-1].writes; w > 0 {
					d.peak = max(d.peak, float64(d.win[i].wms-d.win[i-1].wms)/float64(w))
				}
			}
		}
	}
}

// pressure60 reads the avg60 "some" and "full" values of a PSI file.
func pressure60(kind string) (some, full float64) {
	raw, _ := os.ReadFile("/proc/pressure/" + kind)
	for _, line := range strings.Split(string(raw), "\n") {
		fs := strings.Fields(line)
		if len(fs) < 3 {
			continue
		}
		v, _ := strconv.ParseFloat(strings.TrimPrefix(fs[2], "avg60="), 64)
		switch fs[0] {
		case "some":
			some = v
		case "full":
			full = v
		}
	}
	return
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

func (h *DiskHealth) snapshot() map[string]any {
	ioSome, ioFull := pressure60("io")
	cpuSome, _ := pressure60("cpu")
	st := map[string]any{"io_wait": round1(ioSome), "io_stall": round1(ioFull), "cpu_wait": round1(cpuSome)}
	h.mu.Lock()
	defer h.mu.Unlock()
	for kind, d := range h.disks {
		st[kind+"_disk"] = d.name
		st[kind+"_busy"] = round1(d.busy)
		st[kind+"_read"] = round1(d.rMBs)
		st[kind+"_write"] = round1(d.wMBs)
		st[kind+"_latency"] = round1(d.wAwait)
		st[kind+"_latency_peak"] = round1(d.peak)
		st[kind+"_stalls_1h"] = len(d.stalls) * 2 // seconds
		st[kind+"_model"] = strings.TrimSpace(readSys("/sys/block/" + d.name + "/device/model"))
		if v, err := strconv.ParseFloat(strings.TrimSpace(readSys("/sys/block/"+d.name+"/size")), 64); err == nil {
			st[kind+"_size_gb"] = round1(v * 512 / 1e9)
		}
	}
	if h.recDisk.Mounted() {
		du := diskUsage(h.recDisk.Base())
		st["rec_free_gb"] = round1(float64(du.Free) / 1e9)
		st["rec_used_pct"] = round1(float64(du.Used) / float64(max(du.Total, 1)) * 100)
	}
	st["rec_mounted"] = h.recDisk.Mounted()
	for k, v := range h.smart {
		st["ssd_"+k] = v
	}
	return st
}

func readSys(p string) string { b, _ := os.ReadFile(p); return string(b) }

// readSmart asks Home Assistant's disk (through its USB bridge) for its SMART data.
func (h *DiskHealth) readSmart() {
	h.mu.Lock()
	d := h.disks["ha"]
	h.mu.Unlock()
	if d == nil {
		return
	}
	node, err := devNode(d.name)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var out []byte
	for _, typ := range []string{"sat", "auto"} {
		out, _ = exec.CommandContext(ctx, "nice", "-n", "19", "smartctl", "-j", "-H", "-A", "-i", "-d", typ, node).Output()
		if len(out) > 0 && strings.Contains(string(out), "smart_status") {
			break
		}
	}
	var r struct {
		Model  string `json:"model_name"`
		Status *struct {
			Passed bool `json:"passed"`
		} `json:"smart_status"`
		Temp struct {
			Current float64 `json:"current"`
		} `json:"temperature"`
		Hours struct {
			Hours float64 `json:"hours"`
		} `json:"power_on_time"`
		Attrs struct {
			Table []struct {
				ID    int `json:"id"`
				Value int `json:"value"`
				Raw   struct {
					Value float64 `json:"value"`
				} `json:"raw"`
			} `json:"table"`
		} `json:"ata_smart_attributes"`
		NVMe *struct {
			Used float64 `json:"percentage_used"`
		} `json:"nvme_smart_health_information_log"`
	}
	if json.Unmarshal(out, &r) != nil || r.Status == nil {
		return
	}
	raw := map[int]float64{}
	norm := map[int]int{}
	for _, a := range r.Attrs.Table {
		raw[a.ID], norm[a.ID] = a.Raw.Value, a.Value
	}
	sm := map[string]any{"model": r.Model, "healthy": r.Status.Passed, "temp": r.Temp.Current, "hours": r.Hours.Hours}
	// Life left: NVMe reports it; SATA drives differ by vendor. Average erase count
	// against the NAND's rated cycles (attributes 167/168, Silicon Motion-based drives
	// such as Transcend) is the most direct; otherwise common "life left" attributes.
	life, known := 0.0, true
	switch {
	case r.NVMe != nil:
		life = 100 - r.NVMe.Used
	case raw[168] > 0 && raw[167] > 0:
		life = 100 * (1 - raw[167]/raw[168])
	case norm[231] > 0:
		life = float64(norm[231])
	case norm[233] > 0:
		life = float64(norm[233])
	case norm[177] > 0:
		life = float64(norm[177])
	default:
		known = false
	}
	if known {
		sm["life"] = round1(max(0, life))
	}
	if raw[167] > 0 && raw[168] > 0 {
		sm["wear_pct"] = round1(raw[167] / raw[168] * 100)
	}
	sm["crc_errors"] = raw[199]
	sm["bad_blocks"] = raw[5] + raw[197] + raw[198]
	h.mu.Lock()
	h.smart = sm
	h.mu.Unlock()
}
