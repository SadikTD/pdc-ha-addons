// Package p2p connects the Sentinel app to a Sentinel server from anywhere: directly
// on the home network, or across the internet through the routers' NAT (UDP hole
// punching), with a tiny introducer that only swaps addresses. Everything runs over
// QUIC with TLS 1.3, and the server's certificate is pinned by its ID.
package p2p

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Crockford's base32: no I, L, O or U, so IDs are easy to read out and type.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// IDLength characters of 5 bits: 60 bits of the key's hash. Finding another key with
// the same ID would take about 2^60 key generations.
const IDLength = 12

type Identity struct {
	Priv ed25519.PrivateKey
	Pub  ed25519.PublicKey
	ID   string
}

// IDFromKey derives a server ID from its public key, so an ID can't be claimed by anyone
// without the key.
func IDFromKey(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	var b strings.Builder
	var acc uint64
	bits, i := 0, 0
	for b.Len() < IDLength {
		if bits < 5 {
			acc = acc<<8 | uint64(sum[i])
			i++
			bits += 8
		}
		bits -= 5
		b.WriteByte(alphabet[(acc>>bits)&31])
	}
	return b.String()
}

// NormalizeID accepts IDs as people type them: any case, with dashes or spaces, and
// the letters O, I and L mistaken for digits.
func NormalizeID(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch r {
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		}
		if strings.ContainsRune(alphabet, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// FormatID shows an ID in groups of four: "7KQ2-M9XD-4T1B".
func FormatID(id string) string {
	id = NormalizeID(id)
	var parts []string
	for len(id) > 4 {
		parts = append(parts, id[:4])
		id = id[4:]
	}
	return strings.Join(append(parts, id), "-")
}

// LoadOrCreateIdentity reads the server key, creating it on first start.
func LoadOrCreateIdentity(path string) (*Identity, error) {
	seed, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		seed = make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, seed, 0o600); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, path); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s is damaged", path)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return &Identity{Priv: priv, Pub: pub, ID: IDFromKey(pub)}, nil
}

// Certificate is a self-signed certificate for the identity key. Clients don't trust it
// through any authority: they check that its key matches the ID they asked for.
func (id *Identity) Certificate() (tls.Certificate, error) {
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "Sentinel " + FormatID(id.ID)},
		DNSNames:     []string{"sentinel"},
		NotBefore:    time.Now().Add(-24 * time.Hour),
		NotAfter:     time.Now().Add(20 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, id.Pub, id.Priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: id.Priv}, nil
}

// ErrWrongServer: something answered that isn't the Sentinel with this ID.
var ErrWrongServer = errors.New("the server's identity doesn't match this Sentinel ID")

// ClientTLS pins the server to its ID. TLS 1.3 makes the server prove it holds the
// certificate's key, so a matching key means it's really that Sentinel.
func ClientTLS(id string) *tls.Config {
	want := NormalizeID(id)
	return &tls.Config{
		ServerName:         "sentinel",
		NextProtos:         []string{"h3"},
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true, // replaced by the key check below
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return ErrWrongServer
			}
			cert, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return ErrWrongServer
			}
			pub, ok := cert.PublicKey.(ed25519.PublicKey)
			if !ok || IDFromKey(pub) != want {
				return ErrWrongServer
			}
			return nil
		},
	}
}

// ServerTLS is the server side of ClientTLS.
func (id *Identity) ServerTLS() (*tls.Config, error) {
	cert, err := id.Certificate()
	if err != nil {
		return nil, err
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"h3"}, MinVersion: tls.VersionTLS13}, nil
}
