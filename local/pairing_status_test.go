package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func readPairing(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 8; i++ {
		var value map[string]any
		if err := conn.ReadJSON(&value); err != nil {
			t.Fatal(err)
		}
		if value["code"] == "authorizing" || value["code"] == "backend_connecting" {
			continue
		}
		return value
	}
	t.Fatal("too many progress messages")
	return nil
}
func pairForTest(t *testing.T, origin, configPath string) (*Agent, *websocket.Conn) {
	t.Helper()
	agent := &Agent{configPath: configPath, config: Config{ClientID: strings.Repeat("c", 32), TrustedOrigins: []string{origin}}, connections: make(map[*websocket.Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	agent.startConnections(ctx)
	server := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	t.Cleanup(func() { cancel(); server.Close() })
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{"Origin": {origin}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err = conn.WriteJSON(map[string]string{"type": "auth", "ticket": strings.Repeat("a", 72), "userId": "alice"}); err != nil {
		t.Fatal(err)
	}
	return agent, conn
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
func TestPairingDoesNotClaimConnectedBeforeNativeReady(t *testing.T) {
	hello := make(chan struct{}, 1)
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/local-agent/verify" {
			_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("s", 43)})
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var value map[string]any
		if conn.ReadJSON(&value) != nil {
			return
		}
		hello <- struct{}{}
		<-release
		_ = conn.WriteJSON(map[string]string{"type": "ready", "userId": "alice", "clientId": strings.Repeat("c", 32)})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
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
func TestApprovingSiteContinuesToBackendAndReportsFailure(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/local-agent/verify" {
			_ = json.NewEncoder(w).Encode(map[string]string{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("s", 43)})
			return
		}
		http.NotFound(w, r)
	}))
	defer backend.Close()
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "config.json"), config: Config{ClientID: strings.Repeat("c", 32)}, pendingOrigins: map[string]bool{backend.URL: true}, connections: make(map[*websocket.Conn]struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent.startConnections(ctx)
	server := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	defer server.Close()
	connect := func() *websocket.Conn {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{"Origin": {backend.URL}})
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.WriteJSON(map[string]string{"type": "auth", "ticket": strings.Repeat("a", 72), "userId": "alice"})
		return conn
	}
	first := connect()
	if status := readPairing(t, first); status["code"] != "permission_required" {
		t.Fatalf("missing permission prompt: %v", status)
	}
	_ = first.Close()
	request := httptest.NewRequest("POST", "http://"+localAddress+"/config/token", strings.NewReader(url.Values{"origin": {backend.URL}}.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://"+localAddress)
	response := httptest.NewRecorder()
	agent.configure(response, request)
	if response.Code != 303 {
		t.Fatalf("approval not saved: %d", response.Code)
	}
	retry := connect()
	defer retry.Close()
	if status := readPairing(t, retry); status["code"] != "backend_http" || status["httpStatus"] != float64(404) {
		t.Fatalf("approved site failed silently or claimed success: %v", status)
	}
}

func TestRemoteHTTPReportsHTTPSRequirementWithoutSavingOrVerifying(t *testing.T) {
	agent, conn := pairForTest(t, "http://vega.example", filepath.Join(t.TempDir(), "config.json"))
	if status := readPairing(t, conn); status["code"] != "insecure_origin" {
		t.Fatalf("missing HTTPS requirement: %v", status)
	}
	if len(agent.config.Servers) != 0 {
		t.Fatal("insecure credential stored")
	}
}
