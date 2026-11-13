package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const browserSession = "11111111-1111-4111-8111-111111111111"
const browserClient = "22222222-2222-4222-8222-222222222222"

func browserJob(operation, session string) job {
	args, _ := json.Marshal(map[string]any{"session": session, "operation": operation, "args": map[string]any{}})
	return job{ID: "33333333-3333-4333-8333-333333333333", Op: "browser", Args: args}
}
func connectedBrowser() *browserBridge {
	b := newBrowserBridge()
	b.clients[browserClient] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	return b
}
func TestBrowserLeaseIsGlobalAcrossSessionsAndServerConnections(t *testing.T) {
	b := connectedBrowser()
	first, cancel := context.WithCancel(context.Background())
	defer cancel()
	second, stop := context.WithCancel(context.Background())
	defer stop()
	call := func(connection context.Context, operation, session string) map[string]any {
		return b.execute(connection, connection, browserJob(operation, session))
	}
	if r := call(first, "acquire", browserSession); r["error"] != nil {
		t.Fatal(r)
	}
	if r := call(first, "acquire", browserSession); r["error"] != nil {
		t.Fatal("same session lost its lease", r)
	}
	if r := call(first, "acquire", browserClient); r["status"] != "busy" {
		t.Fatal("another session acquired browser", r)
	}
	if r := call(second, "acquire", browserSession); r["status"] != "busy" {
		t.Fatal("another server connection acquired browser", r)
	}
	call(second, "release", browserSession)
	if r := call(second, "acquire", browserSession); r["status"] != "busy" {
		t.Fatal("foreign release cleared lease", r)
	}
	call(first, "release", browserSession)
	if r := call(second, "acquire", browserSession); r["error"] != nil {
		t.Fatal(r)
	}
	stop()
	b.releaseConnection(second)
	if r := call(second, "acquire", browserSession); r["error"] == nil {
		t.Fatal("cancelled connection reclaimed lease")
	}
	if r := call(first, "acquire", browserClient); r["error"] != nil {
		t.Fatal("disconnect did not release lease", r)
	}
	delete(b.clients, browserClient)
	b.clients["44444444-4444-4444-8444-444444444444"] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	if r := call(first, "tabs", browserClient); r["status"] != "unavailable" {
		t.Fatal("lease silently switched browser profile", r)
	}
}
func TestBrowserLeaseReconcilesActiveSessionsAfterReconnect(t *testing.T) {
	b := connectedBrowser()
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	if result := b.execute(owner, owner, browserJob("acquire", browserSession)); result["error"] != nil {
		t.Fatal(result)
	}
	b.releaseConnection(owner, browserSession)
	if b.connection != owner || b.session != browserSession {
		t.Fatal("reconnect lost the active browser lease")
	}
	b.releaseConnection(owner, browserClient)
	if b.connection != nil || b.session != "" {
		t.Fatal("reconnect retained a finished browser turn")
	}
}
func TestBrowserBridgeAuthenticatedExtensionRoundtripAndCancellation(t *testing.T) {
	b := connectedBrowser()
	server := httptest.NewServer(b)
	defer server.Close()
	connection, cancel := context.WithCancel(context.Background())
	defer cancel()
	post := func(path, origin, token string, body any) (int, map[string]any) {
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", server.URL+path, bytes.NewReader(data))
		req.Header.Set("Origin", origin)
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		_ = json.NewDecoder(response.Body).Decode(&result)
		return response.StatusCode, result
	}
	if status, _ := post("/pair", "https://untrusted.test", "", nil); status != 403 {
		t.Fatal(status)
	}
	_, pair := post("/pair", extensionOrigin, "", nil)
	token := pair["token"].(string)
	if status, _ := post("/poll", extensionOrigin, "wrong", map[string]any{"clientId": browserClient}); status != 403 {
		t.Fatal(status)
	}
	if r := b.execute(connection, connection, browserJob("acquire", browserSession)); r["error"] != nil {
		t.Fatal(r)
	}
	result := make(chan map[string]any, 1)
	go func() { result <- b.execute(connection, connection, browserJob("tabs", browserSession)) }()
	status, poll := post("/poll", extensionOrigin, token, map[string]any{"clientId": browserClient})
	if status != 200 {
		t.Fatal(status, poll)
	}
	command := poll["command"].(map[string]any)
	if poll["version"] != extensionVersion || command["operation"] != "tabs" || command["id"] != browserJob("", "").ID {
		t.Fatal(command)
	}
	if remaining := time.Until(time.UnixMilli(int64(command["expiresAt"].(float64)))); remaining <= 0 || remaining > 3*time.Second {
		t.Fatal("ordinary command did not use Nova's 3-second budget", remaining)
	}
	_, _ = post("/reply", extensionOrigin, token, map[string]any{"clientId": browserSession, "id": command["id"], "result": map[string]any{"stolen": true}})
	select {
	case r := <-result:
		t.Fatal("foreign browser reply accepted", r)
	default:
	}
	_, _ = post("/reply", extensionOrigin, token, map[string]any{"clientId": browserClient, "id": command["id"], "result": map[string]any{"tabs": []any{}}})
	if r := <-result; r["error"] != nil || r["result"].(map[string]any)["tabs"] == nil {
		t.Fatal(r)
	}
	ctx, stop := context.WithCancel(connection)
	queue := b.queues[browserClient]
	go func() { result <- b.execute(connection, ctx, browserJob("tabs", browserSession)) }()
	queued := <-queue
	stop()
	if r := <-result; !strings.Contains(r["error"].(string), "not executed") {
		t.Fatal(r)
	}
	b.mu.Lock()
	_, pending := b.pending[queued.ID]
	b.mu.Unlock()
	if pending || len(queue) != 0 {
		t.Fatal("cancelled operation retained for replay")
	}
	previous := browserPickupWait
	browserPickupWait = 50 * time.Millisecond
	defer func() { browserPickupWait = previous }()
	go func() { result <- b.execute(connection, connection, browserJob("tabs", browserSession)) }()
	unpicked := <-queue
	r := <-result
	if r["status"] != "unavailable" || !strings.Contains(r["error"].(string), "未执行") {
		t.Fatal("unpicked command was not reported as safe to retry", r)
	}
	b.mu.Lock()
	_, pending = b.pending[unpicked.ID]
	b.mu.Unlock()
	if pending {
		t.Fatal("unpicked operation retained for late replay")
	}
}
func TestBrowserPrimaryMatchesNovaAndKeepsAnActiveLeasePinned(t *testing.T) {
	b := newBrowserBridge()
	b.clients[browserSession] = browserPeer{lastAt: time.Now(), browser: "Microsoft Edge"}
	if status := b.status(); status["browser"] != "Microsoft Edge" {
		t.Fatal(status)
	}
	b.clients[browserClient] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	if status := b.status(); status["browser"] != "Google Chrome" || len(status["browsers"].([]string)) != 2 {
		t.Fatal("Chrome did not become primary", status)
	}
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	if result := b.execute(owner, owner, browserJob("acquire", browserSession)); result["error"] != nil {
		t.Fatal(result)
	}
	other := "00000000-0000-4000-8000-000000000000"
	b.clients[other] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	b.status()
	if b.primaryID != browserClient || b.leaseClient != browserClient {
		t.Fatal("another Chrome profile changed the selected browser")
	}
	b.clients[browserClient] = browserPeer{lastAt: time.Now().Add(-46 * time.Second), browser: "Google Chrome"}
	if status := b.status(); status["connected"] != false {
		t.Fatal("expired lease silently switched profiles", status)
	}
	if _, exists := b.queues[browserClient]; exists {
		t.Fatal("expired browser retained its queue")
	}
	b.execute(owner, owner, browserJob("release", browserSession))
	if status := b.status(); status["browser"] != "Google Chrome" || b.primaryID != other {
		t.Fatal("next turn did not select a live Chrome profile", status)
	}
}

