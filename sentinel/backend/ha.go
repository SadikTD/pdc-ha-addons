package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

var haClient = &http.Client{Timeout: 15 * time.Second}

func supervisorRequest(method, path string, body any) ([]byte, error) {
	token := os.Getenv("SUPERVISOR_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("not running under the Supervisor")
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, "http://supervisor"+path, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := haClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return data, fmt.Errorf("%s %s: HTTP %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return data, nil
}

// callService calls a Home Assistant service, e.g. "notify.mobile_app_phone".
func callService(service string, data map[string]any) error {
	domain, name, ok := strings.Cut(service, ".")
	if !ok {
		domain, name = "notify", service
	}
	_, err := supervisorRequest("POST", "/core/api/services/"+domain+"/"+name, data)
	return err
}

func notifyHA(notifyService, title, message, tag string, resolved bool) {
	go func() {
		if resolved {
			_ = callService("persistent_notification.dismiss", map[string]any{"notification_id": "sentinel_" + tag})
		} else {
			_ = callService("persistent_notification.create", map[string]any{"title": title, "message": message, "notification_id": "sentinel_" + tag})
		}
		if notifyService != "" {
			if err := callService(notifyService, map[string]any{"title": title, "message": message}); err != nil {
				logf("notify %s: %v", notifyService, err)
			}
		}
	}()
}

// ---- MQTT ----

type MQTT struct {
	mu        sync.Mutex
	client    mqtt.Client
	connected atomic.Bool
	cams      []Camera
	people    []Person
	seenAt    map[string]int64 // person -> newest sighting published
	published map[string]bool  // discovery ids we've announced
	onConnect func()
	lastErr   string
}

const availTopic = "sentinel/availability"

func newMQTT() *MQTT { return &MQTT{published: map[string]bool{}, seenAt: map[string]int64{}} }

func (m *MQTT) Connected() bool { return m.connected.Load() }

func (m *MQTT) Error() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastErr
}

func (m *MQTT) Run(ctx context.Context) {
	for ctx.Err() == nil {
		data, err := supervisorRequest("GET", "/services/mqtt", nil)
		if err != nil {
			m.mu.Lock()
			m.lastErr = "MQTT broker not available: " + err.Error()
			m.mu.Unlock()
			sleepCtx(ctx, time.Minute)
			continue
		}
		var svc struct {
			Data struct {
				Host     string `json:"host"`
				Port     int    `json:"port"`
				Username string `json:"username"`
				Password string `json:"password"`
				SSL      bool   `json:"ssl"`
			} `json:"data"`
		}
		if json.Unmarshal(data, &svc) != nil || svc.Data.Host == "" {
			m.mu.Lock()
			m.lastErr = "MQTT broker not configured"
			m.mu.Unlock()
			sleepCtx(ctx, time.Minute)
			continue
		}
		scheme := "tcp"
		if svc.Data.SSL {
			scheme = "ssl"
		}
		opts := mqtt.NewClientOptions().
			AddBroker(fmt.Sprintf("%s://%s:%d", scheme, svc.Data.Host, svc.Data.Port)).
			SetClientID("sentinel-nvr").
			SetUsername(svc.Data.Username).SetPassword(svc.Data.Password).
			SetAutoReconnect(true).SetConnectRetry(true).
			SetConnectRetryInterval(10*time.Second).SetMaxReconnectInterval(30*time.Second).
			SetKeepAlive(30*time.Second).
			SetWill(availTopic, "offline", 1, true)
		opts.SetOnConnectHandler(func(c mqtt.Client) {
			m.connected.Store(true)
			m.mu.Lock()
			m.lastErr = ""
			m.mu.Unlock()
			c.Publish(availTopic, 1, true, "online")
			m.announce()
			if m.onConnect != nil {
				go m.onConnect()
			}
		})
		opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
			m.connected.Store(false)
			m.mu.Lock()
			m.lastErr = "connection lost: " + err.Error()
			m.mu.Unlock()
		})
		c := mqtt.NewClient(opts)
		m.mu.Lock()
		m.client = c
		m.mu.Unlock()
		c.Connect()
		<-ctx.Done()
		if c.IsConnected() {
			c.Publish(availTopic, 1, true, "offline").WaitTimeout(2 * time.Second)
			c.Disconnect(500)
		}
		return
	}
}

