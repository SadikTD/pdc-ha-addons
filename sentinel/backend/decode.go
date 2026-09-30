package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

// Decoding a frame of the recording is the expensive part of looking at it: the camera
// only sends a whole picture every 2-5 s, so the frame at t means decoding every frame
// from the fragment's keyframe up to t, in full resolution (0.5-1.5 s of CPU each).
// Object detection, zooming, the big model's closer look, the event picture and faces
// all look at the same few moments, each in its own size or crop. So each moment is
// decoded once, kept for a little while as the decoder's own picture (uncompressed, in
// Matroska, which keeps the colour range: full-range cameras would otherwise come out
// with different pixels), and every size or crop is made from that. The result is the
// same, byte for byte, as decoding it again.

const (
	frameCacheBytes = 48 << 20        // about 10-15 decoded frames
	frameCacheTTL   = 2 * time.Minute // long enough for an event's checks and its faces
)

type rawFrame struct {
	done  chan struct{}
	data  []byte
	err   error
	added time.Time
}

type frameCache struct {
	mu     sync.Mutex
	frames map[string]*rawFrame
	order  []string // oldest first
	bytes  int
}

var decoded = &frameCache{frames: map[string]*rawFrame{}}

// get returns the decoded frame for key, running decode once however many ask at once.
func (c *frameCache) get(ctx context.Context, key string, decode func() ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	c.expireLocked()
	if f, ok := c.frames[key]; ok {
		c.mu.Unlock()
		select {
		case <-f.done:
			return f.data, f.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f := &rawFrame{done: make(chan struct{})}
	c.frames[key] = f
	c.mu.Unlock()

	f.data, f.err = decode()
	f.added = time.Now()
	close(f.done)

	c.mu.Lock()
	if f.err != nil {
		delete(c.frames, key) // try again next time
	} else {
		c.order = append(c.order, key)
		c.bytes += len(f.data)
		for c.bytes > frameCacheBytes && len(c.order) > 1 {
			c.dropOldestLocked()
		}
	}
	c.mu.Unlock()
	return f.data, f.err
}

func (c *frameCache) expireLocked() {
	for len(c.order) > 0 {
		if f := c.frames[c.order[0]]; f != nil && time.Since(f.added) < frameCacheTTL {
			return
		}
		c.dropOldestLocked()
	}
}

func (c *frameCache) dropOldestLocked() {
	k := c.order[0]
	c.order = c.order[1:]
	if f := c.frames[k]; f != nil {
		c.bytes -= len(f.data)
		delete(c.frames, k)
	}
}

// ffmpegCmd runs ffmpeg on one core; background work (lowPriority) at the lowest CPU
// priority, so Home Assistant, recording and viewers always go first.
func ffmpegCmd(ctx context.Context, args []string) *exec.Cmd {
	args = append([]string{"-threads", "1"}, args...)
	if ctx.Value(lowPriorityKey) != nil {
		return exec.CommandContext(ctx, "nice", append([]string{"-n", "19", "ffmpeg"}, args...)...)
	}
	return exec.CommandContext(ctx, "ffmpeg", args...)
}

// decodeSem waits for a free decode slot (separate ones for background work).
func decodeSem(ctx context.Context) (func(), error) {
	sem := extractSem
	if ctx.Value(lowPriorityKey) != nil {
		sem = backgroundSem
	}
	select {
	case sem <- struct{}{}:
		return func() { <-sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// runDecode decodes the frame at t (exact) or the start of its fragment (the keyframe),
// and writes it out as asked (out: ffmpeg output options).
func (a *App) runDecode(ctx context.Context, cam string, t time.Time, exact bool, out []string) ([]byte, error) {
	ref, err := a.fragmentRefAt(cam, t, exact)
	if err != nil {
		return nil, err
	}
	ss := ""
	if exact && ref.into > 0 {
		ss = fmt.Sprintf("%.3f", ref.into)
	}
	key := fmt.Sprintf("%s/%d/%d/%s", ref.path, ref.frag.Offset, ref.frag.Length, ss)
	raw, err := decoded.get(ctx, key, func() ([]byte, error) {
		data, err := ref.read()
		if err != nil {
			return nil, err
		}
		return decodeRaw(ctx, data, ss)
	})
	if err != nil {
		return nil, err
	}
	return filterRaw(ctx, raw, out)
}

// decodeRaw decodes one frame of a fragment (ss seconds in, or its first) as the
// decoder's own picture.
func decodeRaw(ctx context.Context, fragment []byte, ss string) ([]byte, error) {
	release, err := decodeSem(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	args := []string{"-v", "error", "-i", "pipe:0"}
	if ss != "" {
		args = append(args, "-ss", ss)
	}
	args = append(args, "-frames:v", "1", "-c:v", "rawvideo", "-f", "matroska", "pipe:1")
	cmd := ffmpegCmd(ctx, args)
	cmd.Stdin = bytes.NewReader(fragment)
	b, err := cmd.Output()
	if err != nil || len(b) < 1000 {
		return nil, fmt.Errorf("could not decode a frame: %v", err)
	}
	return b, nil
}

// filterRaw makes the picture asked for (out: ffmpeg output options) from a decoded frame.
func filterRaw(ctx context.Context, raw []byte, out []string) ([]byte, error) {
	release, err := decodeSem(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := ffmpegCmd(ctx, append([]string{"-v", "error", "-f", "matroska", "-i", "pipe:0", "-frames:v", "1"}, out...))
	cmd.Stdin = bytes.NewReader(raw)
	b, err := cmd.Output()
	if err != nil || len(b) < 100 {
		return nil, fmt.Errorf("could not decode a frame: %v", err)
	}
	return b, nil
}
