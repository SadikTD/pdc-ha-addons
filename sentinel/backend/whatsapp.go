package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// WhatsApp messages go through the PDC WhatsApp Bridge add-on (same add-on repository),
// which holds the linked WhatsApp session. Sentinel only needs its address and API token.

type WhatsAppClient struct {
	app    *App
	client *http.Client
	mu     sync.Mutex
	found  string
	at     time.Time
}

func newWhatsAppClient(app *App) *WhatsAppClient {
	return &WhatsAppClient{app: app, client: &http.Client{Timeout: 90 * time.Second}}
}

var errBridgeMissing = errors.New("the PDC WhatsApp Bridge add-on wasn't found; set its address in Settings")

// selfSlug is this add-on's slug, e.g. "3ad1f875_sentinel".
var selfSlug = sync.OnceValue(func() string {
	data, err := supervisorRequest("GET", "/addons/self/info", nil)
	if err != nil {
		return ""
	}
	var r struct {
		Data struct {
			Slug string `json:"slug"`
		} `json:"data"`
	}
	_ = json.Unmarshal(data, &r)
	return r.Data.Slug
})

func (w *WhatsAppClient) base() (string, error) {
	if u := w.app.settings.Get().WhatsApp.BridgeURL; u != "" {
		return u, nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.found != "" && time.Since(w.at) < 10*time.Minute {
		return w.found, nil
	}
	// The bridge isn't published on the host; ask the Supervisor for its internal address.
	slug := strings.TrimSuffix(selfSlug(), "sentinel") + "pdc_whatsapp"
	data, err := supervisorRequest("GET", "/addons/"+slug+"/info", nil)
	if err != nil {
		return "", errBridgeMissing
	}
	var r struct {
		Data struct {
			IP    string `json:"ip_address"`
			State string `json:"state"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &r) != nil || r.Data.IP == "" {
		return "", errBridgeMissing
	}
	w.found, w.at = "http://"+r.Data.IP+":8787", time.Now()
	return w.found, nil
}

// bridgeError says whether retrying later can help (bridge offline, WhatsApp reconnecting).
type bridgeError struct {
	msg       string
	retryable bool
}

func (e *bridgeError) Error() string { return e.msg }

func (w *WhatsAppClient) do(method, path string, body any) ([]byte, error) {
	token := w.app.secrets.Get().WhatsAppToken
	if token == "" {
		return nil, &bridgeError{msg: "paste the bridge's API token in Settings first"}
	}
	base, err := w.base()
	if err != nil {
		return nil, &bridgeError{msg: err.Error(), retryable: true}
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, base+path, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.client.Do(req)
	if err != nil {
		w.mu.Lock()
		w.found = "" // the bridge may have a new address after a restart
		w.mu.Unlock()
		return nil, &bridgeError{msg: "can't reach the WhatsApp bridge: " + err.Error(), retryable: true}
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var r struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	_ = json.Unmarshal(data, &r)
	switch {
	case resp.StatusCode < 300:
		return data, nil
	case resp.StatusCode == 401:
		return nil, &bridgeError{msg: "the WhatsApp bridge rejected the API token"}
	case resp.StatusCode == 403:
		return nil, &bridgeError{msg: "the bridge's WhatsApp number isn't in that chat (add it to the group)"}
	case resp.StatusCode == 404:
		return nil, &bridgeError{msg: "update the PDC WhatsApp Bridge add-on (2.1.0 or newer is needed for pictures)"}
	case resp.StatusCode == 409 && r.Status == "in_progress":
		return nil, &bridgeError{msg: "the bridge is still sending this message", retryable: true}
	case resp.StatusCode == 409 && r.Status == "unknown":
		return nil, &bridgeError{msg: "WhatsApp lost track of this message (it may or may not have arrived)"}
	case resp.StatusCode == 503:
		return nil, &bridgeError{msg: "WhatsApp is disconnected on the bridge", retryable: true}
	default:
		msg := fmt.Sprintf("WhatsApp bridge: HTTP %d %s %s", resp.StatusCode, r.Status, r.Error)
		return nil, &bridgeError{msg: strings.TrimSpace(msg), retryable: resp.StatusCode >= 500}
	}
}

type WAChats struct {
	Recipient string `json:"recipient"`
	Groups    []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Size int    `json:"size"`
	} `json:"groups"`
}

func (w *WhatsAppClient) Chats() (*WAChats, error) {
	data, err := w.do("GET", "/chats", nil)
	if err != nil {
		return nil, err
	}
	var c WAChats
	return &c, json.Unmarshal(data, &c)
}

// SendImage sends a JPEG with a caption. The key makes retries safe: the bridge never
// sends the same key twice.
func (w *WhatsAppClient) SendImage(to string, jpeg []byte, caption, key string) error {
	_, err := w.do("POST", "/send-image", map[string]any{
		"to": to, "image": base64.StdEncoding.EncodeToString(jpeg), "caption": caption, "idempotencyKey": key,
	})
	return err
}

// Send sends a text message to the bridge's recipient (the bridge allows text only there).
func (w *WhatsAppClient) Send(to, text, key string) error {
	_, err := w.do("POST", "/send", map[string]any{"to": to, "text": text, "idempotencyKey": key})
	return err
}