func (m *MQTT) publish(topic string, retained bool, payload any) {
	m.mu.Lock()
	c := m.client
	m.mu.Unlock()
	if c == nil || !m.connected.Load() {
		return
	}
	c.Publish(topic, 0, retained, payload)
}

func device(id, name string) map[string]any {
	return map[string]any{"identifiers": []string{"sentinel_" + id}, "name": name, "manufacturer": "Sentinel", "model": "Sentinel NVR camera", "via_device": "sentinel_nvr"}
}

// SetPeople: the people Sentinel recognises (a "last seen" sensor each).
func (m *MQTT) SetPeople(people []Person) {
	m.mu.Lock()
	m.people = people
	m.mu.Unlock()
	m.announce()
}

// PersonSeen: someone was recognised (by "face" or "clothing") on a camera at t. Only
// newer sightings are published (older events are looked at in the background too).
func (m *MQTT) PersonSeen(person, camera, by string, t int64) {
	m.mu.Lock()
	newer := t > m.seenAt[person]
	if newer {
		m.seenAt[person] = t
	}
	m.mu.Unlock()
	if !newer {
		return
	}
	m.publish("sentinel/people/"+person+"/camera", true, camera)
	m.publish("sentinel/people/"+person+"/at", true, time.UnixMilli(t).Format(time.RFC3339))
	b, _ := json.Marshal(map[string]any{"camera": camera, "by": by, "time": time.UnixMilli(t).Format(time.RFC3339)})
	m.publish("sentinel/people/"+person+"/attributes", true, b)
}

func (m *MQTT) SetCameras(cams []Camera) {
	m.mu.Lock()
	m.cams = cams
	m.mu.Unlock()
	m.announce()
}

