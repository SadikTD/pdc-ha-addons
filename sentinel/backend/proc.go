package main

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// tailBuffer keeps the last few lines a child process wrote to stderr.
type tailBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (t *tailBuffer) add(line string) {
	line = strings.TrimSpace(redact(line))
	if line == "" {
		return
	}
	t.mu.Lock()
	t.lines = append(t.lines, line)
	if len(t.lines) > 20 {
		t.lines = t.lines[len(t.lines)-20:]
	}
	t.mu.Unlock()
}

func (t *tailBuffer) last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.lines) == 0 {
		return ""
	}
	return t.lines[len(t.lines)-1]
}

// startProc runs a command in its own process group that dies with Sentinel,
// so a crashed or restarted Sentinel never leaves orphan ffmpeg processes behind.
func startProc(name string, args []string, env []string, stdout io.Writer, tail *tailBuffer) (*exec.Cmd, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	if stdout != nil {
		cmd.Stdout = stdout
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 64*1024)
		for sc.Scan() {
			if tail != nil {
				tail.add(sc.Text())
			}
		}
	}()
	return cmd, nil
}

// stopProc asks politely (so ffmpeg closes the current file cleanly), then kills.
func stopProc(cmd *exec.Cmd, done <-chan struct{}) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGINT)
	select {
	case <-done:
		return
	case <-time.After(4 * time.Second):
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

// backoff grows 1s, 2s, 4s ... up to 10s: cameras coming back from a router restart
// are picked up within seconds, without hammering a camera that is really offline.
type backoff struct{ n int }

func (b *backoff) next() time.Duration {
	d := time.Second << b.n
	if d > 10*time.Second {
		d = 10 * time.Second
	} else {
		b.n++
	}
	return d
}

func (b *backoff) reset() { b.n = 0 }
