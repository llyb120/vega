// Vega local execution agent: no UI, tray icon only. Registers with the local
// Vega server so cloud sessions run read/bash/write/edit on this machine.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	pingInterval = 2 * time.Second
	maxBody      = 40 << 20
	maxOutput    = 2 << 20 // 2 MiB, matches server shell()
)

// serverBase is the local Vega URL the agent talks to. Same machine only.
func serverBase() string {
	if v := os.Getenv("VEGA_LOCAL_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://127.0.0.1:8080"
}

type Agent struct {
	cwd    string
	token  string
	port   int
	closed atomic.Bool
	mu     sync.Mutex
	client *http.Client
}

func main() {
	a := &Agent{
		client: &http.Client{Timeout: 5 * time.Second},
	}
	// Pick a loopback port first so we can report it on register.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	a.port = lis.Addr().(*net.TCPAddr).Port
	cwd, _ := os.Getwd()
	a.cwd = cwd

	mux := http.NewServeMux()
	mux.HandleFunc("/exec", a.handleExec)
	mux.HandleFunc("/file", a.handleFile)
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(lis) }()

	go a.loop()
	fmt.Fprintf(os.Stderr, "vega-local: listening on 127.0.0.1:%d, cwd=%s, server=%s\n", a.port, a.cwd, serverBase())
	systrayRun(func() {
		a.closed.Store(true)
		_ = srv.Close()
		a.deregister()
		os.Exit(0)
	})
}

// ---- registration / heartbeat ----

func (a *Agent) loop() {
	for !a.closed.Load() {
		err := a.register()
		a.setConnected(err == nil)
		if err == nil {
			// Registered: fast ping keeps us "online"; a single missed ping
			// within ~3s marks us down on the server.
			for !a.closed.Load() {
				if err := a.ping(); err != nil {
					a.setConnected(false)
					break // server forgot us / unreachable -> re-register
				}
				time.Sleep(pingInterval)
			}
		} else {
			// Can't reach Vega (not running yet / network). Retry quickly.
			time.Sleep(pingInterval)
		}
	}
}

func (a *Agent) setConnected(v bool) {
	setState(v)
}

