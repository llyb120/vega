package main

import (
	"bytes"
	"context"
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
	b.client, b.browser, b.lastAt = browserClient, "Google Chrome", time.Now()
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
	b.client = "44444444-4444-4444-8444-444444444444"
	if r := call(first, "tabs", browserClient); r["status"] != "unavailable" {
		t.Fatal("lease silently switched browser profile", r)
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
	if status, _ := post("/poll", extensionOrigin, "wrong", map[string]any{"clientId": browserClient}); status != 401 {
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
	if command["operation"] != "tabs" || command["id"] != browserJob("", "").ID {
		t.Fatal(command)
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
	go func() { result <- b.execute(connection, ctx, browserJob("tabs", browserSession)) }()
	queued := <-b.queue
	stop()
	if r := <-result; !strings.Contains(r["error"].(string), "may have executed") {
		t.Fatal(r)
	}
	b.mu.Lock()
	_, pending := b.pending[queued.ID]
	b.mu.Unlock()
	if pending || len(b.queue) != 0 {
		t.Fatal("cancelled operation retained for replay")
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
	for _, path := range []string{root, filepath.Join(t.TempDir(), "outside"), "missing"} {
		if r := fileOperation(fileReq{Op: "upload", Cwd: root, Path: path}); r["error"] == nil {
			t.Fatal("unsafe upload allowed", r)
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
		if r := fileOperation(fileReq{Op: "upload", Cwd: root, Path: link}); r["error"] == nil {
			t.Fatal("escaping symlink allowed", r)
		}
	}
}
