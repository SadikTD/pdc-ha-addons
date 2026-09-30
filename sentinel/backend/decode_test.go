package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestFrameCache(t *testing.T) {
	c := &frameCache{frames: map[string]*rawFrame{}}
	ctx := context.Background()

	// Many asking for the same moment at once: decoded once.
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := c.get(ctx, "a", func() ([]byte, error) { calls.Add(1); return make([]byte, 10), nil })
			if err != nil || len(b) != 10 {
				t.Errorf("got %d bytes, %v", len(b), err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("decoded %d times, want 1", calls.Load())
	}

	// A failure isn't kept: the next ask tries again.
	if _, err := c.get(ctx, "b", func() ([]byte, error) { return nil, errors.New("no") }); err == nil {
		t.Fatal("want the error")
	}
	if b, err := c.get(ctx, "b", func() ([]byte, error) { return []byte{1}, nil }); err != nil || len(b) != 1 {
		t.Fatalf("retry: %v", err)
	}

	// Over the size limit, the oldest frames go.
	big := func() ([]byte, error) { return make([]byte, frameCacheBytes/2), nil }
	c.get(ctx, "c", big)
	c.get(ctx, "d", big)
	c.get(ctx, "e", big)
	if _, ok := c.frames["a"]; ok {
		t.Error("oldest frame kept")
	}
	if c.bytes > frameCacheBytes {
		t.Errorf("cache holds %d bytes", c.bytes)
	}
	if _, ok := c.frames["e"]; !ok {
		t.Error("newest frame dropped")
	}
}
