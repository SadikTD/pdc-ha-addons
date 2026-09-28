package main

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// The host clock can't be trusted: after a power cut the Pi (no RTC battery) boots with a
// stale time, and while the internet is down (load shedding, router restart) NTP can't fix
// it. Recording must never wait for the clock, so files are always written immediately and
// named by the system clock, and Clock works out how wrong that clock was so names can be
// corrected afterwards.
//
// An "epoch" is a stretch of time with no clock steps. Each recorder session remembers the
// epoch it started in; when the clock steps, recorders restart so no file spans two epochs.

const clockTolerance = 2 * time.Second

var ntpServers = []string{"time.cloudflare.com", "time.google.com", "pool.ntp.org", "time.windows.com"}

type epochOffset struct {
	ms    int64
	known bool
}

type ClockStatus struct {
	Synced      bool   `json:"synced"`       // we know the true time
	OffsetMs    int64  `json:"offset_ms"`    // true time - system time
	LastCheck   int64  `json:"last_check"`   // unix ms of last NTP attempt
	LastSuccess int64  `json:"last_success"` // unix ms
	Server      string `json:"server"`
	Error       string `json:"error,omitempty"`
	Jumps       int    `json:"jumps"`
}

type Clock struct {
	mu      sync.Mutex
	epoch   int
	offsets map[int]epochOffset
	status  ClockStatus
	bootID  string
	// Called (outside the lock) when an epoch's offset becomes known or the clock steps.
	onFix  func(epoch int, ms int64)
	onJump func(jump time.Duration)
}

func newClock() *Clock {
	c := &Clock{offsets: map[int]epochOffset{0: {}}}
	if b, err := os.ReadFile("/proc/sys/kernel/random/boot_id"); err == nil {
		c.bootID = strings.ReplaceAll(strings.TrimSpace(string(b)), "-", "")
	}
	if len(c.bootID) < 4 {
		c.bootID = "0000"
	}
	return c
}

// BootTag identifies this host boot; files from the same boot share one continuous clock.
func (c *Clock) BootTag() string { return c.bootID[:4] }

func (c *Clock) Epoch() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.epoch
}

// OffsetFor returns the correction for files recorded in an epoch.
func (c *Clock) OffsetFor(epoch int) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	o := c.offsets[epoch]
	return o.ms, o.known
}

func (c *Clock) Status() ClockStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

// Now is the best estimate of the true time.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	o := c.offsets[c.epoch]
	c.mu.Unlock()
	return time.Now().Add(time.Duration(o.ms) * time.Millisecond)
}

func (c *Clock) Run(ctx context.Context) {
	go c.watchJumps(ctx)
	for {
		c.check()
		wait := 10 * time.Minute
		if !c.Status().Synced {
			wait = time.Minute
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (c *Clock) check() {
	var offs []time.Duration
	var server string
	var lastErr error
	for _, s := range ntpServers {
		o, err := sntpQuery(s)
		if err != nil {
			lastErr = err
			continue
		}
		if server == "" {
			server = s
		}
		offs = append(offs, o)
		if len(offs) == 3 {
			break
		}
	}
	now := time.Now().UnixMilli()
	c.mu.Lock()
	c.status.LastCheck = now
	if len(offs) == 0 {
		c.status.Error = "no NTP server reachable"
		if lastErr != nil {
			c.status.Error += ": " + lastErr.Error()
		}
		c.mu.Unlock()
		return
	}
	sort.Slice(offs, func(i, j int) bool { return offs[i] < offs[j] })
	med := offs[len(offs)/2]
	ms := med.Milliseconds()
	if med > -clockTolerance && med < clockTolerance {
		ms = 0
	}
	prev := c.offsets[c.epoch]
	c.offsets[c.epoch] = epochOffset{ms: ms, known: true}
	c.status = ClockStatus{Synced: true, OffsetMs: med.Milliseconds(), LastCheck: now, LastSuccess: now, Server: server, Jumps: c.status.Jumps}
	epoch := c.epoch
	fix := c.onFix
	c.mu.Unlock()
	// Only re-label files when the correction actually changed meaningfully.
	if fix != nil && (!prev.known || abs64(prev.ms-ms) > clockTolerance.Milliseconds()) {
		fix(epoch, ms)
	}
}

func (c *Clock) watchJumps(ctx context.Context) {
	last := time.Now()
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			now = time.Now()
			jump := now.Round(0).Sub(last.Round(0)) - now.Sub(last)
			last = now
			if jump > -clockTolerance && jump < clockTolerance {
				continue
			}
			c.mu.Lock()
			old := c.offsets[c.epoch]
			// If we didn't know the true time, assume the step was NTP correcting the clock.
			if !old.known {
				old = epochOffset{ms: jump.Milliseconds(), known: true}
				c.offsets[c.epoch] = old
			}
			oldEpoch := c.epoch
			c.epoch++
			c.offsets[c.epoch] = epochOffset{ms: old.ms - jump.Milliseconds(), known: false}
			c.status.Jumps++
			fix, onJump := c.onFix, c.onJump
			c.mu.Unlock()
			if fix != nil {
				fix(oldEpoch, old.ms)
			}
			if onJump != nil {
				onJump(jump)
			}
			go c.check() // re-measure against NTP for the new epoch
		}
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// sntpQuery returns true time - local time according to one server.
func sntpQuery(server string) (time.Duration, error) {
	conn, err := net.DialTimeout("udp", net.JoinHostPort(server, "123"), 3*time.Second)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	req := make([]byte, 48)
	req[0] = 0x23 // LI=0, VN=4, Mode=3 (client)
	t1 := time.Now()
	if _, err := conn.Write(req); err != nil {
		return 0, err
	}
	resp := make([]byte, 48)
	n, err := conn.Read(resp)
	t4 := time.Now()
	if err != nil {
		return 0, err
	}
	if n < 48 {
		return 0, errors.New("short NTP reply")
	}
	if resp[0]>>6 == 3 || resp[1] == 0 {
		return 0, errors.New("NTP server not synchronised")
	}
	t2 := ntpTime(resp[32:40])
	t3 := ntpTime(resp[40:48])
	return (t2.Sub(t1.Round(0)) + t3.Sub(t4.Round(0))) / 2, nil
}

func ntpTime(b []byte) time.Time {
	secs := binary.BigEndian.Uint32(b[0:4])
	frac := binary.BigEndian.Uint32(b[4:8])
	nsec := (int64(frac) * 1e9) >> 32
	return time.Unix(int64(secs)-2208988800, nsec)
}
