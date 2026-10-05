package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Workload explains, in plain words, how hard the Pi is working and what is keeping it
// busy (System dashboard): an overall verdict, an effort score for graphs, and the share
// of the Pi each app (Home Assistant, Sentinel, the other add-ons) is using. App shares
// come from the Supervisor's container stats (needs hassio_role: manager).
type Workload struct {
	disks *DiskHealth // per-disk delays: the card stalling must not read as "Pi overloaded"

	mu    sync.Mutex
	state map[string]any

	lastCPU  cpuTimes
	lastApps map[string]appSample
	names    map[string]string
	namesAt  time.Time
}

type cpuTimes struct{ busy, total uint64 }

type appSample struct{ cpu, system uint64 }

type appUse struct {
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"` // % of the whole Pi
	MemM float64 `json:"mem"` // MB
}

func newWorkload(disks *DiskHealth) *Workload {
	return &Workload{disks: disks, lastApps: map[string]appSample{}, names: map[string]string{}}
}

func (w *Workload) State() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.state
}

func (w *Workload) Run(ctx context.Context, publish func(map[string]any)) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	w.sample() // baseline
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			st := w.sample()
			w.mu.Lock()
			w.state = st
			w.mu.Unlock()
			publish(st)
		}
	}
}

func readCPU() cpuTimes {
	raw, _ := os.ReadFile("/proc/stat")
	line, _, _ := strings.Cut(string(raw), "\n")
	fs := strings.Fields(line)
	var c cpuTimes
	for i, f := range fs[min(1, len(fs)):] {
		v, _ := strconv.ParseUint(f, 10, 64)
		c.total += v
		if i != 3 && i != 4 { // idle, iowait
			c.busy += v
		}
	}
	return c
}

