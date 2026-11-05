// Vega local execution agent. The website is used only for initial authorization.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
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
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	localAddress = "127.0.0.1:47673"
	maxBody      = 48 << 20
	maxOutput    = 2 << 20
)

type Agent struct {
	mu              sync.Mutex
	config          Config
	configPath      string
	configToken     string
	pendingOrigins  map[string]bool
	connections     map[*websocket.Conn]struct{}
	direct          map[string]*directConnection
	resumeInstances map[string]string
	updating        bool
	editing         bool
	context         context.Context
}

func main() {
	detachConsole()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version":
			fmt.Println(clientVersion)
			return
		case "--apply-update":
			must(applyUpdate(os.Args[2:]))
			return
		}
	}
	a, err := newAgent()
	must(err)
	clearKeys()
	lis, err := net.Listen("tcp", localAddress)
	must(err)
	browserServer, browserErr := localChrome.start()
	if browserErr != nil {
		fmt.Fprintln(os.Stderr, "vega-local browser:", browserErr)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/agent", a.serveWS)
	mux.HandleFunc("/config/"+a.configToken, a.configure)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(lis) }()
	ctx, cancel := context.WithCancel(context.Background())
	must(notifyUpdateReady())
	a.startConnections(ctx)
	configure := func() { openBrowser("http://" + localAddress + "/config/" + a.configToken) }
	fmt.Fprintln(os.Stderr, "vega-local: connection settings at http://"+localAddress+"/config/"+a.configToken)
	quit := func() {
		cancel()
		a.mu.Lock()
		for conn := range a.connections {
			_ = conn.Close()
		}
		a.mu.Unlock()
		_ = srv.Close()
		if browserServer != nil {
			_ = browserServer.Close()
		}
		os.Exit(0)
	}
	go a.autoUpdate(ctx, quit)
	systrayRun(configure, quit)
}

type job struct {
	Busy bool            `json:"busy"`
	Type string          `json:"type"`
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args"`
}

func (a *Agent) serveWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", 405)
		return
	}
	// Unapproved sites receive only permission status; no login exchange or jobs.
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return validOrigin(r.Header.Get("Origin")) }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	origin := r.Header.Get("Origin")
	conn.SetReadLimit(4096)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var auth struct {
		Type   string `json:"type"`
		Ticket string `json:"ticket"`
		UserID string `json:"userId"`
	}
	if conn.ReadJSON(&auth) != nil || auth.Type != "auth" || auth.UserID == "" {
		pairingStatus(conn, connectionStatus{Code: "login_invalid"})
		return
	}
	if !a.allowOrigin(origin) {
		pairingStatus(conn, connectionStatus{Code: "permission_required"})
		return
	}
	a.mu.Lock()
	var existing string
	for _, saved := range a.config.Servers {
		if saved.Origin == origin && saved.UserID == auth.UserID {
			existing, _ = unprotectToken(saved.Token)
		}
	}
	clientID := a.config.ClientID
	a.mu.Unlock()
	pairingStatus(conn, connectionStatus{Code: "authorizing"})
	proof, err := verifyLogin(origin, auth.Ticket, clientID, existing)
	if err != nil {
		if failure, ok := err.(*pairingError); ok {
			pairingStatus(conn, failure.connectionStatus)
		} else {
			pairingStatus(conn, connectionStatus{Code: "login_invalid"})
		}
		return
	}
	if proof.UserID != auth.UserID {
		pairingStatus(conn, connectionStatus{Code: "login_invalid"})
		return
	}
	saved, err := a.saveCredential(origin, proof)
	if err != nil {
		pairingStatus(conn, connectionStatus{Code: "credential_save"})
		return
	}
	connection := a.startConnection(saved, proof.DeviceToken)
	if connection == nil {
		pairingStatus(conn, connectionStatus{Code: "permission_required"})
		return
	}
	pairingStatus(conn, connectionStatus{Code: "backend_connecting"})
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	for {
		a.mu.Lock()
		status, changed := connection.status, connection.changed
		a.mu.Unlock()
		if status.Code == "connected" {
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_ = conn.WriteJSON(map[string]any{"type": "paired", "instance": proof.Instance, "userId": proof.UserID, "clientId": clientID, "connected": true})
			return
		}
		if status.Code != "backend_connecting" {
			pairingStatus(conn, status)
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		case <-deadline.C:
			pairingStatus(conn, connectionStatus{Code: "backend_timeout"})
			return
		}
	}
}
func pairingStatus(conn *websocket.Conn, status connectionStatus) {
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = conn.WriteJSON(struct {
		Type string `json:"type"`
		connectionStatus
	}{Type: "status", connectionStatus: status})
}
func execute(ctx context.Context, j job) map[string]any {
	if j.Op == "exec" {
		var req execReq
		if json.Unmarshal(j.Args, &req) != nil || strings.TrimSpace(req.Command) == "" || len(req.Command) > 2<<20 {
			return failure("Invalid command")
		}
		return runCommand(ctx, req)
	}
	if j.Op == "file" {
		var req fileReq
		if json.Unmarshal(j.Args, &req) != nil || req.Path == "" {
			return failure("path required")
		}
		return fileOperation(req)
	}
	if j.Op == "key" {
		var req keyReq
		if json.Unmarshal(j.Args, &req) != nil {
			return failure("Invalid key request")
		}
		return keyOperation(req)
	}
	return failure("Unknown operation")
}
func failure(message string) map[string]any { return map[string]any{"error": message} }

type execReq struct {
	Cwd     string `json:"cwd"`
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}
type limitedOutput struct {
	mu        sync.Mutex
	data      bytes.Buffer
	truncated bool
}

