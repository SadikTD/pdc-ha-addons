package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// RecDisk puts recordings and timeline previews on their own disk: an ext4 partition
// labelled SENTINEL (e.g. a memory card in a USB reader), mounted inside this container
// only. Home Assistant's own disk then never waits behind 24/7 video writes.
//
// Sentinel never formats anything: a partition is used only if it already carries the
// label. Without one (missing at start, or dropped out), nothing is recorded: the mount
// point is blocked so video never lands on Home Assistant's SSD, and the user is alerted
// until the disk is back, which is picked up by itself.
type RecDisk struct {
	label string
	mnt   string

	mu      sync.Mutex
	dev     string // e.g. sdb1, "" when not mounted
	mounted bool
	// The disk is missing (at start, or dropped out and couldn't be mounted again). A
	// read-only placeholder then covers the mount point, so nothing is written onto Home
	// Assistant's own disk in its place: recording stops (and says so) until it's back.
	lost    bool
	lastErr string
}

// Lost: the recordings disk is missing and recording is stopped until it's back.
func (d *RecDisk) Lost() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lost
}

func newRecDisk(label, mnt string) *RecDisk {
	return &RecDisk{label: label, mnt: mnt}
}

// Base is where recordings/ and previews/ live: the recordings disk's mount point
// (blocked while the disk is missing, see block).
func (d *RecDisk) Base() string { return d.mnt }

func (d *RecDisk) Mounted() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.mounted
}

func (d *RecDisk) Status() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	return map[string]any{"label": d.label, "mounted": d.mounted, "lost": d.lost, "device": d.dev, "error": d.lastErr}
}

// Mount finds the labelled partition and mounts it. Safe to call again.
func (d *RecDisk) Mount() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mounted {
		return true
	}
	dev := findExt4Label(d.label)
	if dev == "" {
		d.lastErr = "no ext4 partition labelled " + d.label
		return false
	}
	node, err := devNode(dev)
	if err != nil {
		d.lastErr = err.Error()
		return false
	}
	if err := os.MkdirAll(d.mnt, 0o755); err != nil {
		d.lastErr = err.Error()
		return false
	}
	// A stale mount (reader unplugged) is detached first.
	_ = syscall.Unmount(d.mnt, syscall.MNT_DETACH)
	if err := syscall.Mount(node, d.mnt, "ext4", syscall.MS_NOATIME, ""); err != nil {
		d.lastErr = "mount " + dev + ": " + err.Error()
		if d.lost {
			d.blockLocked() // still gone: keep recordings off the disk underneath
		}
		return false
	}
	d.dev, d.mounted, d.lost, d.lastErr = dev, true, false, ""
	return true
}

// Watch remounts the disk if its device disappears (a USB reader resetting comes back
// under a new name). Recorders open a new file per segment, so they continue on the
// new mount by themselves. If it can't be mounted again, recording stops (see lost),
// onChange(false) repeats every lostRemind, and the disk is looked for every 30 s.
func (d *RecDisk) Watch(stop <-chan struct{}, onChange func(mounted bool, msg string)) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	var reminded time.Time
	if d.Lost() {
		reminded = time.Now() // missing at start: that alert was just sent
	}
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		d.mu.Lock()
		dev, mounted, lost := d.dev, d.mounted, d.lost
		d.mu.Unlock()
		switch {
		case mounted:
			if _, err := os.Stat("/sys/class/block/" + dev); err == nil {
				continue
			}
			d.mu.Lock()
			d.mounted, d.dev = false, ""
			d.mu.Unlock()
			_ = syscall.Unmount(d.mnt, syscall.MNT_DETACH)
			if d.Mount() {
				onChange(true, "Recordings disk reconnected")
				continue
			}
			d.block()
			reminded = time.Now()
			onChange(false, "Recordings disk disappeared")
		case lost:
			if d.Mount() {
				onChange(true, "Recordings disk is back: recording again")
			} else if time.Since(reminded) >= lostRemind {
				reminded = time.Now()
				onChange(false, "Recordings disk is still missing")
			}
		}
	}
}

// lostRemind: how often the alert repeats while the recordings disk is missing.
const lostRemind = 12 * time.Hour

// block covers the mount point with an empty read-only filesystem, so recordings can't
// land on the disk underneath (Home Assistant's) while the recordings disk is gone.
func (d *RecDisk) block() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lost = true
	d.blockLocked()
}

func (d *RecDisk) blockLocked() {
	if err := syscall.Mount("sentinel-no-disk", d.mnt, "tmpfs", syscall.MS_RDONLY, "size=64k"); err != nil {
		logf("recordings disk: can't block %s: %v", d.mnt, err)
	}
}

// findExt4Label returns the block device (e.g. "sdb1") holding an ext4 filesystem with
// the given label, by reading superblocks directly.
func findExt4Label(label string) string {
	ents, err := os.ReadDir("/sys/class/block")
	if err != nil {
		return ""
	}
	for _, e := range ents {
		name := e.Name()
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "ram") {
			continue
		}
		node, err := devNode(name)
		if err != nil {
			continue
		}
		if ext4Label(node) == label {
			return name
		}
	}
	return ""
}

// ext4Label reads the volume name from an ext2/3/4 superblock ("" if none).
func ext4Label(node string) string {
	f, err := os.Open(node)
	if err != nil {
		return ""
	}
	defer f.Close()
	sb := make([]byte, 0x88)
	if _, err := f.ReadAt(sb, 1024); err != nil {
		return ""
	}
	if binary.LittleEndian.Uint16(sb[0x38:]) != 0xEF53 {
		return ""
	}
	return string(bytes.TrimRight(sb[0x78:0x88], "\x00"))
}

// devNode returns a usable device node for a block device: /dev/<name>, or one created
// from its major:minor when the container's /dev predates the device (hot-plugged).
func devNode(name string) (string, error) {
	p := "/dev/" + name
	if _, err := os.Stat(p); err == nil {
		return p, nil
	}
	raw, err := os.ReadFile(filepath.Join("/sys/class/block", name, "dev"))
	if err != nil {
		return "", err
	}
	mm := strings.SplitN(strings.TrimSpace(string(raw)), ":", 2)
	if len(mm) != 2 {
		return "", os.ErrNotExist
	}
	maj, _ := strconv.Atoi(mm[0])
	min, _ := strconv.Atoi(mm[1])
	p = filepath.Join(os.TempDir(), "dev-"+name)
	_ = os.Remove(p)
	if err := syscall.Mknod(p, syscall.S_IFBLK|0o600, maj<<8|min&0xff|(min&^0xff)<<12); err != nil {
		return "", err
	}
	return p, nil
}