func (a *Agent) call(path string) error {
	req, err := http.NewRequest(http.MethodPost, serverBase()+"/api/local-agent/"+path,
		bytes.NewReader(a.body()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (a *Agent) body() []byte {
	b, _ := json.Marshal(map[string]any{
		"port":  a.port,
		"token": a.token,
		"cwd":   a.cwd,
	})
	return b
}

func (a *Agent) register() error {
	// A fresh secret each (re)register; server stores it alongside our port.
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	a.token = hex.EncodeToString(buf)
	return a.call("register")
}

func (a *Agent) ping() error { return a.call("ping") }
func (a *Agent) deregister() {
	req, err := http.NewRequest(http.MethodDelete, serverBase()+"/api/local-agent/"+fmt.Sprint(a.port)+"?token="+a.token, nil)
	if err == nil {
		resp, err := a.client.Do(req)
		if err == nil {
			resp.Body.Close()
		}
	}
}

// ---- auth for local HTTP: only requests carrying our per-session token ----

func (a *Agent) authed(r *http.Request) bool {
	return a.token != "" && r.Header.Get("X-Local-Token") == a.token
}

type execReq struct {
	Cwd     string `json:"cwd"`
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}

func (a *Agent) handleExec(w http.ResponseWriter, r *http.Request) {
	if !a.authed(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req execReq
	if !jsonOK(w, r, &req) || strings.TrimSpace(req.Command) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	timeout := req.Timeout
	if timeout <= 0 || timeout > 600 {
		timeout = 120
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = a.cwd
	}
	// Resolve within this machine; refuse paths that don't exist locally.
	if abs, err := filepath.Abs(cwd); err == nil {
		cwd = abs
	}
	if _, err := os.Stat(cwd); err != nil {
		writeJSON(w, map[string]any{
			"output": "", "exitCode": -1,
			"error": "cwd not found on local machine: " + cwd,
		})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeout)*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		shell := os.Getenv("VEGA_POWERSHELL")
		if shell == "" {
			shell = "powershell.exe"
		}
		cmd = exec.CommandContext(ctx, shell, "-NoProfile", "-NonInteractive", "-Command", req.Command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", req.Command)
	}
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	truncated := false
	if len(out) > maxOutput {
		out = out[:maxOutput]
		truncated = true
	}
	code := 0
	var emsg string
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
			emsg = err.Error()
		}
	}
	if ctx.Err() == context.DeadlineExceeded {
		code = -1
		emsg = "Cancelled/timeout"
	}
	writeJSON(w, map[string]any{
		"output": string(out), "truncated": truncated,
		"exitCode": code, "error": emsg,
	})
}

type fileReq struct {
	Op      string     `json:"op"` // stat | read | write | edit
	Path    string     `json:"path"`
	Content string     `json:"content"` // base64
	Edits   []fileEdit `json:"edits"`
}

type fileEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

func (a *Agent) handleFile(w http.ResponseWriter, r *http.Request) {
	if !a.authed(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req fileReq
	if !jsonOK(w, r, &req) || req.Path == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	path := req.Path
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	switch req.Op {
	case "stat":
		st, err := os.Stat(path)
		writeJSON(w, map[string]any{
			"exists": err == nil,
			"isFile": err == nil && st.Mode().IsRegular(),
			"isDir":  err == nil && st.IsDir(),
			"size":   sizeOf(st),
		})
	case "read":
		b, err := os.ReadFile(path)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{
			"content": base64.StdEncoding.EncodeToString(b),
		})
	case "write":
		data, err := base64.StdEncoding.DecodeString(req.Content)
		if err != nil {
			writeJSON(w, map[string]any{"error": "invalid base64 content"})
			return
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	case "edit":
		writeJSON(w, editFile(path, req.Edits))
	default:
		http.Error(w, "unknown op", http.StatusBadRequest)
	}
}

func sizeOf(st os.FileInfo) int64 {
	if st == nil {
		return 0
	}
	return st.Size()
}

// editFile mirrors server mutate(): exact unique oldText -> newText.
// oldText must match literally (\r\n tolerated in the request); newText is
// inserted verbatim. Line endings are otherwise left untouched.
func editFile(path string, edits []fileEdit) map[string]any {
	b, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if len(b) > 32<<20 {
		return map[string]any{"error": "Edit file exceeds32MiB"}
	}
	value := string(b)
	crlf := strings.Contains(value, "\r\n")
	// Try literal match; if it fails and file uses CRLF, retry after
	// normalizing oldText's LFs so callers can send \n against \r\n files.
	match := func(v, old string) int { return strings.Index(v, old) }
	type rng struct {
		start, end int
		text       string
	}
	ranges := make([]rng, 0, len(edits))
	for _, e := range edits {
		if e.OldText == "" {
			return map[string]any{"error": "Exact nonempty oldText/newText required"}
		}
		start := match(value, e.OldText)
		if start < 0 && crlf {
			old := strings.ReplaceAll(e.OldText, "\n", "\r\n")
			start = match(value, old)
		}
		if start < 0 || strings.Index(value[start+len(e.OldText):], e.OldText) >= 0 {
			return map[string]any{"error": "oldText must match exactly one region; no file changed."}
		}
		ranges = append(ranges, rng{start, start + len(e.OldText), e.NewText})
	}
	// sort by start, reject overlaps, then apply back-to-front.
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	for i := 1; i < len(ranges); i++ {
		if ranges[i].start < ranges[i-1].end {
			return map[string]any{"error": "Overlapping edits; no file changed"}
		}
	}
	for i := len(ranges) - 1; i >= 0; i-- {
		r := ranges[i]
		value = value[:r.start] + r.text + value[r.end:]
	}
	if err := os.WriteFile(path, []byte(value), 0o644); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"path": path, "bytes": len(value)}
}

func jsonOK(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil || json.Unmarshal(body, v) != nil {
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