func (b *limitedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := maxOutput - b.data.Len()
	if n > remaining {
		p = p[:remaining]
		b.truncated = true
	}
	_, _ = b.data.Write(p)
	return n, nil
}
func runCommand(parent context.Context, req execReq) map[string]any {
	if message := commandPolicyError(req.Command); message != "" {
		return failure(message)
	}
	if req.Timeout < 1 || req.Timeout > 600 {
		return failure("Invalid timeout")
	}
	st, err := os.Stat(req.Cwd)
	if err != nil || !st.IsDir() {
		return failure("cwd must be an existing directory on this machine")
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(req.Timeout)*time.Second)
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
	cmd.Dir = req.Cwd
	configureCommand(cmd)
	cmd.WaitDelay = 2 * time.Second
	output := &limitedOutput{}
	cmd.Stdout = output
	cmd.Stderr = output
	err = cmd.Run()
	code := 0
	message := ""
	if err != nil {
		code = -1
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			message = err.Error()
		}
	}
	if ctx.Err() != nil {
		code = -1
		message = "Cancelled/timeout"
	}
	return map[string]any{"output": output.data.String(), "truncated": output.truncated, "exitCode": code, "error": message}
}

type fileReq struct {
	Op      string     `json:"op"`
	Cwd     string     `json:"cwd"`
	Path    string     `json:"path"`
	Content string     `json:"content"`
	Edits   []fileEdit `json:"edits"`
}
type fileEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

func fileOperation(req fileReq) map[string]any {
	path := strings.TrimPrefix(strings.TrimSpace(req.Path), "@")
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return failure(err.Error())
		}
		path = filepath.Join(home, strings.TrimLeft(path[1:], "/\\"))
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(req.Cwd, path)
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return failure(err.Error())
	}
	switch req.Op {
	case "stat":
		st, err := os.Stat(path)
		return map[string]any{"path": path, "isDir": err == nil && st.IsDir()}
	case "upload":
		root, err := filepath.EvalSymlinks(req.Cwd)
		if err != nil {
			return failure(err.Error())
		}
		root, err = filepath.Abs(root)
		if err != nil {
			return failure(err.Error())
		}
		file, err := filepath.EvalSymlinks(path)
		if err != nil {
			return failure(err.Error())
		}
		rel, err := filepath.Rel(root, file)
		st, statErr := os.Stat(file)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) || statErr != nil || !st.Mode().IsRegular() {
			return failure("Only regular files within the working directory may be uploaded")
		}
		return map[string]any{"path": file}
	case "read":
		f, err := os.Open(path)
		if err != nil {
			return failure(err.Error())
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return failure(err.Error())
		}
		if !st.Mode().IsRegular() || st.Size() > 32<<20 {
			return failure("Regular file required, max32MiB")
		}
		data, err := io.ReadAll(io.LimitReader(f, (32<<20)+1))
		if err != nil {
			return failure(err.Error())
		}
		if len(data) > 32<<20 {
			return failure("File exceeds32MiB")
		}
		return map[string]any{"path": path, "content": base64.StdEncoding.EncodeToString(data)}
	case "write":
		data, err := base64.StdEncoding.DecodeString(req.Content)
		if err != nil || len(data) > 32<<20 {
			return failure("Invalid content or exceeds32MiB")
		}
		if err = writeAtomic(path, data); err != nil {
			return failure(err.Error())
		}
		return map[string]any{"path": path, "bytes": len(data)}
	case "edit":
		return editFile(path, req.Edits)
	}
	return failure("Unknown file operation")
}
func writeAtomic(path string, data []byte) error {
	mode := os.FileMode(0644)
	if st, err := os.Lstat(path); err == nil {
		if !st.Mode().IsRegular() {
			return fmt.Errorf("Regular file required")
		}
		mode = st.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".vega-edit-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func editFile(path string, edits []fileEdit) map[string]any {
	if len(edits) == 0 {
		return failure("edits required")
	}
	st, err := os.Lstat(path)
	if err != nil {
		return failure(err.Error())
	}
	if !st.Mode().IsRegular() || st.Size() > 32<<20 {
		return failure("Regular text file required, max32MiB")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return failure(err.Error())
	}
	if !utf8.Valid(b) || bytes.ContainsRune(b, 0) {
		return failure("Not a UTF-8 text file")
	}
	value := string(b)
	crlf := strings.Contains(value, "\r\n")
	type replacement struct {
		start, end int
		text       string
	}
	ranges := make([]replacement, 0, len(edits))
	for _, e := range edits {
		if e.OldText == "" {
			return failure("Exact nonempty oldText required")
		}
		old := e.OldText
		start := strings.Index(value, old)
		if start < 0 && crlf {
			old = strings.ReplaceAll(strings.ReplaceAll(old, "\r\n", "\n"), "\n", "\r\n")
			start = strings.Index(value, old)
		}
		if start < 0 || strings.Index(value[start+1:], old) >= 0 {
			return failure("oldText must match exactly one region; no file changed")
		}
		ranges = append(ranges, replacement{start, start + len(old), e.NewText})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	for i := 1; i < len(ranges); i++ {
		if ranges[i].start < ranges[i-1].end {
			return failure("Overlapping edits; no file changed")
		}
	}
	for i := len(ranges) - 1; i >= 0; i-- {
		r := ranges[i]
		value = value[:r.start] + r.text + value[r.end:]
	}
	if len(value) > 32<<20 {
		return failure("Edited file exceeds32MiB")
	}
	if err = writeAtomic(path, []byte(value)); err != nil {
		return failure(err.Error())
	}
	return map[string]any{"path": path, "bytes": len(value)}
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
