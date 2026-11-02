package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const extensionOrigin = "chrome-extension://mdicifjlbgnkkdkcbfdnebeghhlamjbm"

var extensionClientID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var localChrome = newBrowserBridge()

type browserReply struct {
	Result any    `json:"result"`
	Error  string `json:"error"`
}
type browserCommand struct {
	ID         string          `json:"id"`
	Operation  string          `json:"operation"`
	Args       json.RawMessage `json:"args"`
	ExpiresAt  int64           `json:"expiresAt"`
	client     string
	generation uint64
	reply      chan browserReply
}
type browserBridge struct {
	mu                   sync.Mutex
	token                string
	port                 int
	client, browser      string
	lastAt               time.Time
	connection           context.Context
	session, leaseClient string
	generation           uint64
	queue                chan *browserCommand
	pending              map[string]*browserCommand
}

func newBrowserBridge() *browserBridge {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		panic(err)
	}
	return &browserBridge{token: hex.EncodeToString(token), queue: make(chan *browserCommand, 16), pending: make(map[string]*browserCommand)}
}
func (b *browserBridge) start() (*http.Server, error) {
	for port := 47653; port <= 47662; port++ {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		b.mu.Lock()
		b.port = port
		b.mu.Unlock()
		server := &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 25 * time.Second, IdleTimeout: 30 * time.Second}
		go func() { _ = server.Serve(listener) }()
		return server, nil
	}
	return nil, fmt.Errorf("Chrome extension loopback ports 47653–47662 are occupied")
}
func (b *browserBridge) status() map[string]any {
	connected := b.client != "" && time.Since(b.lastAt) < 45*time.Second
	browsers := []string{}
	if connected {
		browsers = append(browsers, b.browser)
	}
	return map[string]any{"connected": connected, "browser": b.browser, "browsers": browsers, "origin": fmt.Sprintf("http://127.0.0.1:%d", b.port), "extensionId": strings.TrimPrefix(extensionOrigin, "chrome-extension://"), "extensionVersion": "0.1.14"}
}
func (b *browserBridge) releaseConnection(connection context.Context) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.connection == connection {
		b.generation++
		b.connection, b.session, b.leaseClient = nil, "", ""
	}
}
func (b *browserBridge) execute(connection, ctx context.Context, j job) map[string]any {
	var req struct {
		Session   string          `json:"session"`
		Operation string          `json:"operation"`
		Args      json.RawMessage `json:"args"`
	}
	if json.Unmarshal(j.Args, &req) != nil || !extensionClientID.MatchString(req.Session) {
		return failure("Invalid browser session")
	}
	if ctx.Err() != nil || connection.Err() != nil {
		return failure("Browser operation cancelled; do not replay")
	}
	b.mu.Lock()
	if ctx.Err() != nil || connection.Err() != nil {
		b.mu.Unlock()
		return failure("Browser operation cancelled; do not replay")
	}
	if req.Operation == "release" {
		if b.connection == connection && b.session == req.Session {
			b.generation++
			b.connection, b.session, b.leaseClient = nil, "", ""
		}
		b.mu.Unlock()
		return map[string]any{"result": map[string]any{"ok": true}}
	}
	if b.connection != nil && (b.connection != connection || b.session != req.Session) {
		b.mu.Unlock()
		return map[string]any{"status": "busy", "error": "客户端本地浏览器正由另一个会话独占，本步未执行；请等该会话结束后回复「继续」。"}
	}
	status := b.status()
	if req.Operation == "status" {
		b.mu.Unlock()
		return map[string]any{"result": status}
	}
	if status["connected"] != true || (b.leaseClient != "" && b.leaseClient != b.client) {
		b.mu.Unlock()
		return map[string]any{"status": "unavailable", "error": "客户端本地 Chrome 扩展未连接或已更换，请在所选电脑加载/重新连接 Nova Chrome 扩展后继续；不会使用服务端浏览器。"}
	}
	if req.Operation == "acquire" {
		if b.connection == nil {
			b.generation++
		}
		b.connection, b.session, b.leaseClient = connection, req.Session, b.client
		b.mu.Unlock()
		return map[string]any{"result": status}
	}
	if b.connection != connection || b.session != req.Session {
		b.mu.Unlock()
		return failure("Acquire the local browser before operating")
	}
	if req.Operation == "workspace_file" {
		b.mu.Unlock()
		var file fileReq
		if json.Unmarshal(req.Args, &file) != nil || file.Path == "" || file.Cwd == "" {
			return failure("Upload requires cwd/path")
		}
		file.Op = "upload"
		r := fileOperation(file)
		if r["error"] != nil {
			return r
		}
		return map[string]any{"result": r}
	}
	switch req.Operation {
	case "tabs", "downloads", "open", "new_tab", "select_tab", "close_tab", "goto", "back", "forward", "reload", "stop", "devtools", "cdp":
	default:
		b.mu.Unlock()
		return failure("Unknown browser operation")
	}
	command := &browserCommand{ID: j.ID, Operation: req.Operation, Args: req.Args, ExpiresAt: time.Now().Add(10 * time.Second).UnixMilli(), client: b.client, generation: b.generation, reply: make(chan browserReply, 1)}
	b.pending[j.ID] = command
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, j.ID); b.mu.Unlock() }()
	timer := time.NewTimer(12 * time.Second)
	defer timer.Stop()
	select {
	case b.queue <- command:
	default:
		return failure("Local browser queue is full; input not sent")
	}
	select {
	case response := <-command.reply:
		if response.Error != "" {
			return failure(response.Error)
		}
		return map[string]any{"result": response.Result}
	case <-ctx.Done():
		return failure("Browser operation cancelled; it may have executed, do not replay")
	case <-timer.C:
		return failure("Local browser response timeout; it may have executed, do not replay")
	}
}
func (b *browserBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != extensionOrigin {
		http.Error(w, "Invalid extension origin", 403)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", extensionOrigin)
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodOptions {
		_, _ = w.Write([]byte("{}"))
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", 405)
		return
	}
	if r.URL.Path == "/pair" {
		_ = json.NewEncoder(w).Encode(map[string]string{"token": b.token})
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+b.token {
		http.Error(w, "Unauthorized", 401)
		return
	}
	var body struct {
		ClientID string `json:"clientId"`
		ID       string `json:"id"`
		browserReply
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&body) != nil || !extensionClientID.MatchString(body.ClientID) {
		http.Error(w, "Invalid browser message", 400)
		return
	}
	switch r.URL.Path {
	case "/poll":
		b.mu.Lock()
		if b.client != "" && b.client != body.ClientID && time.Since(b.lastAt) < 45*time.Second {
			b.mu.Unlock()
			http.Error(w, "Another browser is connected", 409)
			return
		}
		b.client, b.lastAt = body.ClientID, time.Now()
		ua := r.Header.Get("User-Agent")
		switch {
		case strings.Contains(ua, "Edg/"):
			b.browser = "Microsoft Edge"
		case strings.Contains(ua, "Chrome/"):
			b.browser = "Google Chrome"
		default:
			b.browser = "Chromium"
		}
		b.mu.Unlock()
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		for {
			select {
			case command := <-b.queue:
				b.mu.Lock()
				valid := b.pending[command.ID] == command && b.connection != nil && command.generation == b.generation && command.client == body.ClientID && command.ExpiresAt > time.Now().UnixMilli()
				b.mu.Unlock()
				if valid {
					_ = json.NewEncoder(w).Encode(map[string]any{"command": command})
					return
				}
			case <-timer.C:
				_, _ = w.Write([]byte(`{"command":null}`))
				return
			case <-r.Context().Done():
				return
			}
		}
	case "/reply":
		b.mu.Lock()
		command := b.pending[body.ID]
		if command != nil && command.client == body.ClientID {
			select {
			case command.reply <- body.browserReply:
			default:
			}
		}
		b.mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	case "/miniapp/triggers":
		_, _ = w.Write([]byte(`{"triggers":[]}`))
	default:
		http.Error(w, fmt.Sprintf("Unknown browser route: %s", r.URL.Path), 404)
	}
}
