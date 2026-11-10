package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type backendPeer struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (p *backendPeer) send(value any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conn.WriteJSON(value)
}
func receive[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("direct client did not respond")
		var zero T
		return zero
	}
}
func TestNativeClientContinuesAfterPairingPageClosesAndReconnectsAfterRestart(t *testing.T) {
	clientID, token := strings.Repeat("c", 32), strings.Repeat("t", 43)
	const supplement = "本机项目目录：D:\\code\\示例"
	accepted := make(chan *backendPeer, 4)
	results := make(chan map[string]any, 4)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/local-agent/verify" {
			var body map[string]string
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["clientId"] != clientID {
				http.Error(w, "invalid pair", 401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": clientID, "deviceToken": token})
			return
		}
		if r.URL.Path != "/api/local-agent/socket" || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Origin") != "" || r.URL.RawQuery != "" {
			http.Error(w, "not authorized", 403)
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello map[string]any
		if conn.ReadJSON(&hello) != nil || hello["type"] != "hello" || hello["clientId"] != clientID || hello["version"] != clientVersion || hello["autoUpdate"] != true || hello["supplement"] != supplement {
			return
		}
		peer := &backendPeer{conn: conn}
		_ = peer.send(map[string]string{"type": "ready", "userId": "alice", "clientId": clientID})
		accepted <- peer
		for {
			var value map[string]any
			if conn.ReadJSON(&value) != nil {
				return
			}
			if value["type"] == "ping" {
				_ = peer.send(map[string]string{"type": "pong"})
			} else {
				results <- value
			}
		}
	}))
	defer backend.Close()
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	agent := &Agent{configPath: path, pinnedOrigin: backend.URL, config: Config{ClientID: clientID, Supplement: supplement, TrustedOrigins: []string{backend.URL}}, connections: make(map[*websocket.Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent.startConnections(ctx)
	pairing := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	defer pairing.Close()
	browser, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(pairing.URL, "http"), http.Header{"Origin": {backend.URL}})
	if err != nil {
		t.Fatal(err)
	}
	_ = browser.WriteJSON(map[string]string{"type": "auth", "ticket": strings.Repeat("a", 72), "userId": "alice"})
	paired := readPairing(t, browser)
	if paired["type"] != "paired" || paired["connected"] != true || paired["deviceToken"] != nil {
		t.Fatalf("unsafe pairing response: %v", paired)
	}
	_ = browser.Close()
	pairing.Close() // There is now no frontend or loopback connection at all.
	peer := receive(t, accepted)
	dir := t.TempDir()
	id := "01234567-0123-0123-0123-012345678901"
	if err = peer.send(map[string]any{"id": id, "op": "file", "args": map[string]string{"op": "write", "cwd": dir, "path": "direct.txt", "content": "bmF0aXZl"}}); err != nil {
		t.Fatal(err)
	}
	result := receive(t, results)
	if result["type"] != "result" || result["id"] != id {
		t.Fatalf("bad direct result: %v", result)
	}
	data, err := os.ReadFile(filepath.Join(dir, "direct.txt"))
	if err != nil || string(data) != "native" {
		t.Fatalf("native work did not finish after page closed: %q %v", data, err)
	}
	cancel()
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" && strings.Contains(string(stored), token) {
		t.Fatal("Windows device token was not protected")
	}
	var config Config
	if err = json.Unmarshal(stored, &config); err != nil {
		t.Fatal(err)
	}
	restarted := &Agent{configPath: path, config: config, connections: make(map[*websocket.Conn]struct{})}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	restarted.startConnections(ctx)
	peer = receive(t, accepted)
	_ = peer.send(map[string]any{"id": id, "op": "file", "args": map[string]string{"op": "read", "cwd": dir, "path": "direct.txt"}})
	if receive(t, results)["type"] != "result" {
		t.Fatal("saved credential did not reconnect without a webpage")
	}
	form := url.Values{"remove": {backend.URL}}
	request := httptest.NewRequest("POST", "http://"+localAddress+"/config/token", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://"+localAddress)
	response := httptest.NewRecorder()
	restarted.configure(response, request)
	if response.Code != 303 || len(restarted.config.Servers) != 0 {
		t.Fatalf("revoking site must forget and stop its direct connection: %d", response.Code)
	}
}
func TestPersistentCredentialOriginsAcceptHTTPAndHTTPSWithoutWeakeningValidation(t *testing.T) {
	for _, origin := range []string{"ftp://vega.example", "https://user:pass@vega.example", "https://vega.example/path", "http://vega.example?token=secret", "null", ""} {
		if validOrigin(origin) {
			t.Fatal("invalid origin accepted: " + origin)
		}
	}
	for _, origin := range []string{"http://vega.example", "http://192.168.1.10:8080", "https://vega.example", "http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost:3000"} {
		if !validOrigin(origin) {
			t.Fatal("HTTP(S) origin refused: " + origin)
		}
	}
}

// 本机客户端只服务当前登录的账户：换号前配对过的账户不能继续留着、连上。
func TestPairingKeepsOnlyTheCurrentAccount(t *testing.T) {
	const origin = "https://vega.example"
	protected, err := protectToken(strings.Repeat("s", 43))
	if err != nil {
		t.Skipf("token protection unavailable on this platform: %v", err)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	agent := &Agent{configPath: path, pinnedOrigin: origin, config: Config{ClientID: strings.Repeat("c", 32), TrustedOrigins: []string{origin},
		Servers: []ServerCredential{{Origin: origin, UserID: "old", Token: protected, Relay: []string{"git.internal:443"}}}}, direct: make(map[string]*directConnection)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	old := origin + "\x00old"
	agent.direct[old] = &directConnection{origin: origin, cancel: cancel, status: connectionStatus{Code: "connected"}}
	saved, err := agent.saveCredential(origin, loginProof{UserID: "alice", DeviceToken: strings.Repeat("s", 43)})
	if err != nil || saved.UserID != "alice" || len(saved.Relay) != 0 {
		t.Fatalf("pairing did not take the current account: %+v %v", saved, err)
	}
	if len(agent.config.Servers) != 1 || agent.config.Servers[0].UserID != "alice" || agent.direct[old] != nil || ctx.Err() == nil {
		t.Fatal("an account paired before this login is still stored or connected")
	}
	data, err := os.ReadFile(path)
	var stored Config
	if err != nil || json.Unmarshal(data, &stored) != nil || len(stored.Servers) != 1 || stored.Servers[0].UserID != "alice" {
		t.Fatal("previous account still on disk")
	}
}

func TestCurrentAccountsDropsEarlierPairings(t *testing.T) {
	const origin = "https://vega.example"
	kept := currentAccounts([]ServerCredential{{Origin: origin, UserID: "first"}, {Origin: "https://other.example", UserID: "first"}, {Origin: origin, UserID: "second"}}, origin)
	if len(kept) != 1 || kept[0].UserID != "second" {
		t.Fatalf("wrong account kept: %+v", kept)
	}
}