// announce publishes Home Assistant MQTT discovery for every camera and removes stale ones.
func (m *MQTT) announce() {
	if !m.connected.Load() {
		return
	}
	m.mu.Lock()
	cams, people := m.cams, m.people
	m.mu.Unlock()
	want := map[string]bool{}
	pub := func(component, objectID string, cfg map[string]any) {
		cfg["unique_id"] = "sentinel_" + objectID
		cfg["object_id"] = "sentinel_" + objectID
		cfg["availability_topic"] = availTopic
		b, _ := json.Marshal(cfg)
		key := component + "/sentinel_" + objectID
		want[key] = true
		m.publish("homeassistant/"+key+"/config", true, b)
	}
	hub := map[string]any{"identifiers": []string{"sentinel_nvr"}, "name": "Sentinel NVR", "manufacturer": "Sentinel", "model": "Sentinel NVR"}
	pub("sensor", "storage_free", map[string]any{"name": "Storage free", "state_topic": "sentinel/storage/free_gb", "unit_of_measurement": "GB", "device_class": "data_size", "icon": "mdi:harddisk", "device": hub})
	pub("sensor", "storage_used", map[string]any{"name": "Recordings size", "state_topic": "sentinel/storage/used_gb", "unit_of_measurement": "GB", "device_class": "data_size", "icon": "mdi:filmstrip-box-multiple", "device": hub})
	pub("binary_sensor", "clock_problem", map[string]any{"name": "Clock problem", "state_topic": "sentinel/clock/problem", "device_class": "problem", "device": hub})
	detecting := false
	for _, c := range cams {
		detecting = detecting || c.Enabled && c.Motion
	}
	if detecting {
		for _, label := range watchLabels {
			pub("binary_sensor", label, map[string]any{"name": objectNames[label] + " (any camera)", "state_topic": "sentinel/" + label, "device_class": "occupancy", "icon": objectIcons[label], "device": hub})
		}
	}
	// People recognised: where and when each was last seen (for automations like
	// "Abir came home").
	for _, p := range people {
		pub("sensor", "person_"+p.ID+"_camera", map[string]any{"name": p.Name + " last seen", "state_topic": "sentinel/people/" + p.ID + "/camera",
			"json_attributes_topic": "sentinel/people/" + p.ID + "/attributes", "icon": "mdi:account-eye", "device": hub})
		pub("sensor", "person_"+p.ID+"_at", map[string]any{"name": p.Name + " last seen at", "state_topic": "sentinel/people/" + p.ID + "/at",
			"device_class": "timestamp", "icon": "mdi:account-clock", "device": hub})
	}
	for _, c := range cams {
		if !c.Enabled {
			continue
		}
		dev := device(c.ID, c.Name)
		pub("binary_sensor", c.ID+"_motion", map[string]any{"name": "Motion", "state_topic": "sentinel/" + c.ID + "/motion", "device_class": "motion", "device": dev})
		pub("binary_sensor", c.ID+"_recording", map[string]any{"name": "Recording", "state_topic": "sentinel/" + c.ID + "/recording", "device_class": "running", "device": dev})
		pub("camera", c.ID, map[string]any{"name": "Last motion", "topic": "sentinel/" + c.ID + "/snapshot", "device": dev})
		if c.Motion { // people and animals are found in motion events
			for _, label := range watchLabels {
				pub("binary_sensor", c.ID+"_"+label, map[string]any{"name": objectNames[label], "state_topic": "sentinel/" + c.ID + "/" + label, "device_class": "occupancy", "icon": objectIcons[label], "device": dev})
			}
			pub("camera", c.ID+"_detection", map[string]any{"name": "Last person or animal", "topic": "sentinel/" + c.ID + "/detection", "device": dev})
		}
	}
	m.mu.Lock()
	var stale []string
	for key := range m.published {
		if !want[key] {
			stale = append(stale, key)
		}
	}
	m.published = want
	m.mu.Unlock()
	for _, key := range stale {
		m.publish("homeassistant/"+key+"/config", true, "")
	}
}

func onOff(b bool) string {
	if b {
		return "ON"
	}
	return "OFF"
}

func (m *MQTT) Motion(cam string, on bool) { m.publish("sentinel/"+cam+"/motion", true, onOff(on)) }
func (m *MQTT) Recording(cam string, on bool) {
	m.publish("sentinel/"+cam+"/recording", true, onOff(on))
}
func (m *MQTT) Snapshot(cam string, jpeg []byte) { m.publish("sentinel/"+cam+"/snapshot", true, jpeg) }
func (m *MQTT) Storage(freeGB, usedGB float64) {
	m.publish("sentinel/storage/free_gb", true, fmt.Sprintf("%.1f", freeGB))
	m.publish("sentinel/storage/used_gb", true, fmt.Sprintf("%.1f", usedGB))
}
func (m *MQTT) ClockProblem(p bool) { m.publish("sentinel/clock/problem", true, onOff(p)) }

var (
	objectNames = map[string]string{"person": "Person", "cat": "Cat", "dog": "Dog"}
	objectIcons = map[string]string{"person": "mdi:account", "cat": "mdi:cat", "dog": "mdi:dog"}
)

func (m *MQTT) Object(cam, label string, on bool) {
	m.publish("sentinel/"+cam+"/"+label, true, onOff(on))
}
func (m *MQTT) AnyObject(label string, on bool) { m.publish("sentinel/"+label, true, onOff(on)) }
func (m *MQTT) ObjectSnapshot(cam string, jpeg []byte) {
	m.publish("sentinel/"+cam+"/detection", true, jpeg)
}
