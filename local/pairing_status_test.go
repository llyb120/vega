package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readPairing(t *testing.T, client *pairingClient) map[string]any {
	t.Helper()
	for i := 0; i < 8; i++ {
		value := client.next(t)
		if value["code"] == "authorizing" || value["code"] == "backend_connecting" {
			continue
		}
		return value
	}
	t.Fatal("too many progress messages")
	return nil
}
func pairForTest(t *testing.T, origin, configPath string) (*Agent, *pairingClient) {
	t.Helper()
	agent := &Agent{configPath: configPath, pinnedOrigin: origin, config: Config{ClientID: strings.Repeat("c", 32), TrustedOrigins: []string{origin}}, connections: make(map[*Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	agent.startConnections(ctx)
	server := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	t.Cleanup(func() { cancel(); server.Close() })
	client := dialPairing(t, server.URL, origin, map[string]string{"type": "auth", "ticket": strings.Repeat("a", 72), "userId": "alice"})
	t.Cleanup(client.close)
	return agent, client
}
func TestPairingReportsSanitizedLoginAndBackendFailures(t *testing.T) {
	for _, item := range []struct {
		name, code     string
		verify, socket int
	}{
		{"expired login", "login_http", 401, 0},
		{"missing backend route", "backend_http", 200, 404},
		{"revoked backend credential", "backend_http", 200, 403},
		{"proxy does not upgrade", "backend_http", 200, 200},
		{"upstream unavailable", "backend_http", 200, 502},
	} {
		t.Run(item.name, func(t *testing.T) {
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/local-agent/verify" && item.verify == 200 {
					_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("s", 43)})
					return
				}
				status := item.socket
				if r.URL.Path == "/api/local-agent/verify" {
					status = item.verify
				}
				w.WriteHeader(status)
				_, _ = w.Write([]byte("private upstream response sssssssssssssssssssssssssssssssssssssssssss"))
			}))
			t.Cleanup(backend.Close)
			_, conn := pairForTest(t, backend.URL, filepath.Join(t.TempDir(), "config.json"))
			status := readPairing(t, conn)
			if status["type"] != "status" || status["code"] != item.code {
				t.Fatalf("wrong failure: %v", status)
			}
			expected := item.socket
			if item.verify != 200 {
				expected = item.verify
			}
			if status["httpStatus"] != float64(expected) {
				t.Fatalf("missing HTTP status: %v", status)
			}
			data, _ := json.Marshal(status)
			if strings.Contains(string(data), "private") || strings.Contains(string(data), strings.Repeat("s", 43)) {
				t.Fatal("upstream content or credential leaked")
			}
		})
	}
}
func TestRevokedCredentialIsDroppedSoSiteCanPairAgain(t *testing.T) {
	clientID, token := strings.Repeat("c", 32), strings.Repeat("s", 43)
	protected, err := protectToken(token)
	if err != nil {
		t.Skipf("token protection unavailable on this platform: %v", err)
	}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/local-agent/socket" {
			http.Error(w, "revoked", http.StatusForbidden)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(backend.Close)
	path := filepath.Join(t.TempDir(), "config.json")
	agent := &Agent{configPath: path, pinnedOrigin: backend.URL, config: Config{ClientID: clientID, TrustedOrigins: []string{backend.URL}, Servers: []ServerCredential{{Origin: backend.URL, UserID: "alice", Token: protected}}}, connections: make(map[*Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent.startConnections(ctx)
	// 等后端先回一次 403，removeCredential 才有机会跑；轮询而不是睡固定时间。
	for i := 0; i < 100; i++ {
		agent.mu.Lock()
		servers := len(agent.config.Servers)
		agent.mu.Unlock()
		if servers == 0 {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("config not rewritten: %v", err)
			}
			var stored Config
			if json.Unmarshal(data, &stored) != nil || len(stored.Servers) != 0 {
				t.Fatalf("revoked credential still on disk: %s", data)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("revoked credential kept in config after backend_http 403")
}

func TestPairingDoesNotClaimConnectedBeforeNativeReady(t *testing.T) {
	hello := make(chan struct{}, 1)
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/local-agent/verify", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("s", 43)})
	})
	mux.Handle("/api/local-agent/socket", newChannelServer(func(peer *channelPeer, r *http.Request) {
		if _, ok := peer.poll(); !ok {
			return
		}
		hello <- struct{}{}
		<-release
		_ = peer.send(map[string]string{"type": "ready", "userId": "alice", "clientId": strings.Repeat("c", 32)})
		for {
			if _, ok := peer.poll(); !ok {
				return
			}
		}
	}))
	backend := httptest.NewServer(mux)
	t.Cleanup(backend.Close)
	_, conn := pairForTest(t, backend.URL, filepath.Join(t.TempDir(), "config.json"))
	receive(t, hello)
	results := make(chan map[string]any, 1)
	go func() { results <- readPairing(t, conn) }()
	select {
	case status := <-results:
		t.Fatalf("claimed a result before native ready: %v", status)
	case <-time.After(80 * time.Millisecond):
	}
	close(release)
	status := receive(t, results)
	if status["type"] != "paired" || status["connected"] != true || status["deviceToken"] != nil {
		t.Fatalf("invalid result: %v", status)
	}
}
func TestPairingReportsCredentialSaveFailureAndAccountMismatch(t *testing.T) {
	for _, account := range []string{"alice", "other-user"} {
		t.Run(account, func(t *testing.T) {
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]string{"userId": account, "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("s", 43)})
			}))
			t.Cleanup(backend.Close)
			agent, conn := pairForTest(t, backend.URL, t.TempDir())
			status := readPairing(t, conn)
			code := "credential_save"
			if account != "alice" {
				code = "login_invalid"
			}
			if status["code"] != code || len(agent.config.Servers) != 0 {
				t.Fatalf("unsafe failure: %v", status)
			}
		})
	}
}
func TestPinnedSiteContinuesToBackendAndForeignSiteIsRefused(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/local-agent/verify" {
			_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("s", 43)})
			return
		}
		http.NotFound(w, r)
	}))
	defer backend.Close()
	// 安装包自带的站点直接放行，不需要再点“允许”；其它站点直接拒。
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "config.json"), pinnedOrigin: backend.URL, config: Config{ClientID: strings.Repeat("c", 32), TrustedOrigins: []string{backend.URL}}, pendingOrigins: map[string]bool{}, connections: make(map[*Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent.startConnections(ctx)
	server := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	defer server.Close()
	login := map[string]string{"type": "auth", "ticket": strings.Repeat("a", 72), "userId": "alice"}
	foreign := dialPairing(t, server.URL, "https://evil.example", login)
	defer foreign.close()
	if status := readPairing(t, foreign); status["code"] != "permission_required" {
		t.Fatalf("foreign site was not refused: %v", status)
	}
	// 后端登录接口之后回 404，应该如实报 backend_http，而不是声称已连接。
	pinned := dialPairing(t, server.URL, backend.URL, login)
	defer pinned.close()
	if status := readPairing(t, pinned); status["code"] != "backend_http" || status["httpStatus"] != float64(404) {
		t.Fatalf("pinned site failed silently or claimed success: %v", status)
	}
}

func TestRemoteHTTPPairsAndReconnectsWithSavedCredential(t *testing.T) {
	const origin = "http://vega.example"
	clientID, token := strings.Repeat("c", 32), strings.Repeat("s", 43)
	accepted := make(chan struct{}, 2)
	socket := newChannelServer(func(peer *channelPeer, r *http.Request) {
		message, ok := peer.poll()
		if !ok {
			return
		}
		var hello map[string]any
		if json.Unmarshal(message.raw, &hello) != nil || hello["clientId"] != clientID {
			return
		}
		_ = peer.send(map[string]string{"type": "ready", "userId": "alice", "clientId": clientID})
		accepted <- struct{}{}
		for {
			if _, ok := peer.poll(); !ok {
				return
			}
		}
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/local-agent/verify", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "vega.example" || r.TLS != nil {
			http.Error(w, "unexpected origin or TLS", 400)
			return
		}
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["clientId"] != clientID {
			http.Error(w, "invalid pair", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": clientID, "deviceToken": token})
	})
	mux.HandleFunc("/api/local-agent/socket", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "vega.example" || r.TLS != nil || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Origin") != "" || r.URL.RawQuery != "" {
			http.Error(w, "not authorized", 403)
			return
		}
		socket.ServeHTTP(w, r)
	})
	backend := httptest.NewServer(mux)
	defer backend.Close()
	// Route the non-loopback hostname to a local fixture without relying on DNS.
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "vega.example:80" {
			address = backend.Listener.Addr().String()
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	previousHTTP := http.DefaultTransport
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy, transport.DialContext = nil, dial
	http.DefaultTransport = transport
	defer func() {
		http.DefaultTransport = previousHTTP
		transport.CloseIdleConnections()
	}()
	path := filepath.Join(t.TempDir(), "config.json")
	agent := &Agent{configPath: path, pinnedOrigin: origin, config: Config{ClientID: clientID, TrustedOrigins: []string{origin}}, connections: make(map[*Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent.startConnections(ctx)
	pairing := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	defer pairing.Close()
	browser := dialPairing(t, pairing.URL, origin, map[string]string{"type": "auth", "ticket": strings.Repeat("a", 72), "userId": "alice"})
	if status := readPairing(t, browser); status["type"] != "paired" || status["connected"] != true {
		t.Fatalf("remote HTTP pairing failed: %v", status)
	}
	receive(t, accepted)
	browser.close()
	pairing.Close()
	agent.mu.Lock()
	config := agent.config
	agent.mu.Unlock()
	if len(config.Servers) != 1 || config.Servers[0].Origin != origin {
		t.Fatal("remote HTTP device credential not saved")
	}
	cancel()
	waitStopped := func(a *Agent) {
		t.Helper()
		for i := 0; i < 100; i++ {
			a.mu.Lock()
			count := len(a.direct)
			a.mu.Unlock()
			if count == 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("native connection did not stop")
	}
	waitStopped(agent)
	restarted := &Agent{configPath: path, config: config, connections: make(map[*Conn]struct{})}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	restarted.startConnections(ctx)
	receive(t, accepted)
	stop()
	waitStopped(restarted)
}