func TestBrowserExtensionCDPRoundtripUsesPerClientQueues(t *testing.T) {
	b := connectedBrowser()
	server := httptest.NewServer(b)
	defer server.Close()
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	if result := b.execute(owner, owner, browserJob("acquire", browserSession)); result["error"] != nil {
		t.Fatal(result)
	}
	args, _ := json.Marshal(map[string]any{"session": browserSession, "operation": "cdp", "args": map[string]any{"tabTag": "C1-test", "method": "Runtime.evaluate", "params": map[string]any{"expression": "6 * 7", "returnByValue": true}, "sessionId": "child-session"}})
	result := make(chan map[string]any, 1)
	go func() { result <- b.execute(owner, owner, job{ID: "cdp-roundtrip", Op: "browser", Args: args}) }()
	post := func(ctx context.Context, path, client string, value map[string]any) (*http.Response, error) {
		value["clientId"] = client
		data, _ := json.Marshal(value)
		req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+path, bytes.NewReader(data))
		req.Header.Set("Origin", extensionOrigin)
		req.Header.Set("Authorization", "Bearer "+b.token)
		req.Header.Set("Content-Type", "application/json")
		ua := "Chrome/130.0"
		if client == browserSession {
			ua += " Edg/130.0"
		}
		req.Header.Set("User-Agent", ua)
		return server.Client().Do(req)
	}
	// Edge must remain connected without stealing the command addressed to Chrome.
	edgeCtx, stopEdge := context.WithTimeout(owner, 100*time.Millisecond)
	defer stopEdge()
	if response, err := post(edgeCtx, "/poll", browserSession, map[string]any{}); err == nil {
		response.Body.Close()
		t.Fatalf("Edge poll returned HTTP %d instead of waiting on its own queue", response.StatusCode)
	}
	response, err := post(owner, "/poll", browserClient, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var poll struct {
		Command browserCommand `json:"command"`
		Version string         `json:"version"`
	}
	err = json.NewDecoder(response.Body).Decode(&poll)
	response.Body.Close()
	if err != nil || !response.Close || response.StatusCode != 200 || poll.Version != extensionVersion || poll.Command.Operation != "cdp" {
		t.Fatalf("incompatible poll response: %+v, %v", poll, err)
	}
	var received map[string]any
	_ = json.Unmarshal(poll.Command.Args, &received)
	if received["tabTag"] != "C1-test" || received["method"] != "Runtime.evaluate" || received["sessionId"] != "child-session" || received["params"].(map[string]any)["expression"] != "6 * 7" {
		t.Fatal("CDP arguments changed in transit", received)
	}
	if remaining := time.Until(time.UnixMilli(poll.Command.ExpiresAt)); remaining <= 3*time.Second || remaining > 10*time.Second {
		t.Fatal("CDP did not use Nova's 10-second budget", remaining)
	}
	for _, client := range []string{browserSession, browserClient} {
		response, err := post(owner, "/reply", client, map[string]any{"id": poll.Command.ID, "result": map[string]any{"result": map[string]any{"type": "number", "value": 42}}})
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if client == browserSession {
			select {
			case value := <-result:
				t.Fatal("another browser supplied the CDP result", value)
			default:
			}
		}
	}
	if value := <-result; value["error"] != nil || value["result"].(map[string]any)["result"].(map[string]any)["value"] != float64(42) {
		t.Fatal("CDP result did not reach its caller", value)
	}
}

