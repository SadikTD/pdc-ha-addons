package p2p

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
)

// DefaultPort is the UDP port Sentinel listens on for the app.
const DefaultPort = 8555

// STUNServers tell an endpoint which public address:port its UDP socket has. They see
// nothing but a 20-byte request; any one answering is enough.
var STUNServers = []string{"stun.cloudflare.com:3478", "stun.l.google.com:19302", "stun1.l.google.com:19302"}

// QUICConfig tuned for video: large flow-control windows so a single stream can use the
// whole link, and keep-alives that hold the routers' NAT mappings open.
func QUICConfig() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout:           6 * time.Second,
		MaxIdleTimeout:                 30 * time.Second,
		KeepAlivePeriod:                10 * time.Second,
		InitialStreamReceiveWindow:     2 << 20,
		MaxStreamReceiveWindow:         16 << 20,
		InitialConnectionReceiveWindow: 4 << 20,
		MaxConnectionReceiveWindow:     48 << 20,
		MaxIncomingStreams:             1000,
	}
}

// Our own small packets share the QUIC socket. QUIC never sends a first byte of 0
// and STUN is recognised by its magic cookie, so they can't be confused.
const (
	pktPunch    = 'P' // opens the sender's NAT towards the receiver; ignored on arrival
	pktQuery    = 'Q' // "is a Sentinel here?" (home-network discovery)
	pktAnswer   = 'A' // discovery answer, followed by JSON
	stunCookie  = 0x2112A442
	stunTimeout = 1500 * time.Millisecond
)

var pktMagic = []byte{0, 'S', 'N', 'T', 'L'}

func ourPacket(kind byte, payload []byte) []byte {
	return append(append(append([]byte{}, pktMagic...), kind), payload...)
}

// Endpoint is one UDP socket carrying QUIC plus STUN, punching and discovery packets.
type Endpoint struct {
	Transport *quic.Transport
	UDP       *net.UDPConn

	mu      sync.Mutex
	waiting map[[12]byte]chan netip.AddrPort
	answers chan Found

	// Server side: the JSON answer to a discovery query (nil: don't answer).
	OnQuery func() []byte
}

// Found is a Sentinel that answered on the local network.
type Found struct {
	Addr string
	JSON []byte
}

// Listen opens the socket on port (0: any free port).
func Listen(port int) (*Endpoint, error) {
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, err
	}
	e := &Endpoint{
		Transport: &quic.Transport{Conn: udp},
		UDP:       udp,
		waiting:   map[[12]byte]chan netip.AddrPort{},
		answers:   make(chan Found, 32),
	}
	go e.readLoop()
	return e, nil
}

func (e *Endpoint) Port() int { return e.UDP.LocalAddr().(*net.UDPAddr).Port }

func (e *Endpoint) Close() error {
	err := e.Transport.Close()
	e.UDP.Close()
	return err
}

func (e *Endpoint) readLoop() {
	buf := make([]byte, 2048)
	for {
		n, from, err := e.Transport.ReadNonQUICPacket(context.Background(), buf)
		if err != nil {
			return
		}
		e.handle(buf[:n], from)
	}
}

func (e *Endpoint) handle(b []byte, from net.Addr) {
	if len(b) >= 20 && binary.BigEndian.Uint32(b[4:8]) == stunCookie {
		if tx, addr, ok := parseSTUN(b); ok {
			e.mu.Lock()
			ch := e.waiting[tx]
			e.mu.Unlock()
			if ch != nil {
				select {
				case ch <- addr:
				default:
				}
			}
		}
		return
	}
	if len(b) < len(pktMagic)+1 || string(b[:len(pktMagic)]) != string(pktMagic) {
		return
	}
	switch b[len(pktMagic)] {
	case pktQuery:
		if e.OnQuery != nil {
			if ans := e.OnQuery(); ans != nil {
				e.Transport.WriteTo(ourPacket(pktAnswer, ans), from)
			}
		}
	case pktAnswer:
		select {
		case e.answers <- Found{Addr: from.String(), JSON: append([]byte{}, b[len(pktMagic)+1:]...)}:
		default:
		}
	}
}

