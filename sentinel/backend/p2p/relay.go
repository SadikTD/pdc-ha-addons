package p2p

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// The relay is the fallback when no direct path exists (e.g. a mobile network that
// changes ports for every destination, against a home router that only lets in the
// exact address it sent to). Both sides open a WebSocket to the same relay session and
// run the very same QUIC connection over it, so it stays end-to-end encrypted and
// pinned to the server's key; the relay only ever sees ciphertext.

// RelayAddr is the peer address of a relayed connection.
type RelayAddr struct{ Session string }

func (RelayAddr) Network() string  { return "relay" }
func (a RelayAddr) String() string { return "relay" }

func NewRelaySession() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// RelayConn is a net.PacketConn over the relay WebSocket. Packets written close together
// are sent in one WebSocket message (each with a 2-byte length), which keeps the relay's
// message count low without adding noticeable delay.
type RelayConn struct {
	ws      *websocket.Conn
	session string
	in      chan []byte
	done    chan struct{}
	once    sync.Once

	wmu     sync.Mutex
	batch   []byte
	flushAt *time.Timer
	werr    error

	dmu      sync.Mutex
	deadline time.Time
}

const (
	relayMaxBatch = 32 << 10
	relayDelay    = time.Millisecond
)

func DialRelay(ctx context.Context, introducer, session, role string) (*RelayConn, error) {
	u := strings.TrimRight(introducer, "/")
	u = "ws" + strings.TrimPrefix(u, "http") + "/v1/relay/" + session + "?role=" + role
	d := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 64 << 10, WriteBufferSize: 64 << 10}
	ws, resp, err := d.DialContext(ctx, u, http.Header{"User-Agent": {"Sentinel"}})
	if err != nil {
		if resp != nil {
			return nil, errors.New("relay: " + resp.Status)
		}
		return nil, errors.New("can't reach the relay")
	}
	c := &RelayConn{ws: ws, session: session, in: make(chan []byte, 4096), done: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

func (c *RelayConn) readLoop() {
	defer c.Close()
	for {
		_, msg, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		for len(msg) >= 2 {
			n := int(binary.BigEndian.Uint16(msg))
			if len(msg) < 2+n {
				break
			}
			p := msg[2 : 2+n]
			msg = msg[2+n:]
			select {
			case c.in <- p:
			default: // full: drop, QUIC resends
			}
		}
	}
}

func (c *RelayConn) ReadFrom(b []byte) (int, net.Addr, error) {
	c.dmu.Lock()
	dl := c.deadline
	c.dmu.Unlock()
	var timeout <-chan time.Time
	if !dl.IsZero() {
		d := time.Until(dl)
		if d <= 0 {
			return 0, nil, os.ErrDeadlineExceeded
		}
		t := time.NewTimer(d)
		defer t.Stop()
		timeout = t.C
	}
	select {
	case p := <-c.in:
		return copy(b, p), RelayAddr{c.session}, nil
	case <-c.done:
		return 0, nil, net.ErrClosed
	case <-timeout:
		return 0, nil, os.ErrDeadlineExceeded
	}
}

func (c *RelayConn) WriteTo(b []byte, _ net.Addr) (int, error) {
	if len(b) > 0xffff {
		return 0, errors.New("packet too large")
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.werr != nil {
		return 0, c.werr
	}
	var l [2]byte
	binary.BigEndian.PutUint16(l[:], uint16(len(b)))
	c.batch = append(append(c.batch, l[:]...), b...)
	if len(c.batch) >= relayMaxBatch {
		c.flushLocked()
	} else if c.flushAt == nil {
		c.flushAt = time.AfterFunc(relayDelay, func() {
			c.wmu.Lock()
			defer c.wmu.Unlock()
			c.flushLocked()
		})
	}
	return len(b), nil
}

func (c *RelayConn) flushLocked() {
	if c.flushAt != nil {
		c.flushAt.Stop()
		c.flushAt = nil
	}
	if len(c.batch) == 0 || c.werr != nil {
		return
	}
	c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.ws.WriteMessage(websocket.BinaryMessage, c.batch); err != nil {
		c.werr = err
		go c.Close()
	}
	c.batch = c.batch[:0]
}

func (c *RelayConn) Close() error {
	c.once.Do(func() {
		close(c.done)
		c.ws.Close()
	})
	return nil
}

func (c *RelayConn) LocalAddr() net.Addr { return RelayAddr{c.session} }

func (c *RelayConn) SetDeadline(t time.Time) error { return c.SetReadDeadline(t) }

func (c *RelayConn) SetReadDeadline(t time.Time) error {
	c.dmu.Lock()
	c.deadline = t
	c.dmu.Unlock()
	return nil
}

func (c *RelayConn) SetWriteDeadline(time.Time) error { return nil }