func TestLocalBrowserUploadOnlyAllowsRegularWorkspaceFiles(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "upload.txt")
	if err := os.WriteFile(file, []byte("local"), 0600); err != nil {
		t.Fatal(err)
	}
	if r := fileOperation(fileReq{Op: "upload", Cwd: root, Path: "upload.txt"}); r["path"] != file {
		t.Fatal(r)
	}
	if r := fileOperation(fileReq{Op: "read_workspace", Cwd: root, Path: "upload.txt"}); r["path"] != file || r["content"] != base64.StdEncoding.EncodeToString([]byte("local")) {
		t.Fatal("workspace read did not return the checked file", r)
	}
	for _, path := range []string{root, filepath.Join(t.TempDir(), "outside"), "missing"} {
		for _, op := range []string{"upload", "read_workspace"} {
			if r := fileOperation(fileReq{Op: op, Cwd: root, Path: path}); r["error"] == nil {
				t.Fatal("unsafe workspace path allowed", r)
			}
		}
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if r := fileOperation(fileReq{Op: "upload", Cwd: root, Path: outside}); r["error"] == nil {
		t.Fatal("outside file allowed", r)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err == nil {
		for _, op := range []string{"upload", "read_workspace"} {
			if r := fileOperation(fileReq{Op: op, Cwd: root, Path: link}); r["error"] == nil {
				t.Fatal("escaping symlink allowed", r)
			}
		}
	}
	large, err := os.Create(filepath.Join(root, "large.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err = large.Truncate((25 << 20) + 1); err != nil {
		t.Fatal(err)
	}
	_ = large.Close()
	if r := fileOperation(fileReq{Op: "read_workspace", Cwd: root, Path: "large.bin"}); r["error"] == nil {
		t.Fatal("oversized workspace file allowed", r)
	}
}
