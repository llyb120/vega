package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestExactEditsCRLFAndAtomicFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.txt")
	initial := "a\r\nb\r\nend\r\n"
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	result := editFile(path, []fileEdit{{OldText: "a\nb", NewText: "X"}})
	actual, _ := os.ReadFile(path)
	if result["error"] != nil || string(actual) != "X\r\nend\r\n" {
		t.Fatalf("result=%v, content=%q", result, actual)
	}
	before := string(actual)
	result = editFile(path, []fileEdit{{OldText: "X", NewText: "ok"}, {OldText: "missing", NewText: "no"}})
	actual, _ = os.ReadFile(path)
	if result["error"] == nil || string(actual) != before {
		t.Fatalf("invalid batch changed file: %v %q", result, actual)
	}
	if err := os.WriteFile(path, []byte("aaaa"), 0600); err != nil {
		t.Fatal(err)
	}
	if editFile(path, []fileEdit{{OldText: "aaa", NewText: "x"}})["error"] == nil {
		t.Fatal("overlapping duplicate matches accepted")
	}
}
func TestShellCancellationAndOutputLimit(t *testing.T) {
	command := "sleep 10"
	if runtime.GOOS == "windows" {
		command = "Start-Sleep -Seconds 10"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	result := runCommand(ctx, execReq{Cwd: t.TempDir(), Command: command, Timeout: 20})
	if time.Since(started) > 4*time.Second || result["error"] != "Cancelled/timeout" {
		t.Fatalf("command did not cancel promptly: %v", result)
	}
	out := &limitedOutput{}
	data := make([]byte, maxOutput+100)
	n, err := out.Write(data)
	if err != nil || n != len(data) || out.data.Len() != maxOutput || !out.truncated {
		t.Fatal("output limit not enforced")
	}
}
func TestWebSocketRequiresTrustedOriginAndOneTimeWebsiteLogin(t *testing.T) {
	ticket := strings.Repeat("a", 72)
	used := false
	website := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Ticket string `json:"ticket"`
		}
		if r.URL.Path != "/api/local-agent/verify" || r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body.Ticket != ticket || used {
			http.Error(w, "invalid", 401)
			return
		}
		used = true
		_ = json.NewEncoder(w).Encode(map[string]any{"userId": "alice", "instance": strings.Repeat("b", 32), "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
	}))
	defer website.Close()
	agent := &Agent{config: Config{TrustedOrigins: []string{website.URL}}, connections: make(map[*websocket.Conn]struct{}), pendingOrigins: map[string]bool{"https://untrusted.test": true}}
	server := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	defer server.Close()
	connect := func(origin string) (*websocket.Conn, error) {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{"Origin": []string{origin}})
		return conn, err
	}
	if conn, err := connect("https://untrusted.test"); err == nil {
		conn.Close()
		t.Fatal("untrusted website accepted")
	}
	conn, err := connect(website.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.WriteJSON(map[string]string{"type": "auth", "ticket": ticket})
	var ready map[string]any
	if err = conn.ReadJSON(&ready); err != nil || ready["userId"] != "alice" {
		t.Fatalf("login failed: %v %v", ready, err)
	}
	id := "01234567-0123-0123-0123-012345678901"
	_ = conn.WriteJSON(map[string]any{"id": id, "op": "file", "args": map[string]string{"op": "read", "cwd": t.TempDir(), "path": "missing"}})
	var result map[string]any
	if err = conn.ReadJSON(&result); err != nil || result["id"] != id {
		t.Fatalf("result not routed: %v %v", result, err)
	}
	duplicate, err := connect(website.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer duplicate.Close()
	_ = duplicate.WriteJSON(map[string]string{"type": "auth", "ticket": ticket})
	if duplicate.ReadJSON(&ready) == nil {
		t.Fatal("used login ticket was accepted")
	}
}
func TestPermissionPageRequiresLocalOrigin(t *testing.T) {
	origin := "https://vega.example"
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), pendingOrigins: map[string]bool{origin: true}, connections: make(map[*websocket.Conn]struct{})}
	page := httptest.NewRecorder()
	agent.configure(page, httptest.NewRequest("GET", "http://"+localAddress+"/config/token", nil))
	if page.Code != 200 || page.Header().Get("Referrer-Policy") != "same-origin" {
		t.Fatalf("permission page must preserve same-origin form origins: %d %v", page.Code, page.Header())
	}
	form := "origin=https%3A%2F%2Fvega.example"
	for _, origin := range []string{"", "null", "https://evil.example", "http://localhost:47673"} {
		request := httptest.NewRequest("POST", "http://"+localAddress+"/config/token", strings.NewReader(form))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", origin)
		denied := httptest.NewRecorder()
		agent.configure(denied, request)
		if denied.Code != 403 || len(agent.config.TrustedOrigins) != 0 {
			t.Fatalf("invalid approval origin accepted: %q", origin)
		}
	}
	request := httptest.NewRequest("POST", "http://"+localAddress+"/config/token", strings.NewReader(form))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://"+localAddress)
	allowed := httptest.NewRecorder()
	agent.configure(allowed, request)
	if allowed.Code != 303 || !agent.allowOrigin(origin) {
		t.Fatalf("explicit site approval failed: %d", allowed.Code)
	}
	saved, err := os.ReadFile(agent.configPath)
	if err != nil || !strings.Contains(string(saved), origin) {
		t.Fatalf("site permission not persisted: %v", err)
	}
}

func TestClientIdentitySurvivesRestartsAndPermissionMigration(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	configDir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(configDir, "vega-local", "trusted-sites.json")
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte(`{"trustedOrigins":["https://vega.example"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := newAgent()
	if err != nil || len(first.config.ClientID) != 32 {
		t.Fatalf("missing stable client ID: %v", err)
	}
	if strings.HasPrefix(first.configToken, first.config.ClientID) {
		t.Fatal("public device identity must not expose the local permission token")
	}
	second, err := newAgent()
	if err != nil || first.config.ClientID != second.config.ClientID || !second.allowOrigin("https://vega.example") {
		t.Fatalf("restart changed identity or trusted origins: %v", err)
	}
}

func TestOriginValidation(t *testing.T) {
	for _, origin := range []string{"", "file://", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x=1"} {
		if validOrigin(origin) {
			t.Fatalf("invalid origin accepted: %s", origin)
		}
	}
	if !validOrigin("https://vega.example") || !validOrigin("http://127.0.0.1:8080") {
		t.Fatal("valid origin refused")
	}
}
