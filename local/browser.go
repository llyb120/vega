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
	"sort"
	"strings"
	"sync"
	"time"
)

const extensionOrigin = "chrome-extension://mdicifjlbgnkkdkcbfdnebeghhlamjbm"
const extensionVersion = "0.1.16"

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
	// budget runs from the moment the extension takes the command; pickupBy bounds waiting for a poller.
	budget   time.Duration
	pickupBy time.Time
	picked   chan struct{}
}

// Chrome suspends an idle MV3 worker after ~30s and the reconnect alarm wakes it within ~30s more,
// so a command may wait that long for a poller. Until it is taken it has certainly not executed.
var browserPickupWait = 30 * time.Second

type browserPeer struct {
	lastAt  time.Time
	browser string
}
type browserBridge struct {
	mu                   sync.Mutex
	token                string
	port                 int
	clients              map[string]browserPeer
	primaryID            string
	connection           context.Context
	session, leaseClient string
	generation           uint64
	queues               map[string]chan *browserCommand
	pending              map[string]*browserCommand
}

func newBrowserBridge() *browserBridge {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		panic(err)
	}
	return &browserBridge{token: hex.EncodeToString(token), clients: make(map[string]browserPeer), queues: make(map[string]chan *browserCommand), pending: make(map[string]*browserCommand)}
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

// The caller holds b.mu for status and queue selection.
func (b *browserBridge) status() map[string]any {
	live := []string{}
	for client, peer := range b.clients {
		if time.Since(peer.lastAt) >= 45*time.Second {
			delete(b.clients, client)
			delete(b.queues, client)
		} else {
			live = append(live, client)
		}
	}
	sort.Strings(live)
	current, connected := b.clients[b.primaryID]
	if !connected || current.browser != "Google Chrome" {
		if !connected {
			b.primaryID = ""
			if len(live) > 0 {
				b.primaryID = live[0]
			}
		}
		for _, client := range live {
			if b.clients[client].browser == "Google Chrome" {
				b.primaryID = client
				break
			}
		}
	}
	client := b.primaryID
	// A turn stays bound to its acquired browser even when another profile connects.
	if b.leaseClient != "" {
		client = b.leaseClient
	}
	peer, connected := b.clients[client]
	browsers := []string{}
	for _, client := range live {
		browsers = append(browsers, b.clients[client].browser)
	}
	return map[string]any{"connected": connected, "browser": peer.browser, "browsers": browsers, "origin": fmt.Sprintf("http://127.0.0.1:%d", b.port), "extensionId": strings.TrimPrefix(extensionOrigin, "chrome-extension://"), "extensionVersion": extensionVersion}
}
func (b *browserBridge) queue(client string) chan *browserCommand {
	if b.queues[client] == nil {
		b.queues[client] = make(chan *browserCommand, 128)
	}
	return b.queues[client]
}
func (b *browserBridge) releaseConnection(connection context.Context, retained ...string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, session := range retained {
		if b.session == session {
			return
		}
	}
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
	if status["connected"] != true {
		b.mu.Unlock()
		return map[string]any{"status": "unavailable", "error": "客户端本地 Chrome 扩展未连接或已更换，请在所选电脑加载/重新连接 Nova Chrome 扩展后继续；不会使用服务端浏览器。"}
	}
	if req.Operation == "acquire" {
		if b.connection == nil {
			b.generation++
			b.leaseClient = b.primaryID
		}
		b.connection, b.session = connection, req.Session
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
	timeout := 3 * time.Second
	if req.Operation == "cdp" || req.Operation == "devtools" {
		timeout = 10 * time.Second
	}
	command := &browserCommand{ID: j.ID, Operation: req.Operation, Args: req.Args, ExpiresAt: time.Now().Add(browserPickupWait + timeout).UnixMilli(), client: b.leaseClient, generation: b.generation, reply: make(chan browserReply, 1), budget: timeout, pickupBy: time.Now().Add(browserPickupWait), picked: make(chan struct{})}
	b.pending[j.ID] = command
	queue := b.queue(command.client)
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, j.ID); b.mu.Unlock() }()
	select {
	case queue <- command:
	default:
		return failure("Local browser queue is full; input not sent")
	}
	pickup := time.NewTimer(browserPickupWait)
	defer pickup.Stop()
	// Withdraw an untaken command under the lock so a poll cannot hand it out after we report "not executed".
	withdraw := func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		select {
		case <-command.picked:
			return false
		default:
			delete(b.pending, j.ID)
			return true
		}
	}
	select {
	case <-command.picked:
	case <-ctx.Done():
		if withdraw() {
			return failure("Browser operation cancelled before Chrome took it; not executed")
		}
	case <-pickup.C:
		if withdraw() {
			return map[string]any{"status": "unavailable", "error": "本地 Chrome 扩展未取走命令（Nova 扩展后台可能被 Chrome 挂起或已断开），本步未执行，可以直接重试；持续出现请在 chrome://extensions 确认 Nova Chrome 已启用"}
		}
	}
	timer := time.NewTimer(timeout + time.Second)
	defer timer.Stop()
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
	w.Header().Set("Connection", "close")
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
		http.Error(w, "Unauthorized", 403)
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
		browser := "unknown"
		ua := r.Header.Get("User-Agent")
		switch {
		case strings.Contains(ua, "Edg/"):
			browser = "Microsoft Edge"
		case strings.Contains(ua, "OPR/"):
			browser = "Opera"
		case strings.Contains(ua, "Chrome/"):
			browser = "Google Chrome"
		}
		b.clients[body.ClientID] = browserPeer{lastAt: time.Now(), browser: browser}
		queue := b.queue(body.ClientID)
		b.mu.Unlock()
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		for {
			select {
			case command := <-queue:
				b.mu.Lock()
				valid := b.pending[command.ID] == command && b.connection != nil && command.generation == b.generation && command.client == body.ClientID && time.Now().Before(command.pickupBy)
				if valid {
					command.ExpiresAt = time.Now().Add(command.budget).UnixMilli()
					close(command.picked)
				}
				b.mu.Unlock()
				if valid {
					_ = json.NewEncoder(w).Encode(map[string]any{"command": command, "version": extensionVersion})
					return
				}
			case <-timer.C:
				_ = json.NewEncoder(w).Encode(map[string]any{"command": nil, "version": extensionVersion})
				return
			case <-r.Context().Done():
				return
			}
		}
	case "/reply":
		b.mu.Lock()
		if _, known := b.clients[body.ClientID]; !known {
			b.mu.Unlock()
			http.Error(w, "Unknown Chrome client", 409)
			return
		}
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
