package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const reconnectGrace = 60 * time.Second

type ServerCredential struct {
	Origin  string   `json:"origin"`
	UserID  string   `json:"userId"`
	Token   string   `json:"token"`
	Relay   []string `json:"relay,omitempty"`
	RelayOn *bool    `json:"relayOn,omitempty"` // nil = legacy: on when Relay is non-empty
}

// activeRelay returns the rules that should be advertised and used right now.
func (s ServerCredential) activeRelay() []string {
	if s.RelayOn != nil && !*s.RelayOn {
		return nil
	}
	return append([]string{}, s.Relay...)
}

type connectionStatus struct {
	Code       string `json:"code"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	Message    string `json:"message,omitempty"`
}
type directConnection struct {
	origin     string
	token      string
	instance   string
	jobs       *jobRunner
	autoUpdate bool
	cancel     context.CancelFunc
	status     connectionStatus
	changed    chan struct{}
}

func (a *Agent) connectionStatus(connection *directConnection, status connectionStatus) {
	a.mu.Lock()
	previous := connection.status
	connection.status = status
	close(connection.changed)
	connection.changed = make(chan struct{})
	a.mu.Unlock()
	// 连不上时日志里必须留下后端回的原话，不然只能看到“未连接”。
	if previous.Code != status.Code || previous.Message != status.Message {
		detail := status.Code
		if status.HTTPStatus != 0 {
			detail += fmt.Sprintf(" HTTP %d", status.HTTPStatus)
		}
		if status.Message != "" {
			detail += "：" + status.Message
		}
		a.clientLog("后端 %s %s", connection.origin, detail)
	}
}

func (a *Agent) saveCredential(origin string, proof loginProof) (ServerCredential, error) {
	if origin != a.pinnedOrigin {
		return ServerCredential{}, fmt.Errorf("此客户端属于 %s，不能保存 %s 的凭据", a.pinnedOrigin, origin)
	}
	protected, err := protectToken(proof.DeviceToken)
	if err != nil {
		return ServerCredential{}, err
	}
	saved := ServerCredential{Origin: origin, UserID: proof.UserID, Token: protected}
	a.mu.Lock()
	defer a.mu.Unlock()
	next := a.config
	next.Servers = nil
	for _, item := range a.config.Servers {
		if item.Origin != origin || item.UserID != proof.UserID {
			next.Servers = append(next.Servers, item)
		} else {
			saved.Relay = item.Relay
			saved.RelayOn = item.RelayOn
		}
	}
	if len(next.Servers) >= 8 {
		return saved, fmt.Errorf("Too many paired accounts")
	}
	next.Servers = append(next.Servers, saved)
	if err = a.saveConfig(next); err != nil {
		return saved, err
	}
	a.config = next
	return saved, nil
}

// removeCredential 删掉一个已被后端拒绝的配对凭据；TrustedOrigins 不变，网页可再次配对。
func (a *Agent) removeCredential(origin, userID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	next := a.config
	next.Servers = nil
	for _, item := range a.config.Servers {
		if item.Origin != origin || item.UserID != userID {
			next.Servers = append(next.Servers, item)
		}
	}
	if len(next.Servers) == len(a.config.Servers) {
		return
	}
	if err := a.saveConfig(next); err == nil {
		a.config = next
		a.clientLog("已移除被后端拒绝的配对凭据 %s %s", origin, userID)
	}
}

func (a *Agent) startConnections(ctx context.Context) {
	a.mu.Lock()
	a.context = ctx
	_ = json.Unmarshal([]byte(os.Getenv("VEGA_LOCAL_RESUME")), &a.resumeInstances)
	_ = os.Unsetenv("VEGA_LOCAL_RESUME")
	servers := append([]ServerCredential{}, a.config.Servers...)
	a.mu.Unlock()
	for _, saved := range servers {
		if token, err := unprotectToken(saved.Token); err == nil {
			a.startConnection(saved, token)
		}
	}
}
func (a *Agent) startConnection(saved ServerCredential, token string) *directConnection {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.updating || a.config.Offline || !validOrigin(saved.Origin) {
		return nil
	}
	trusted := false
	for _, origin := range a.config.TrustedOrigins {
		trusted = trusted || origin == saved.Origin
	}
	if !trusted {
		return nil
	}
	if a.direct == nil {
		a.direct = make(map[string]*directConnection)
	}
	key := saved.Origin + "\x00" + saved.UserID
	if old := a.direct[key]; old != nil {
		if old.token == token {
			return old
		}
		old.cancel()
	}
	parent := a.context
	if parent == nil {
		parent = context.Background()
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil
	}
	instance := hex.EncodeToString(id)
	if resumed := a.resumeInstances[key]; len(resumed) == 32 {
		if _, err := hex.DecodeString(resumed); err == nil {
			instance = resumed
		}
	}
	delete(a.resumeInstances, key)
	ctx, cancel := context.WithCancel(parent)
	connection := &directConnection{origin: saved.Origin, token: token, instance: instance, jobs: newJobRunner(ctx, true), cancel: cancel, status: connectionStatus{Code: "backend_connecting"}, changed: make(chan struct{})}
	connection.jobs.supplement = a.config.Supplement
	connection.jobs.browser = browserPlace(a.config.Browser)
	connection.jobs.prefer = executionPlace(a.config.Prefer)
	a.configureRelay(connection, saved, ctx)
	a.direct[key] = connection
	go func() {
		defer func() { cancel(); connection.jobs.close() }()
		defer func() {
			a.mu.Lock()
			if a.direct[key] == connection {
				delete(a.direct, key)
			}
			a.mu.Unlock()
		}()
		delay := time.Second
		for ctx.Err() == nil {
			retry, connected := a.connectBackend(ctx, saved, connection)
			if !retry {
				return // Revoked credentials need a new explicit website handshake.
			}
			if connected {
				delay = time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if delay < 30*time.Second {
				delay *= 2
				if delay > 30*time.Second {
					delay = 30 * time.Second
				}
			}
		}
	}()
	return connection
}
func (a *Agent) connectBackend(ctx context.Context, saved ServerCredential, connection *directConnection) (bool, bool) {
	a.mu.Lock()
	updating := a.updating
	a.mu.Unlock()
	if updating {
		return true, false
	}
	u, _ := url.Parse(saved.Origin + "/api/local-agent/socket")
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 8 * time.Second
	conn, response, err := dialer.DialContext(ctx, u.String(), http.Header{"Authorization": {"Bearer " + connection.token}})
	if err != nil {
		status := connectionStatus{Code: "backend_network"}
		if response != nil {
			_ = response.Body.Close()
			status = connectionStatus{Code: "backend_http", HTTPStatus: response.StatusCode}
		} else {
			var certificateError *tls.CertificateVerificationError
			if errors.As(err, &certificateError) {
				status.Code = "backend_tls"
			}
		}
		a.connectionStatus(connection, status)
		if response != nil && (response.StatusCode == 401 || response.StatusCode == 403) {
			// deviceToken 已被服务端撤销：留着它只会每次启动都撞同一个 403，清掉让网页的下一次配对写入新凭据。
			a.removeCredential(saved.Origin, saved.UserID)
		}
		return response == nil || (response.StatusCode != 401 && response.StatusCode != 403), false
	}
	defer conn.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()
	cwd, err := os.Getwd()
	if err != nil {
		a.connectionStatus(connection, connectionStatus{Code: "backend_cwd"})
		return true, false
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "牵牛星 " + runtime.GOOS
	}
	a.mu.Lock()
	clientID, supplement := a.config.ClientID, a.config.Supplement
	browser := browserPlace(a.config.Browser)
	a.mu.Unlock()
	connection.jobs.mu.Lock()
	rules := append([]string{}, connection.jobs.relayRules...)
	connection.jobs.mu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if conn.WriteJSON(map[string]any{"type": "hello", "instance": connection.instance, "clientId": clientID, "supplement": supplement, "browser": browser, "prefer": executionPlace(connection.jobs.prefer), "relay": rules, "name": name, "cwd": cwd, "platform": runtime.GOOS, "arch": runtime.GOARCH, "version": clientVersion, "autoUpdate": true, "resume": true}) != nil {
		a.connectionStatus(connection, connectionStatus{Code: "backend_network"})
		return true, false
	}
	conn.SetReadLimit(maxBody)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var ready struct {
		Type, UserID, ClientID, Code, Message string
		Resume, AutoUpdate, SessionIdle, Busy bool
		Pending, Leases                       []string
	}
	if conn.ReadJSON(&ready) != nil {
		a.connectionStatus(connection, connectionStatus{Code: "backend_protocol"})
		return true, false
	}
	// The node refuses clients older than its minimum version; show its reason instead of a bare protocol error.
	if ready.Type == "error" {
		code := ready.Code
		if code == "" {
			code = "backend_protocol"
		}
		a.connectionStatus(connection, connectionStatus{Code: code, Message: ready.Message})
		return true, false
	}
	if ready.Type != "ready" || ready.UserID != saved.UserID || ready.ClientID != clientID {
		a.connectionStatus(connection, connectionStatus{Code: "backend_protocol"})
		return true, false
	}
	a.mu.Lock()
	a.connections[conn] = struct{}{}
	connection.autoUpdate = ready.AutoUpdate && ready.Resume && ready.SessionIdle
	setState(true)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.connections, conn)
		connection.autoUpdate = false
		setState(len(a.connections) > 0)
		a.mu.Unlock()
	}()
	connection.jobs.mu.Lock()
	connection.jobs.sessionBusy = ready.Busy
	connection.jobs.upload = resultUploader(saved.Origin, connection.token, connection.instance)
	connection.jobs.mu.Unlock()
	a.connectionStatus(connection, connectionStatus{Code: "connected"})
	if ready.Resume {
		connection.jobs.run(conn, ready.Pending, ready.Leases)
	} else {
		runJobs(ctx, conn)
	}
	a.connectionStatus(connection, connectionStatus{Code: "backend_disconnected"})
	return true, true
}

type localJob struct {
	cancel context.CancelFunc
	result []byte
}

// Results larger than this go over HTTP so a big file read never holds the socket (and its heartbeat) for seconds.
// Keep aligned with the server's CLIENT_SOCKET_LIMIT (1 MiB): viewport screenshots often land between
// 256 KiB and 1 MiB; forcing those through HTTP made "连接仍正常" browser timeouts common when the
// reverse proxy rejected the body or the uplink was slow, even though the WebSocket was fine.
const inlineResultLimit = 1 << 20

type jobRunner struct {
	running      int
	ctx          context.Context
	mu           sync.Mutex
	conn         *websocket.Conn
	tasks        map[string]*localJob
	resumable    bool
	sessionBusy  bool
	supplement   string
	browser      string
	prefer       string
	lastActivity time.Time
	updateReady  chan bool
	recovery     *time.Timer
	upload       func(context.Context, []byte) error
	relayRules   []string
	relay        func(context.Context, job)
	relayCancel  context.CancelFunc
}

func newJobRunner(ctx context.Context, resumable bool) *jobRunner {
	return &jobRunner{ctx: ctx, tasks: make(map[string]*localJob), resumable: resumable, lastActivity: time.Now()}
}
func runJobs(parent context.Context, conn *websocket.Conn) {
	ctx, cancel := context.WithCancel(parent)
	runner := newJobRunner(ctx, false)
	defer func() { cancel(); runner.close() }()
	runner.run(conn, nil, nil)
}
func (runner *jobRunner) close() {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.recovery != nil {
		runner.recovery.Stop()
	}
	for _, task := range runner.tasks {
		task.cancel()
	}
	localChrome.releaseConnection(runner.ctx)
	if runner.relayCancel != nil {
		runner.relayCancel()
	}
}
func (runner *jobRunner) suspend(conn *websocket.Conn) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.conn != conn {
		return
	}
	runner.conn = nil
	if runner.updateReady != nil {
		select {
		case runner.updateReady <- false:
		default:
		}
		runner.updateReady = nil
	}
	if runner.resumable {
		var timer *time.Timer
		timer = time.AfterFunc(reconnectGrace, func() {
			runner.mu.Lock()
			defer runner.mu.Unlock()
			if runner.recovery != timer || runner.conn != nil {
				return
			}
			for _, task := range runner.tasks {
				task.cancel()
			}
			localChrome.releaseConnection(runner.ctx)
		})
		runner.recovery = timer
	}
}
func (runner *jobRunner) write(value any) {
	data, err := json.Marshal(value)
	if err == nil {
		runner.writeRaw(data)
	}
}
func (runner *jobRunner) writeRaw(data []byte) {
	if runner.conn == nil {
		return
	}
	_ = runner.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if runner.conn.WriteMessage(websocket.TextMessage, data) != nil {
		_ = runner.conn.Close()
	}
}

// deliver sends a finished result; the caller holds runner.mu. Large results are posted outside the lock.
func (runner *jobRunner) deliver(id string, task *localJob) {
	if len(task.result) <= inlineResultLimit || runner.upload == nil {
		runner.writeRaw(task.result)
		return
	}
	upload, data := runner.upload, task.result
	go func() {
		err := upload(runner.ctx, data)
		runner.mu.Lock()
		defer runner.mu.Unlock()
		if runner.tasks[id] != task {
			return
		}
		if err != nil {
			// Upload failed while the control socket may still be healthy. Keeping the result only
			// for a future reconnect leaves the server waiting out the browser timeout with
			// "连接仍正常". Settle on the WebSocket when possible; payloads above the socket limit
			// must become a small error (rewriting the full body would close the connection).
			fmt.Fprintln(os.Stderr, "vega-local result upload failed:", err)
			if runner.conn == nil {
				return // retain for resume
			}
			payload := data
			if len(data) > inlineResultLimit {
				payload, _ = json.Marshal(map[string]any{
					"type": "result",
					"id":   id,
					"result": map[string]any{
						"error": "Large result upload failed (" + err.Error() + "); check reverse-proxy client_max_body_size (≥48m for /api/local-agent/result), Authorization forwarding, and that the client Origin matches the site URL (HTTP≠HTTPS redirect). Connection stayed up; do not replay until you inspect the page.",
					},
				})
			}
			runner.writeRaw(payload)
			if !runner.resumable {
				delete(runner.tasks, id)
			}
			return
		}
		delete(runner.tasks, id)
	}()
}
func (runner *jobRunner) run(conn *websocket.Conn, pending, leases []string) {
	runner.mu.Lock()
	if runner.recovery != nil {
		runner.recovery.Stop()
		runner.recovery = nil
	}
	runner.conn = conn
	if runner.resumable {
		localChrome.releaseConnection(runner.ctx, leases...)
		wanted := make(map[string]bool, len(pending))
		for _, id := range pending {
			wanted[id] = true
		}
		for id, task := range runner.tasks {
			if !wanted[id] {
				task.cancel()
				delete(runner.tasks, id)
			} else if task.result != nil {
				runner.deliver(id, task)
			}
		}
	}
	runner.mu.Unlock()
	defer runner.suspend(conn)
	ctx, cancel := context.WithCancel(runner.ctx)
	defer cancel()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runner.mu.Lock()
				if runner.conn == conn {
					message := map[string]any{"type": "ping", "supplement": runner.supplement, "prefer": executionPlace(runner.prefer)}
					if runner.browser != "" {
						message["browser"] = runner.browser
					}
					if runner.relay != nil {
						message["relay"] = runner.relayRules
					}
					runner.write(message)
				}
				runner.mu.Unlock()
			}
		}
	}()
	seen := map[string]bool{}
	for {
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		var request job
		if conn.ReadJSON(&request) != nil {
			return
		}
		if request.Type == "relay" {
			runner.mu.Lock()
			relay := runner.relay
			runner.mu.Unlock()
			if relay != nil {
				go relay(ctx, request)
			}
			continue
		}
		if request.Type == "pong" {
			runner.mu.Lock()
			runner.sessionBusy = request.Busy
			runner.mu.Unlock()
			continue
		}
		if request.Type == "update_ready" || request.Type == "update_busy" {
			runner.mu.Lock()
			if runner.updateReady != nil {
				select {
				case runner.updateReady <- request.Type == "update_ready":
				default:
				}
				if request.Type == "update_busy" {
					runner.sessionBusy = true
					runner.updateReady = nil
				}
			}
			runner.mu.Unlock()
			continue
		}
		if len(request.ID) != 36 {
			return
		}
		runner.mu.Lock()
		runner.lastActivity = time.Now()
		if request.Type == "ack" {
			if task := runner.tasks[request.ID]; task != nil && task.result != nil {
				delete(runner.tasks, request.ID)
			}
			runner.mu.Unlock()
			continue
		}
		if request.Op == "cancel" {
			if task := runner.tasks[request.ID]; task != nil {
				task.cancel()
			}
			runner.mu.Unlock()
			continue
		}
		if seen[request.ID] || runner.tasks[request.ID] != nil || len(runner.tasks) >= 16 || len(seen) >= 4096 {
			runner.mu.Unlock()
			return
		}
		seen[request.ID] = true
		taskCtx, stop := context.WithCancel(runner.ctx)
		task := &localJob{cancel: stop}
		runner.tasks[request.ID] = task
		runner.running++
		runner.mu.Unlock()
		go func(request job) {
			var result map[string]any
			if request.Op == "browser" {
				result = localChrome.execute(runner.ctx, taskCtx, request)
			} else {
				result = execute(taskCtx, request)
			}
			stop()
			runner.mu.Lock()
			defer runner.mu.Unlock()
			runner.running--
			runner.lastActivity = time.Now()
			if runner.tasks[request.ID] != task {
				return
			}
			// Keep only results, never inputs: reconnecting must not replay an operation.
			task.result, _ = json.Marshal(map[string]any{"type": "result", "id": request.ID, "result": result})
			runner.deliver(request.ID, task)
			if !runner.resumable {
				delete(runner.tasks, request.ID)
			}
		}(request)
	}
}

func resultUploader(origin, token, instance string) func(context.Context, []byte) error {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, data []byte) error {
		// At least 30s, plus time for a slow uplink (64 KB/s).
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second+time.Duration(len(data)/(64<<10))*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/api/local-agent/result", bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Vega-Instance", instance)
		response, err := client.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("result upload: HTTP %d", response.StatusCode)
		}
		return nil
	}
}
