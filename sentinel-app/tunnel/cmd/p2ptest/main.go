// p2ptest checks the connection engine end to end: "serve" runs a stand-in server
// (identity key, introducer, HTTP/3), "dial" connects through the tunnel and measures.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"

	"sentinel/p2p"
	"sentinelapp/tunnel"
)

func main() {
	mode := os.Args[1]
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	key := fs.String("key", "p2ptest.key", "server key file")
	port := fs.Int("port", 18555, "server UDP port")
	id := fs.String("id", "", "server ID to dial")
	path := fs.String("path", "/big", "paths to fetch, comma separated")
	user := fs.String("user", "", "app username (dial)")
	pass := fs.String("pass", "", "app password (dial)")
	relayOnly := fs.Bool("relayonly", false, "dial through the relay only")
	dur := fs.Duration("dur", 8*time.Second, "longest time to read one response")
	fs.Parse(os.Args[2:])
	switch mode {
	case "serve":
		ident, err := p2p.LoadOrCreateIdentity(*key)
		if err != nil {
			log.Fatal(err)
		}
		ep, err := p2p.Listen(*port)
		if err != nil {
			log.Fatal(err)
		}
		ep.OnQuery = func() []byte { return []byte(`{"id":"` + ident.ID + `","name":"test"}`) }
		tc, _ := ident.ServerTLS()
		ln, err := ep.Transport.Listen(tc, p2p.QUICConfig())
		if err != nil {
			log.Fatal(err)
		}
		mux := http.NewServeMux()
		mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, "hello %s from %s\n", r.RemoteAddr, ident.ID)
		})
		mux.HandleFunc("/big", func(w http.ResponseWriter, r *http.Request) {
			buf := make([]byte, 64<<10)
			for i := 0; i < 800; i++ { // 50 MB
				if _, err := w.Write(buf); err != nil {
					return
				}
			}
		})
		srv := &http3.Server{Handler: mux}
		serveRelay := func(c *quic.Conn) { log.Printf("relayed connection"); srv.ServeQUICConn(c) }
		go func() {
			for {
				c, err := ln.Accept(context.Background())
				if err != nil {
					return
				}
				log.Printf("connection from %s", c.RemoteAddr())
				go srv.ServeQUICConn(c)
			}
		}()
		host := p2p.NewHost(p2p.HostConfig{Identity: ident, Endpoint: ep, Introducer: tunnel.DefaultIntroducer, Name: "test", Version: "test", Logf: log.Printf, ServerTLS: tc, ServeRelay: serveRelay,
			LANAddrs: func() []string { return []string{fmt.Sprintf("%s:%d", p2p.OutboundIP(), *port)} }})
		log.Printf("serving %s on %d", p2p.FormatID(ident.ID), *port)
		host.Run(context.Background())
	case "dial":
		p2p.Debug = log.Printf
		dir, _ := os.MkdirTemp("", "tun")
		t := tunnel.New(dir)
		t.SetServer(*id, "")
		t.SetRelayOnly(*relayOnly)
		base, _ := t.Start()
		start := time.Now()
		if err := t.Connect(); err != nil {
			log.Fatalf("connect: %v (%s)", err, t.StateJSON())
		}
		log.Printf("connected in %v: %s", time.Since(start).Round(time.Millisecond), t.StateJSON())
		if *user != "" {
			resp, err := http.Post(base+"/app/login", "application/json", strings.NewReader(`{"username":"`+*user+`","password":"`+*pass+`","device":"p2ptest"}`))
			if err != nil {
				log.Fatal(err)
			}
			var lr struct{ Token, Error string }
			json.NewDecoder(resp.Body).Decode(&lr)
			if lr.Token == "" {
				log.Fatalf("login: %s", lr.Error)
			}
			t.SetToken(lr.Token)
			log.Printf("logged in")
		}
		for _, p := range strings.Split(*path, ",") {
			start = time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), *dur)
			req, _ := http.NewRequestWithContext(ctx, "GET", base+p, nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				log.Fatal(err)
			}
			ttfb := time.Since(start)
			n, _ := io.Copy(io.Discard, resp.Body)
			cancel()
			d := time.Since(start)
			log.Printf("GET %s: %d, first byte %v, %d bytes in %v = %.1f Mbit/s", p, resp.StatusCode, ttfb.Round(time.Millisecond), n, d.Round(time.Millisecond), float64(n)*8/d.Seconds()/1e6)
		}
	case "discover":
		fmt.Println(tunnel.Discover("", 1500))
	}
}
