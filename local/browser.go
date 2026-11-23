package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const extensionOrigin = "chrome-extension://bhiemmbmefifaloapbcopihahhckolce"
const extensionVersion = "0.2.5"

//go:embed page_runtime.js
var embeddedPageRuntime string

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
	// internal 是客户端自己发的命令（借登录态）：不占用会话租约，没有租约也能被扩展取走。
	internal bool
	reply    chan browserReply
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
	// headless 只是 headlessClient() 在轮询/WS 握手时的缓存（登录态借用的 headedPeers 直接读它）：
	// 判据是本次启动写进扩展副本的 clientID，不是 UA，也不是「启动前后新出现的客户端」。
	headless bool
}

type browserWSConn struct {
	clientID string
	conn     net.Conn
	writeMu  sync.Mutex
	closed   chan struct{}
}

func (c *browserWSConn) sendJSON(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return writeWebSocketServerFrame(c.conn, 0x1, payload)
}

func (c *browserWSConn) sendPong(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return writeWebSocketServerFrame(c.conn, 0xA, payload)
}

func (c *browserWSConn) closeConn() {
	c.writeMu.Lock()
	_ = writeWebSocketServerFrame(c.conn, 0x8, nil)
	c.writeMu.Unlock()
	_ = c.conn.Close()
}

