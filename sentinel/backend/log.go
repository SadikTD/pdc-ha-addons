package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
	"time"
)

func logf(format string, args ...any) {
	log.Print(redact(fmt.Sprintf(format, args...)))
}

// Incident is a notable event shown on the System page (reconnects, stalls, cleanups).
type Incident struct {
	Time    int64  `json:"t"`     // unix ms
	Level   string `json:"level"` // info | warn | error
	Camera  string `json:"camera,omitempty"`
	Message string `json:"message"`
}

type IncidentLog struct {
	mu    sync.Mutex
	path  string
	items []Incident
}

const maxIncidents = 1000

func openIncidentLog(path string) *IncidentLog {
	l := &IncidentLog{path: path}
	if f, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			var in Incident
			if json.Unmarshal(sc.Bytes(), &in) == nil {
				l.items = append(l.items, in)
			}
		}
		f.Close()
	}
	if len(l.items) > maxIncidents {
		l.items = l.items[len(l.items)-maxIncidents:]
	}
	l.rewrite()
	return l
}

func (l *IncidentLog) rewrite() {
	var buf []byte
	for _, in := range l.items {
		b, _ := json.Marshal(in)
		buf = append(append(buf, b...), '\n')
	}
	_ = writeFileAtomic(l.path, buf, 0o644)
}

func (l *IncidentLog) Add(level, camera, format string, args ...any) {
	msg := redact(fmt.Sprintf(format, args...))
	if camera != "" {
		logf("[%s] %s", camera, msg)
	} else {
		logf("%s", msg)
	}
	in := Incident{Time: time.Now().UnixMilli(), Level: level, Camera: camera, Message: msg}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.items = append(l.items, in)
	if len(l.items) > maxIncidents*2 {
		l.items = l.items[len(l.items)-maxIncidents:]
		l.rewrite()
		return
	}
	if f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		b, _ := json.Marshal(in)
		f.Write(append(b, '\n'))
		f.Close()
	}
}

func (l *IncidentLog) List(limit int) []Incident {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(l.items)
	if limit <= 0 || limit > n {
		limit = n
	}
	out := make([]Incident, 0, limit)
	for i := n - 1; i >= n-limit; i-- {
		out = append(out, l.items[i])
	}
	return out
}