// PublicAddr asks the STUN servers (all at once) for this socket's public address.
func (e *Endpoint) PublicAddr(ctx context.Context) (netip.AddrPort, error) {
	var tx [12]byte
	rand.Read(tx[:])
	ch := make(chan netip.AddrPort, 1)
	e.mu.Lock()
	e.waiting[tx] = ch
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.waiting, tx)
		e.mu.Unlock()
	}()
	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:], 0x0001) // binding request
	binary.BigEndian.PutUint32(req[4:], stunCookie)
	copy(req[8:], tx[:])
	ctx, cancel := context.WithTimeout(ctx, stunTimeout)
	defer cancel()
	go func() {
		for _, s := range STUNServers {
			if a, err := net.ResolveUDPAddr("udp4", s); err == nil {
				e.Transport.WriteTo(req, a)
			}
		}
	}()
	select {
	case a := <-ch:
		return a, nil
	case <-ctx.Done():
		return netip.AddrPort{}, errors.New("no answer from STUN servers")
	}
}

func parseSTUN(b []byte) (tx [12]byte, addr netip.AddrPort, ok bool) {
	if binary.BigEndian.Uint16(b[0:]) != 0x0101 {
		return
	}
	copy(tx[:], b[8:20])
	for i := 20; i+4 <= len(b); {
		t := binary.BigEndian.Uint16(b[i:])
		l := int(binary.BigEndian.Uint16(b[i+2:]))
		if i+4+l > len(b) {
			return
		}
		v := b[i+4 : i+4+l]
		if (t == 0x0020 || t == 0x0001) && l >= 8 && v[1] == 1 { // (XOR-)MAPPED-ADDRESS, IPv4
			port := binary.BigEndian.Uint16(v[2:])
			ip := [4]byte(v[4:8])
			if t == 0x0020 {
				port ^= stunCookie >> 16
				for j := range ip {
					ip[j] ^= byte(uint32(stunCookie) >> (24 - 8*j))
				}
			}
			return tx, netip.AddrPortFrom(netip.AddrFrom4(ip), port), true
		}
		i += 4 + l + (4-l%4)%4
	}
	return
}

// Punch sends small packets to every candidate for a while, so this side's NAT lets
// the other side's packets in. The QUIC handshake itself does the same from the dialer.
func (e *Endpoint) Punch(ctx context.Context, cands []string, d time.Duration) {
	var addrs []*net.UDPAddr
	for _, c := range cands {
		if a, err := net.ResolveUDPAddr("udp4", c); err == nil {
			addrs = append(addrs, a)
		}
	}
	if len(addrs) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	pkt := ourPacket(pktPunch, nil)
	t := time.NewTicker(150 * time.Millisecond)
	defer t.Stop()
	for {
		for _, a := range addrs {
			e.Transport.WriteTo(pkt, a)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Discover looks for Sentinels on the local /24 network (a probe to every address:
// Sentinel runs in a container that doesn't see broadcasts).
func (e *Endpoint) Discover(ctx context.Context, local netip.Addr, port int, wait time.Duration) []Found {
	if !local.Is4() {
		return nil
	}
	for len(e.answers) > 0 {
		<-e.answers
	}
	q := ourPacket(pktQuery, nil)
	base := local.As4()
	for i := 1; i < 255; i++ {
		ip := base
		ip[3] = byte(i)
		e.Transport.WriteTo(q, &net.UDPAddr{IP: net.IP(ip[:]), Port: port})
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	var out []Found
	seen := map[string]bool{}
	for {
		select {
		case f := <-e.answers:
			if !seen[f.Addr] {
				seen[f.Addr] = true
				out = append(out, f)
			}
		case <-ctx.Done():
			return out
		}
	}
}

// OutboundIP is the local address used to reach the internet. (Listing interfaces
// isn't allowed for apps on recent Android versions; this works everywhere.)
func OutboundIP() netip.Addr {
	c, err := net.Dial("udp4", "1.1.1.1:53") // sends nothing
	if err != nil {
		return netip.Addr{}
	}
	defer c.Close()
	ap, _ := netip.ParseAddrPort(c.LocalAddr().String())
	return ap.Addr()
}
