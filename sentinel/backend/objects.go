package main

import (
	"os"
	"sync"
	"time"
)

// Person / cat / dog sensors for Home Assistant (MQTT): per camera, and "any camera".
// A sensor turns on as soon as the labeler confirms who's there (a few seconds into the
// motion) and off objectHold after that motion ends, so automations such as "a person at
// night: porch light on" react quickly and don't flicker.

const objectHold = 30 * time.Second

type objectSensors struct {
	mu   sync.Mutex
	on   map[string]string      // cam/label -> event keeping it on
	offs map[string]*time.Timer // cam/label -> pending "off"
}

func newObjectSensors() *objectSensors {
	return &objectSensors{on: map[string]string{}, offs: map[string]*time.Timer{}}
}

// ObjectSeen: the labeler confirmed label in an event (possibly still going on).
func (a *App) ObjectSeen(e Event, label string) {
	ob := a.objects
	key := e.Cam + "/" + label
	ob.mu.Lock()
	if t := ob.offs[key]; t != nil {
		t.Stop()
		delete(ob.offs, key)
	}
	ob.on[key] = e.ID
	ob.mu.Unlock()
	a.mqtt.Object(e.Cam, label, true)
	a.publishAnyObject(label)
	if img, err := readFileLimit(a.events.SnapPath(e.Cam, e.ID), 4<<20); err == nil {
		a.mqtt.ObjectSnapshot(e.Cam, img)
	}
	if cur, ok := a.events.Get(e.Cam, e.ID); ok && cur.End != 0 { // the motion ended before we knew
		a.objectsOff(e.Cam, e.ID, time.Until(time.UnixMilli(cur.End).Add(objectHold)))
	}
}

// objectsMotionEnd: the event is over; its sensors turn off after the hold time.
func (a *App) objectsMotionEnd(cam, eventID string) { a.objectsOff(cam, eventID, objectHold) }

func (a *App) objectsOff(cam, eventID string, after time.Duration) {
	ob := a.objects
	ob.mu.Lock()
	defer ob.mu.Unlock()
	for _, label := range watchLabels {
		key := cam + "/" + label
		if ob.on[key] != eventID {
			continue
		}
		if t := ob.offs[key]; t != nil {
			t.Stop()
		}
		label := label
		ob.offs[key] = time.AfterFunc(max(after, time.Second), func() {
			ob.mu.Lock()
			if ob.on[key] != eventID {
				ob.mu.Unlock()
				return
			}
			delete(ob.on, key)
			delete(ob.offs, key)
			ob.mu.Unlock()
			a.mqtt.Object(cam, label, false)
			a.publishAnyObject(label)
		})
	}
}

func (a *App) publishAnyObject(label string) {
	ob := a.objects
	ob.mu.Lock()
	on := false
	for key := range ob.on {
		if len(key) > len(label) && key[len(key)-len(label)-1:] == "/"+label {
			on = true
		}
	}
	ob.mu.Unlock()
	a.mqtt.AnyObject(label, on)
}

// publishObjects sends every sensor's current state (after connecting to MQTT).
func (a *App) publishObjects() {
	ob := a.objects
	ob.mu.Lock()
	on := map[string]bool{}
	for key := range ob.on {
		on[key] = true
	}
	ob.mu.Unlock()
	for _, c := range a.settings.Get().Cameras {
		for _, label := range watchLabels {
			a.mqtt.Object(c.ID, label, on[c.ID+"/"+label])
		}
	}
	for _, label := range watchLabels {
		a.publishAnyObject(label)
	}
}

func readFileLimit(p string, limit int64) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() > limit {
		return nil, os.ErrInvalid
	}
	b := make([]byte, st.Size())
	_, err = f.ReadAt(b, 0)
	return b, err
}
