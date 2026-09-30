package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// An urgent waiter (a night alert) goes before background work already waiting.
func TestPrioLock(t *testing.T) {
	var p prioLock
	p.Lock()
	var mu sync.Mutex
	var order []string
	var wg sync.WaitGroup
	run := func(name string, ctx context.Context) {
		defer wg.Done()
		p.LockFor(ctx)
		mu.Lock()
		order = append(order, name)
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
		p.Unlock()
	}
	bg := lowPriority(context.Background())
	for _, n := range []string{"bg1", "bg2", "bg3"} {
		wg.Add(1)
		go run(n, bg)
		time.Sleep(10 * time.Millisecond)
	}
	wg.Add(1)
	go run("alert", context.Background())
	time.Sleep(10 * time.Millisecond)
	p.Unlock()
	wg.Wait()
	if len(order) != 4 || order[0] != "alert" {
		t.Fatalf("order %v: the alert should go first", order)
	}
}
