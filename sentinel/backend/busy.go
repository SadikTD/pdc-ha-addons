package main

import (
	"os"
	"strconv"
	"strings"
)

// Catching up on older events (object detection, faces) is work that can wait. It waits
// while the machine is short of CPU or waiting on the disk (Linux pressure stall
// information, for the whole machine: Home Assistant, its database and other add-ons
// included), so the backlog never makes Home Assistant slow. Events happening now are
// always checked at once.

const (
	busyCPU = 25.0 // % of the last 10 s something was waiting for a CPU
	busyIO  = 10.0 // % of the last 10 s everything was waiting on the disk
)

func systemBusy() bool {
	return pressure("/proc/pressure/cpu", "some") >= busyCPU || pressure("/proc/pressure/io", "full") >= busyIO
}

// pressure reads avg10 of a line ("some" or "full") of a PSI file; 0 when unavailable.
func pressure(path, kind string) float64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != kind {
			continue
		}
		if v, ok := strings.CutPrefix(f[1], "avg10="); ok {
			n, _ := strconv.ParseFloat(v, 64)
			return n
		}
	}
	return 0
}