func memAvailablePct() float64 {
	raw, _ := os.ReadFile("/proc/meminfo")
	var total, avail float64
	for _, l := range strings.Split(string(raw), "\n") {
		fs := strings.Fields(l)
		if len(fs) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(fs[1], 64)
		switch fs[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total == 0 {
		return 100
	}
	return avail / total * 100
}

func cpuTemp() float64 {
	raw, _ := os.ReadFile("/sys/class/thermal/thermal_zone0/temp")
	v, _ := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	return v / 1000
}

func loadAvg() (l1, l5 float64) {
	raw, _ := os.ReadFile("/proc/loadavg")
	fs := strings.Fields(string(raw))
	if len(fs) >= 2 {
		l1, _ = strconv.ParseFloat(fs[0], 64)
		l5, _ = strconv.ParseFloat(fs[1], 64)
	}
	return
}

// apps returns each running app's share of the whole Pi since the last call.
func (w *Workload) apps() []appUse {
	if time.Since(w.namesAt) > 10*time.Minute {
		if b, err := supervisorRequest("GET", "/addons", nil); err == nil {
			var r struct {
				Data struct {
					Addons []struct{ Slug, Name, State string } `json:"addons"`
				} `json:"data"`
			}
			if json.Unmarshal(b, &r) == nil {
				names := map[string]string{"core": "Home Assistant", "supervisor": "Supervisor"}
				for _, a := range r.Data.Addons {
					if a.State == "started" {
						names[a.Slug] = a.Name
					}
				}
				w.names, w.namesAt = names, time.Now()
			}
		}
	}
	var out []appUse
	seen := map[string]appSample{}
	for slug, name := range w.names {
		path := "/addons/" + slug + "/stats"
		if slug == "core" || slug == "supervisor" {
			path = "/" + slug + "/stats"
		}
		b, err := supervisorRequest("GET", path, nil)
		if err != nil {
			continue
		}
		var r struct {
			Data struct {
				CPU    uint64  `json:"cpu_usage"`
				System uint64  `json:"cpu_system_usage"`
				Mem    float64 `json:"memory_usage"`
			} `json:"data"`
		}
		if json.Unmarshal(b, &r) != nil {
			continue
		}
		cur := appSample{r.Data.CPU, r.Data.System}
		seen[slug] = cur
		prev, ok := w.lastApps[slug]
		if !ok || cur.system <= prev.system || cur.cpu < prev.cpu {
			continue
		}
		share := float64(cur.cpu-prev.cpu) / float64(cur.system-prev.system) * 100
		out = append(out, appUse{Name: name, CPU: round1(share), MemM: math.Round(r.Data.Mem / 1e6)})
	}
	w.lastApps = seen
	sort.Slice(out, func(i, j int) bool { return out[i].CPU > out[j].CPU })
	return out
}

var workLevels = []string{"Relaxed", "Comfortable", "Busy", "Very busy", "Overloaded"}

func (w *Workload) sample() map[string]any {
	c := readCPU()
	cpu := 0.0
	if d := c.total - w.lastCPU.total; w.lastCPU.total > 0 && d > 0 {
		cpu = float64(c.busy-w.lastCPU.busy) / float64(d) * 100
	}
	w.lastCPU = c
	cpuWait, _ := pressure60("cpu")
	ioWait, _ := pressure60("io")
	// The system-wide "waiting on disk" figure also counts Sentinel waiting on the
	// recordings card, which slows nothing else. Judge the disk by Home Assistant's own:
	// its worst write delay in the last minute.
	num := func(st map[string]any, k string) float64 { v, _ := st[k].(float64); return v }
	dh := w.disks.State()
	haPeak, cardPeak := num(dh, "ha_latency_peak"), num(dh, "rec_latency_peak")
	memFree := memAvailablePct()
	temp := cpuTemp()
	l1, l5 := loadAvg()
	apps := w.apps()

	// One effort score (0-100) for graphs: whichever limit is closest to being hit.
	effort := max(cpu, cpuWait*2.5, haPeak/5, (100-memFree-20)*1.25, (temp-55)*4)
	effort = math.Round(min(100, max(0, effort)))

	lvl := 0
	switch {
	case cpuWait >= 40 || haPeak >= 1000 || memFree < 5 || temp >= 80:
		lvl = 4
	case cpuWait >= 20 || cpu >= 85 || haPeak >= 300 || memFree < 12 || temp >= 75:
		lvl = 3
	case cpu >= 55 || cpuWait >= 8 || haPeak >= 100 || temp >= 68:
		lvl = 2
	case cpu >= 15:
		lvl = 1
	}

	// Why, in words.
	var why []string
	if cpuWait >= 8 {
		why = append(why, fmt.Sprintf("jobs are queuing for the processor %.0f%% of the time", cpuWait))
	}
	if haPeak >= 100 {
		why = append(why, fmt.Sprintf("Home Assistant's disk is slow (writes up to %.1f s)", haPeak/1000))
	}
	if memFree < 12 {
		why = append(why, fmt.Sprintf("only %.0f%% memory left", memFree))
	}
	if temp >= 68 {
		why = append(why, fmt.Sprintf("running hot (%.0f °C)", temp))
	}
	top := ""
	if len(apps) > 0 && apps[0].CPU >= 2 {
		top = apps[0].Name
	}
	var summary string
	switch {
	case len(why) > 0:
		summary = strings.ToUpper(why[0][:1]) + why[0][1:]
		for _, s := range why[1:] {
			summary += ", " + s
		}
		summary += "."
		if top != "" {
			summary += fmt.Sprintf(" %s uses the most (%.0f%% of the Pi).", top, apps[0].CPU)
		}
	case top != "":
		summary = fmt.Sprintf("Using %.0f%% of its power — mostly %s (%.0f%%). %s", cpu, top, apps[0].CPU, headroom(cpu))
	default:
		summary = fmt.Sprintf("Using %.0f%% of its power. %s", cpu, headroom(cpu))
	}

	if cardPeak >= 500 {
		summary += " The recordings card is catching up (writes up to " + fmt.Sprintf("%.1f", cardPeak/1000) + " s) — that only delays saving video, not Home Assistant."
	}

	appsOut := apps
	if len(appsOut) > 8 {
		appsOut = appsOut[:8]
	}
	return map[string]any{
		"level": lvl, "verdict": workLevels[lvl], "summary": summary, "effort": effort,
		"cpu": round1(cpu), "cpu_wait": round1(cpuWait), "io_wait": round1(ioWait), "ha_peak": round1(haPeak), "card_peak": round1(cardPeak), "mem_free": round1(memFree),
		"temp": round1(temp), "load1": l1, "load5": l5, "cores": runtime.NumCPU(), "top": top, "apps": appsOut,
	}
}

func headroom(cpu float64) string {
	switch {
	case cpu < 30:
		return "Plenty of room to spare."
	case cpu < 60:
		return "Still has room to spare."
	default:
		return "Not much room left."
	}
}
