package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
const extensionVersion = "0.2.0"

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
	// headless 只是 headlessClient() 在轮询时的缓存（登录态借用的 headedPeers 直接读它）：
	// 判据是本次启动写进扩展副本的 clientID，不是 UA，也不是「启动前后新出现的客户端」。
	headless bool
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

// liveLocked 清掉已停止轮询的扩展实例，返回按 ID 排序的存活列表。调用方持有 b.mu。
func (b *browserBridge) liveLocked() []string {
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
// 只认本次启动的那个 clientID：用户自己的 Chrome 永远不是无头实例，哪怕它的 UA 也写着 HeadlessChrome。
func (b *browserBridge) headlessClientLocked(live []string) string {
	if id := headlessClientID(); id != "" {
		for _, client := range live {
			if client == id {
				return id
			}
		}
		return ""
	}
	// 还没记下 clientID 的实例（旧配置 / 单测里的桩）：退回扩展自报的 UA 标记。
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

// forget 立刻把一个实例从桥接里摘掉：它的进程已经被我们杀掉，不会再轮询。
// 不摘的话它会一直留到 45 秒过期：status() 报已连接、ensure() 以为还活着，下一次操作要卡到取命令超时。
func (b *browserBridge) forget(client string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.clients, client)
	delete(b.queues, client)
	if b.primaryID == client {
		b.primaryID = ""
	}
}

// The caller holds b.mu for status and queue selection.
func (b *browserBridge) status() map[string]any {
	live := b.liveLocked()
	// 无头模式只认客户端自己拉起的那个实例（clientID），有头模式只认用户自己的浏览器；
	// 无头实例的 UA 同样是 Chrome，必须显式区分。
	headless := b.headlessClientLocked(live)
	headlessMode := headlessBrowser.Load() != nil
	// 无头模式只认本次启动的那个实例；有头模式只用你自己连上来的 Chrome（我们自己拉起的无头实例一律排除）。
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
	// A turn stays bound to its acquired browser even when another profile connects.
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
	return map[string]any{"connected": connected, "browser": peer.browser, "headless": client != "" && client == headless, "browsers": browsers, "mode": mode, "notice": notice, "origin": fmt.Sprintf("http://127.0.0.1:%d", b.port), "extensionId": strings.TrimPrefix(extensionOrigin, "chrome-extension://"), "extensionVersion": extensionVersion}
}

// ensureHeadless 无头模式下先保证浏览器起来了，再去碰桥接（启动可能要十几秒，不能拿着 b.mu）。
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
	// 第一次命令前就把你自己 Chrome 里的登录态搬过来，不让首屏落在空 profile 上；
	// 内部有节流，也不会打扰正在用的页签。
	b.borrowLogin(h)
	return nil
}

// leased 有会话正占着浏览器（这一回合还没结束）。
func (b *browserBridge) leased() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connection != nil
}

// leasedByOther 本会话有没有被另一个会话的浏览器租约挡住（挡住就不用白拉起一个浏览器）。
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

// internal 是客户端自己发的命令（借登录态）：不占会话租约，也不改 primary，
// 只借扩展的队列跑一条命令。超了或扩展没取走就当成没执行，不重放。
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
	command := &browserCommand{ID: id, Operation: operation, Args: payload, client: client, generation: b.generation, internal: true,
		reply: make(chan browserReply, 1), budget: timeout, pickupBy: time.Now().Add(pickup), picked: make(chan struct{})}
	b.pending[id] = command
	queue := b.queue(client)
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
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
	b.mu.Unlock()
	if req.Operation != "release" && req.Operation != "status" && !b.leasedByOther(connection, req.Session) {
		// 无头模式下这一步才真正拉起隐藏 Chrome；起不来就直接报错，不静默改用别的浏览器。
		if err := b.ensureHeadless(ctx); err != nil {
			return map[string]any{"status": "unavailable", "error": err.Error()}
		}
	}
	b.mu.Lock()
	if req.Operation == "release" {
		released := b.connection == connection && b.session == req.Session
		if released {
			b.generation++
			b.connection, b.session, b.leaseClient = nil, "", ""
		}
		b.mu.Unlock()
		if released {
			// 一轮操作结束：无头浏览器里刚登录的站点马上同步回你自己的 Chrome。
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
			return map[string]any{"status": "unavailable", "error": "本地 Chrome 扩展未取走命令（Vega 扩展后台可能被 Chrome 挂起或已断开），本步未执行，可以直接重试；持续出现请在 chrome://extensions 确认 Vega Chrome 已启用"}
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
		peer := b.clients[body.ClientID]
		peer.lastAt, peer.browser = time.Now(), browser
		// 无头判据只有一个：本次启动写进扩展副本的 clientID。标记只升不降：一旦认出是我们自己拉起的实例，
		// 切回「我自己的 Chrome」后它也不会被当成你的浏览器；用户的 Chrome 永远匹配不上这个 UUID。
		// 只有还没记下 clientID 的旧实例才看扩展自报的 UA（--headless=new 的 UA 并不保证带标记）。
		id := headlessClientID()
		peer.headless = peer.headless || body.ClientID == id || id == "" && strings.Contains(ua, "HeadlessChrome")
		b.clients[body.ClientID] = peer
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