// writeWebSocketServerFrame 写入服务端 RFC6455 帧（服务端发给客户端的帧不带掩码）。
func writeWebSocketServerFrame(w io.Writer, opcode byte, payload []byte) error {
	header := []byte{0x80 | (opcode & 0x0f)}
	n := len(payload)
	switch {
	case n < 126:
		header = append(header, byte(n))
	case n < 65536:
		header = append(header, 126, byte(n>>8), byte(n))
	default:
		header = append(header, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	if n > 0 {
		_, err := w.Write(payload)
		return err
	}
	return nil
}

type browserBridge struct {
	mu                   sync.Mutex
	token                string
	port                 int
	clients              map[string]browserPeer
	wsConns              map[string]*browserWSConn
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
	return &browserBridge{
		token:   hex.EncodeToString(token),
		clients: make(map[string]browserPeer),
		wsConns: make(map[string]*browserWSConn),
		queues:  make(map[string]chan *browserCommand),
		pending: make(map[string]*browserCommand),
	}
}

func (b *browserBridge) start() (*http.Server, error) {
	for port := 47753; port <= 47762; port++ {
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
	return nil, fmt.Errorf("Chrome extension loopback ports 47753–47762 are occupied")
}

// liveLocked 清掉已停止轮询/断线的扩展实例，返回按 ID 排序的存活列表。调用方持有 b.mu。
func (b *browserBridge) liveLocked() []string {
	live := []string{}
	for client, peer := range b.clients {
		if time.Since(peer.lastAt) >= 45*time.Second && b.wsConns[client] == nil {
			delete(b.clients, client)
			delete(b.queues, client)
		} else {
			live = append(live, client)
		}
	}
	sort.Strings(live)
	return live
}

// headlessClientID 本次启动写进扩展副本的实例标识；空表示没在自己拉起无头 Chrome。
func headlessClientID() string {
	if h := headlessBrowser.Load(); h != nil {
		return h.clientID()
	}
	return ""
}

// headlessClientLocked 调用方持有 b.mu 且已用 liveLocked 清过过期实例。
func (b *browserBridge) headlessClientLocked(live []string) string {
	if id := headlessClientID(); id != "" {
		for _, client := range live {
			if client == id {
				return id
			}
		}
		return ""
	}
	for _, client := range live {
		if b.clients[client].headless {
			return client
		}
	}
	return ""
}

// headlessClient 已连上来的无头实例；空表示没有。
func (b *browserBridge) headlessClient() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.headlessClientLocked(b.liveLocked())
}

// forget 立刻把一个实例从桥接里摘掉：它的进程已经被我们杀掉，不会再通信。
func (b *browserBridge) forget(client string) {
	b.mu.Lock()
	ws := b.wsConns[client]
	delete(b.wsConns, client)
	delete(b.clients, client)
	delete(b.queues, client)
	if b.primaryID == client {
		b.primaryID = ""
	}
	b.mu.Unlock()
	if ws != nil {
		ws.closeConn()
	}
}

// The caller holds b.mu for status and queue selection.
func (b *browserBridge) status() map[string]any {
	live := b.liveLocked()
	headless := b.headlessClientLocked(live)
	headlessMode := headlessBrowser.Load() != nil
	want := func(client string) bool {
		if headlessMode {
			return client != "" && client == headless
		}
		return !b.clients[client].headless
	}
	primary := func() string {
		for _, client := range live {
			if want(client) && b.clients[client].browser == "Google Chrome" {
				return client
			}
		}
		if _, ok := b.clients[b.primaryID]; ok && want(b.primaryID) {
			return b.primaryID
		}
		for _, client := range live {
			if want(client) {
				return client
			}
		}
		return ""
	}
	if b.leaseClient == "" {
		b.primaryID = primary()
	}
	client := b.primaryID
	if b.leaseClient != "" {
		client = b.leaseClient
	}
	peer, connected := b.clients[client]
	browsers := []string{}
	for _, id := range live {
		label := b.clients[id].browser
		if b.clients[id].headless {
			label += "（无头）"
		}
		browsers = append(browsers, label)
	}
	mode := "real"
	notice := ""
	if h := headlessBrowser.Load(); h != nil {
		mode, notice = "headless", h.currentNotice()
	}
	return map[string]any{
		"connected":        connected,
		"browser":          peer.browser,
		"headless":         client != "" && client == headless,
		"browsers":         browsers,
		"mode":             mode,
		"notice":           notice,
		"origin":           fmt.Sprintf("http://127.0.0.1:%d", b.port),
		"extensionId":      strings.TrimPrefix(extensionOrigin, "chrome-extension://"),
		"extensionVersion": extensionVersion,
	}
}

func (b *browserBridge) ensureHeadless(ctx context.Context) error {
	h := headlessBrowser.Load()
	if h == nil {
		return nil
	}
	if b.headlessClient() != "" {
		h.touch()
	} else if err := h.ensure(b, ctx); err != nil {
		return err
	}
	b.borrowLogin(h)
	return nil
}

func (b *browserBridge) leased() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connection != nil
}

func (b *browserBridge) leasedByOther(connection context.Context, session string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connection != nil && (b.connection != connection || b.session != session)
}

func (b *browserBridge) queue(client string) chan *browserCommand {
	if b.queues[client] == nil {
		b.queues[client] = make(chan *browserCommand, 128)
	}
	return b.queues[client]
}

// pushCommandViaWS attempts instant push to an active WebSocket peer; returns true if pushed.
// Caller must NOT hold b.mu.
func (b *browserBridge) pushCommandViaWS(command *browserCommand) bool {
	b.mu.Lock()
	ws := b.wsConns[command.client]
	if ws == nil || b.pending[command.ID] != command {
		b.mu.Unlock()
		return false
	}
	command.ExpiresAt = time.Now().Add(command.budget).UnixMilli()
	close(command.picked)
	b.mu.Unlock()

	var rawArgs any = map[string]any{}
	if len(command.Args) > 0 {
		rawArgs = json.RawMessage(command.Args)
	}
	msg := map[string]any{
		"type":      "cmd",
		"id":        command.ID,
		"op":        command.Operation,
		"args":      rawArgs,
		"expiresAt": command.ExpiresAt,
	}
	if err := ws.sendJSON(msg); err != nil {
		b.mu.Lock()
		if b.wsConns[command.client] == ws {
			delete(b.wsConns, command.client)
		}
		b.mu.Unlock()
		_ = ws.conn.Close()
		return true // picked & attempted on the wire; caller handles reply/timeout
	}
	return true
}

func (b *browserBridge) internal(client, operation string, args map[string]any, timeout time.Duration) (any, error) {
	payload, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	id := "local-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	b.mu.Lock()
	if _, online := b.clients[client]; !online {
		b.mu.Unlock()
		return nil, errors.New("浏览器已断开")
	}
	pickup := 20 * time.Second
	command := &browserCommand{
		ID: id, Operation: operation, Args: payload, client: client, generation: b.generation, internal: true,
		reply: make(chan browserReply, 1), budget: timeout, pickupBy: time.Now().Add(pickup), picked: make(chan struct{}),
	}
	b.pending[id] = command
	hasWS := b.wsConns[client] != nil
	var queue chan *browserCommand
	if !hasWS {
		queue = b.queue(client)
	}
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()

	if hasWS {
		b.pushCommandViaWS(command)
	} else {
		select {
		case queue <- command:
		default:
			return nil, errors.New("浏览器命令队列已满")
		}
		select {
		case <-command.picked:
		case <-time.After(pickup):
			return nil, errors.New("扩展没有取走命令（后台可能被 Chrome 挂起）")
		}
	}
	select {
	case reply := <-command.reply:
		if reply.Error != "" {
			return nil, errors.New(reply.Error)
		}
		return reply.Result, nil
	case <-time.After(timeout):
		return nil, errors.New("扩展响应超时")
	}
}

func (b *browserBridge) hideCursorAsync(client string) {
	if client == "" {
		return
	}
	b.mu.Lock()
	ws := b.wsConns[client]
	b.mu.Unlock()
	if ws != nil {
		_ = ws.sendJSON(map[string]any{
			"type": "cmd",
			"id":   "cursor-hide-" + strconv.FormatInt(time.Now().UnixNano(), 36),
			"op":   "cursor_hide",
			"args": map[string]any{"immediate": false},
		})
	}
}

func (b *browserBridge) releaseConnection(connection context.Context, retained ...string) {
	b.mu.Lock()
	for _, session := range retained {
		if b.session == session {
			b.mu.Unlock()
			return
		}
	}
	var oldClient string
	if b.connection == connection {
		oldClient = b.leaseClient
		b.generation++
		b.connection, b.session, b.leaseClient = nil, "", ""
	}
	b.mu.Unlock()
	if oldClient != "" {
		go b.hideCursorAsync(oldClient)
	}
}

func browserOperationTimeout(op string) time.Duration {
	switch op {
	case "view", "act", "open", "new_tab", "goto", "reload", "eval", "cookies_export", "cookies_import", "apply_storage":
		return 25 * time.Second
	case "cdp", "devtools", "debug", "select_tab", "close_tab", "back", "forward", "stop", "downloads", "cursor_hide", "reload_ext", "set_proxy":
		return 10 * time.Second
	default:
		return 3 * time.Second
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
	b.mu.Unlock()
	if req.Operation != "release" && req.Operation != "status" && !b.leasedByOther(connection, req.Session) {
		if err := b.ensureHeadless(ctx); err != nil {
			return map[string]any{"status": "unavailable", "error": err.Error()}
		}
	}
	b.mu.Lock()
	if req.Operation == "release" {
		released := b.connection == connection && b.session == req.Session
		var oldClient string
		if released {
			oldClient = b.leaseClient
			b.generation++
			b.connection, b.session, b.leaseClient = nil, "", ""
		}
		b.mu.Unlock()
		if released {
			go b.hideCursorAsync(oldClient)
			b.syncLoginAfterTurn()
		}
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
		if headlessBrowser.Load() != nil {
			return map[string]any{"status": "unavailable", "error": "客户端无头 Chrome 没有连上 Vega 扩展；可在「设置 → 浏览器」改用「我自己的 Chrome」，或先确认本机 Chrome ≥125 后重试。不会使用服务端浏览器。"}
		}
		return map[string]any{"status": "unavailable", "error": "客户端本地 Chrome 扩展未连接或已更换，请在所选电脑加载/重新连接 Vega Chrome 扩展，或在「设置 → 浏览器」改用默认的无头 Chrome；不会使用服务端浏览器。"}
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
	case "tabs", "downloads", "open", "new_tab", "select_tab", "close_tab",
		"goto", "back", "forward", "reload", "reload_ext", "stop",
		"view", "act", "eval", "debug", "devtools", "cursor_hide",
		"set_proxy", "cookies_export", "cookies_import", "apply_storage", "cdp":
	default:
		b.mu.Unlock()
		return failure("Unknown browser operation")
	}
	timeout := browserOperationTimeout(req.Operation)
	command := &browserCommand{
		ID: j.ID, Operation: req.Operation, Args: req.Args,
		ExpiresAt: time.Now().Add(browserPickupWait + timeout).UnixMilli(),
		client:    b.leaseClient, generation: b.generation,
		reply: make(chan browserReply, 1), budget: timeout,
		pickupBy: time.Now().Add(browserPickupWait), picked: make(chan struct{}),
	}
	b.pending[j.ID] = command
	hasWS := b.wsConns[command.client] != nil
	var queue chan *browserCommand
	if !hasWS {
		queue = b.queue(command.client)
	}
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, j.ID); b.mu.Unlock() }()

	if hasWS {
		b.pushCommandViaWS(command)
	} else {
		select {
		case queue <- command:
		default:
			return failure("Local browser queue is full; input not sent")
		}
		pickup := time.NewTimer(browserPickupWait)
		defer pickup.Stop()
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
				return map[string]any{"status": "unavailable", "error": "本地 Chrome 扩展未取走命令（Vega 扩展后台可能被 Chrome 挂起或已断开），本步未执行，可以直接重试；持续出现请在 chrome://extensions 确认 Vega Chrome 已启用"}
			}
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

func detectBrowserFromUA(ua string) string {
	switch {
	case strings.Contains(ua, "Edg/"):
		return "Microsoft Edge"
	case strings.Contains(ua, "OPR/"):
		return "Opera"
	case strings.Contains(ua, "Chrome/"):
		return "Google Chrome"
	default:
		return "unknown"
	}
}

func (b *browserBridge) recordPeerLocked(clientID, ua string) {
	browser := detectBrowserFromUA(ua)
	peer := b.clients[clientID]
	peer.lastAt, peer.browser = time.Now(), browser
	id := headlessClientID()
	peer.headless = peer.headless || clientID == id || id == "" && strings.Contains(ua, "HeadlessChrome")
	b.clients[clientID] = peer
}

func (b *browserBridge) serveWS(w http.ResponseWriter, r *http.Request) {
	clientID := r.URL.Query().Get("clientId")
	token := r.URL.Query().Get("token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if !extensionClientID.MatchString(clientID) {
		http.Error(w, "Invalid clientId", 400)
		return
	}
	if token != b.token {
		http.Error(w, "Unauthorized", 403)
		return
	}
	wsKey := r.Header.Get("Sec-WebSocket-Key")
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || wsKey == "" {
		http.Error(w, "WebSocket Upgrade required", 426)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "WebSocket hijack unsupported", 500)
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	sum := sha1.Sum([]byte(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	handshake := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := rw.WriteString(handshake); err != nil {
		_ = conn.Close()
		return
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	_ = conn.SetDeadline(time.Time{})

	ws := &browserWSConn{clientID: clientID, conn: conn, closed: make(chan struct{})}
	b.mu.Lock()
	old := b.wsConns[clientID]
	b.wsConns[clientID] = ws
	b.recordPeerLocked(clientID, r.Header.Get("User-Agent"))
	b.mu.Unlock()
	if old != nil {
		old.closeConn()
	}

	defer func() {
		b.mu.Lock()
		if b.wsConns[clientID] == ws {
			delete(b.wsConns, clientID)
		}
		b.mu.Unlock()
		close(ws.closed)
		_ = conn.Close()
	}()

	_ = ws.sendJSON(map[string]any{
		"type":    "hello",
		"version": extensionVersion,
		"runtime": embeddedPageRuntime,
	})

	for {
		opcode, data, err := readWebSocketFrame(rw.Reader)
		if err != nil {
			return
		}
		switch opcode {
		case 0x8:
			return
		case 0x9:
			_ = ws.sendPong(data)
			b.mu.Lock()
			if peer, exists := b.clients[clientID]; exists {
				peer.lastAt = time.Now()
				b.clients[clientID] = peer
			}
			b.mu.Unlock()
			continue
		case 0xA:
			continue
		case 0x1:
		default:
			continue
		}
		var msg struct {
			Type   string          `json:"type"`
			ID     string          `json:"id"`
			Result any             `json:"result"`
			Error  string          `json:"error"`
			Raw    json.RawMessage `json:"raw"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "ping":
			b.mu.Lock()
			if peer, exists := b.clients[clientID]; exists {
				peer.lastAt = time.Now()
				b.clients[clientID] = peer
			}
			b.mu.Unlock()
			_ = ws.sendJSON(map[string]any{"type": "pong"})
		case "reply":
			b.mu.Lock()
			command := b.pending[msg.ID]
			if command != nil && command.client == clientID {
				select {
				case command.reply <- browserReply{Result: msg.Result, Error: msg.Error}:
				default:
				}
			}
			b.mu.Unlock()
		case "miniapp_triggers":
			_ = ws.sendJSON(map[string]any{
				"type":   "host_reply",
				"id":     msg.ID,
				"result": map[string]any{"triggers": []any{}},
			})
		case "miniapp_launch":
			_ = ws.sendJSON(map[string]any{
				"type":  "host_reply",
				"id":    msg.ID,
				"error": "No published miniapp launcher configured",
			})
		}
	}
}

func (b *browserBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != extensionOrigin {
		http.Error(w, "Invalid extension origin", 403)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", extensionOrigin)
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	if r.Method == http.MethodGet && r.URL.Path == "/ws" {
		b.serveWS(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Connection", "close")
	if r.Method == http.MethodOptions {
		_, _ = w.Write([]byte("{}"))
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/health" {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "app": "vega", "version": extensionVersion})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", 405)
		return
	}
	if r.URL.Path == "/pair" {
		_ = json.NewEncoder(w).Encode(map[string]string{"token": b.token, "app": "vega"})
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
		b.recordPeerLocked(body.ClientID, r.Header.Get("User-Agent"))
		queue := b.queue(body.ClientID)
		b.mu.Unlock()
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		for {
			select {
			case command := <-queue:
				b.mu.Lock()
				valid := b.pending[command.ID] == command && command.client == body.ClientID && time.Now().Before(command.pickupBy) && (command.internal || (b.connection != nil && command.generation == b.generation))
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
