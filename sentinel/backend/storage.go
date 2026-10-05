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
// label. Without one, recordings fall back to /media/sentinel with a much higher
// free-space floor, so they can't crowd Home Assistant off its disk.
type RecDisk struct {
	label    string
	mnt      string
	fallback string

	mu      sync.Mutex
	dev     string // e.g. sdb1, "" when not mounted
	mounted bool
	lastErr string
}

// fallbackMinFreeGB is the free space kept on Home Assistant's disk while recording there.
const fallbackMinFreeGB = 60

func newRecDisk(label, mnt, fallback string) *RecDisk {
	return &RecDisk{label: label, mnt: mnt, fallback: fallback}
}

// Base is where recordings/ and previews/ live: the mounted disk, or the fallback.
func (d *RecDisk) Base() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.mounted {
		return d.mnt
	}
	return d.fallback
}

func (d *RecDisk) Mounted() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.mounted
}

func (d *RecDisk) Status() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	return map[string]any{"label": d.label, "mounted": d.mounted, "device": d.dev, "error": d.lastErr}
}

// MinFreeGB is the free-space floor for the recordings disk.
func (d *RecDisk) MinFreeGB(configured float64) float64 {
	if d.Mounted() {
		return configured
	}
	return max(configured, fallbackMinFreeGB)
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
		return false
	}
	d.dev, d.mounted, d.lastErr = dev, true, ""
	return true
}

// Watch remounts the disk if its device disappears (a USB reader resetting comes back
// under a new name). Recorders open a new file per segment, so they continue on the
// new mount by themselves.
func (d *RecDisk) Watch(stop <-chan struct{}, onChange func(mounted bool, msg string)) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		d.mu.Lock()
		dev, mounted := d.dev, d.mounted
		d.mu.Unlock()
		if mounted {
			if _, err := os.Stat("/sys/class/block/" + dev); err == nil {
				continue
			}
			d.mu.Lock()
			d.mounted, d.dev = false, ""
			d.mu.Unlock()
			_ = syscall.Unmount(d.mnt, syscall.MNT_DETACH)
			if d.Mount() {
				onChange(true, "Recordings disk reconnected")
			} else {
				onChange(false, "Recordings disk disappeared")
			}
			continue
		}
		// Plugged in after start: recordings switch over on the next restart only, so
		// files don't end up split across two places mid-run.
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
