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
func TestShellCommandPolicy(t *testing.T) {
	data, err := os.ReadFile("testdata/shell-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		Blocked []string `json:"blocked"`
		Allowed []string `json:"allowed"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Blocked) == 0 || len(cases.Allowed) == 0 {
		t.Fatal("command policy fixtures must cover both outcomes")
	}
	for _, command := range cases.Blocked {
		if got := commandPolicyError(command); got != shellPolicyError {
			t.Errorf("automation command accepted: %q", command)
		}
	}
	for _, command := range cases.Allowed {
		if got := commandPolicyError(command); got != "" {
			t.Errorf("ordinary command rejected: %q: %s", command, got)
		}
	}
	ctx := context.Background()
	cwd := t.TempDir()
	blocked := execReq{Cwd: cwd, Command: "throw 'must not execute'; [Native]::SetCursorPos(10, 20)", Timeout: 10}
	if result := runCommand(ctx, blocked); result["error"] != shellPolicyError {
		t.Fatalf("runCommand did not reject before process creation: %v", result)
	}
	args, err := json.Marshal(blocked)
	if err != nil {
		t.Fatal(err)
	}
	if result := execute(ctx, job{Op: "exec", Args: args}); result["error"] != shellPolicyError {
		t.Fatalf("exec dispatch bypassed command policy: %v", result)
	}
	command := "printf ok"
	if runtime.GOOS == "windows" {
		command = "Write-Output 'ok'"
	}
	result := runCommand(ctx, execReq{Cwd: cwd, Command: command, Timeout: 10})
	if result["exitCode"] != 0 || strings.TrimSpace(result["output"].(string)) != "ok" {
		t.Fatalf("ordinary shell command failed: %v", result)
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
	mux := http.NewServeMux()
	socket := newChannelServer(func(peer *channelPeer, r *http.Request) {
		message, ok := peer.poll()
		if !ok {
			return
		}
		var hello map[string]any
		if json.Unmarshal(message.raw, &hello) != nil || hello["type"] != "hello" {
			return
		}
		_ = peer.send(map[string]string{"type": "ready", "userId": "alice", "clientId": strings.Repeat("c", 32)})
		for {
			if _, ok := peer.poll(); !ok {
				return
			}
		}
	})
	mux.Handle("/api/local-agent/socket", socket)
	mux.HandleFunc("/api/local-agent/verify", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Ticket string `json:"ticket"`
		}
		if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body.Ticket != ticket || used {
			http.Error(w, "invalid", 401)
			return
		}
		used = true
		_ = json.NewEncoder(w).Encode(map[string]any{"userId": "alice", "instance": strings.Repeat("b", 32), "clientId": strings.Repeat("c", 32), "deviceToken": strings.Repeat("d", 43)})
	})
	website := httptest.NewServer(mux)
	defer website.Close()
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), pinnedOrigin: website.URL, config: Config{ClientID: strings.Repeat("c", 32), TrustedOrigins: []string{website.URL}}, connections: make(map[*Conn]struct{}), pendingOrigins: map[string]bool{"https://untrusted.test": true}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent.startConnections(ctx)
	server := httptest.NewServer(http.HandlerFunc(agent.serveWS))
	defer server.Close()
	login := map[string]string{"type": "auth", "ticket": ticket, "userId": "alice"}
	untrusted := dialPairing(t, server.URL, "https://untrusted.test", login)
	if status := readPairing(t, untrusted); status["code"] != "permission_required" {
		t.Fatalf("untrusted site did not receive permission-only status: %v", status)
	}
	untrusted.close()
	if len(agent.config.Servers) != 0 {
		t.Fatal("untrusted site was paired")
	}
	conn := dialPairing(t, server.URL, website.URL, login)
	defer conn.close()
	ready := readPairing(t, conn)
	if ready["userId"] != "alice" || ready["type"] != "paired" || ready["connected"] != true {
		t.Fatalf("pairing failed: %v", ready)
	}
	if ready["deviceToken"] != nil {
		t.Fatal("device credential leaked to the webpage")
	}
	agent.mu.Lock()
	count := len(agent.config.Servers)
	agent.mu.Unlock()
	if count != 1 {
		t.Fatal("paired credential not saved")
	}
	duplicate := dialPairing(t, server.URL, website.URL, login)
	defer duplicate.close()
	if status := readPairing(t, duplicate); status["code"] != "login_http" || status["httpStatus"] != float64(401) {
		t.Fatalf("used login ticket was accepted or failed silently: %v", status)
	}
}
func TestPermissionPageRefusesOtherSites(t *testing.T) {
	origin := "https://vega.example"
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), pinnedOrigin: origin, config: Config{TrustedOrigins: []string{origin}}, pendingOrigins: map[string]bool{}, connections: make(map[*Conn]struct{})}
	page := httptest.NewRecorder()
	agent.configure(page, httptest.NewRequest("GET", "http://"+localAddress+"/config/token", nil))
	if page.Code != 200 || page.Header().Get("Referrer-Policy") != "same-origin" {
		t.Fatalf("permission page must preserve same-origin form origins: %d %v", page.Code, page.Header())
	}
	if !strings.Contains(page.Body.String(), origin) {
		t.Fatal("page must name the site this package belongs to")
	}
	// 外站的表单（不管带什么 Origin）都不能新增授权。
	form := "origin=https%3A%2F%2Fevil.example"
	for _, formOrigin := range []string{"", "null", "https://evil.example", "http://" + localAddress} {
		request := httptest.NewRequest("POST", "http://"+localAddress+"/config/token", strings.NewReader(form))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", formOrigin)
		denied := httptest.NewRecorder()
		agent.configure(denied, request)
		if denied.Code == 303 || len(agent.config.TrustedOrigins) != 1 {
			t.Fatalf("foreign site approval accepted from origin %q", formOrigin)
		}
	}
	// 安装包自带的站点不能在这里撤销，否则客户端就永久失联了。
	request := httptest.NewRequest("POST", "http://"+localAddress+"/config/token", strings.NewReader("remove=https%3A%2F%2Fvega.example"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://"+localAddress)
	revoked := httptest.NewRecorder()
	agent.configure(revoked, request)
	if revoked.Code != 400 || len(agent.config.TrustedOrigins) != 1 || !agent.allowOrigin(origin) {
		t.Fatalf("pinned site must not be revocable: %d", revoked.Code)
	}
	if agent.allowOrigin("https://evil.example") {
		t.Fatal("client accepted a site that is not in its package")
	}
}

func TestClientIdentitySurvivesRestartsAndDataDirFollowsSite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	origin := "https://vega.example"
	if err := os.WriteFile(filepath.Join(dir, "instance.json"), []byte(`{"origin":"`+origin+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := newAgentAt(dir)
	if err != nil || len(first.config.ClientID) != 32 {
		t.Fatalf("missing stable client ID: %v", err)
	}
	if strings.HasPrefix(first.configToken, first.config.ClientID) {
		t.Fatal("public device identity must not expose the local permission token")
	}
	if !strings.HasSuffix(first.dataDir, filepath.Join("vega-local", "vega.example")) {
		t.Fatalf("data dir must be per site: %s", first.dataDir)
	}
	if saved, err := os.ReadFile(filepath.Join(first.dataDir, "instance.json")); err != nil || !strings.Contains(string(saved), origin) {
		t.Fatalf("site info not written to the data dir: %v", err)
	}
	second, err := newAgentAt(dir)
	if err != nil || first.config.ClientID != second.config.ClientID || second.dataDir != first.dataDir || !second.allowOrigin(origin) {
		t.Fatalf("restart changed identity, data dir or pinned site: %v", err)
	}
}

func TestMissingInstanceFileRefusesToStart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	if _, err := newAgentAt(dir); err == nil || !strings.Contains(err.Error(), "instance.json") {
		t.Fatalf("client without package site info must refuse to start: %v", err)
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
