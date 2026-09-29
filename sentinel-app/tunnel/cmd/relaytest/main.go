// relaytest measures the relay: two ends on this machine, round trips and throughput.
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"sentinel/p2p"
	"sentinelapp/tunnel"
)

func main() {
	ctx := context.Background()
	p2p.Debug = log.Printf
	s := p2p.NewRelaySession()
	a, err := p2p.DialRelay(ctx, tunnel.DefaultIntroducer, s, "client")
	if err != nil {
		log.Fatal(err)
	}
	b, err := p2p.DialRelay(ctx, tunnel.DefaultIntroducer, s, "host")
	if err != nil {
		log.Fatal(err)
	}
	buf := make([]byte, 2000)
	for i := 0; i < 5; i++ {
		t := time.Now()
		_, werr := a.WriteTo([]byte(fmt.Sprintf("ping %d", i)), nil)
		log.Printf("write err %v", werr)
		b.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, _, err := b.ReadFrom(buf)
		if err != nil {
			log.Fatalf("read: %v", err)
		}
		b.WriteTo(buf[:n], nil)
		a.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, _, err := a.ReadFrom(buf); err != nil {
			log.Fatalf("read back: %v", err)
		}
		log.Printf("round trip %d: %v", i, time.Since(t).Round(time.Millisecond))
	}
	// Throughput: 20 MB one way.
	pkt := make([]byte, 1200)
	go func() {
		for i := 0; i < 17000; i++ {
			a.WriteTo(pkt, nil)
			if i%200 == 0 {
				time.Sleep(time.Millisecond)
			}
		}
	}()
	t := time.Now()
	got := 0
	for {
		b.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, _, err := b.ReadFrom(buf)
		if err != nil {
			break
		}
		got += n
	}
	d := time.Since(t) - 3*time.Second
	log.Printf("received %d MB in %v = %.1f Mbit/s", got>>20, d.Round(time.Millisecond), float64(got)*8/d.Seconds()/1e6)
}
