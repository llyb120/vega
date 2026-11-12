package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 真机验证：无头 Chrome 起来 → CDP 装内置扩展 → 扩展连回本机桥接 → chrome 工具能用它开页。
// 需要本机安装 Chrome（≥125）并显式打开：VEGA_TEST_CHROME=1 go test -run HeadlessChromeLive -v
func TestHeadlessChromeLive(t *testing.T) {
	if os.Getenv("VEGA_TEST_CHROME") != "1" {
		t.Skip("set VEGA_TEST_CHROME=1 to launch a real headless Chrome")
	}
	extension, err := filepath.Abs(filepath.Join("extension", "vega-chrome"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(extension, "manifest.json")); err != nil {
		t.Fatalf("bundled extension missing: %v", err)
	}
	// 桥接端口是固定范围的：本机已经有客户端在跑时让开，避免抢端口。
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	headless := &headlessChrome{dir: t.TempDir(), extension: func() (string, error) { return extension, nil }}
	headlessBrowser.Store(headless)
	defer func() {
		headlessStop()
		server.Close()
	}()
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := time.Now()
	if err = headless.ensure(bridge, owner); err != nil {
		t.Fatalf("headless Chrome did not come up: %v", err)
	}
	// 认的是这次写进扩展副本的 clientID，不是 UA，也不是「启动前后新出现的客户端」。
	clientID := headless.clientID()
	if clientID == "" || bridge.headlessClient() != clientID {
		t.Fatalf("bridge bound %q, want the launched clientID %q", bridge.headlessClient(), clientID)
	}
	patched, err := os.ReadFile(filepath.Join(headless.dir, "extension", "worker.js"))
	if err != nil {
		t.Fatalf("the launch did not unpack its patched extension: %v", err)
	}
	if !strings.Contains(string(patched), `clientId: "`+clientID+`",`) {
		t.Fatal("the loaded extension does not carry the launched clientID")
	}
	if source, readErr := os.ReadFile(filepath.Join(extension, "worker.js")); readErr != nil || !strings.Contains(string(source), workerClientIDLine) {
		t.Fatal("the bundled extension must stay untouched")
	}
	t.Logf("headless Chrome + extension ready in %s", time.Since(started).Round(time.Millisecond))
	if status := bridge.status(); status["connected"] != true || status["headless"] != true || !strings.Contains(fmt.Sprint(status["browsers"]), "（无头）") {
		t.Fatalf("bridge did not bind the headless instance: %v", status)
	}
	// acquire 之后走真正的 chrome 工具操作：开一个本地页面，确认标签归属和标题。
	page := "about:blank"
	server2 := &http.Server{}
	listener, listenErr := net.Listen("tcp", "127.0.0.1:0")
	if listenErr != nil {
		t.Fatal(listenErr)
	}
	server2.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<title>vega-headless</title><h1>ok</h1>")
	})
	go func() { _ = server2.Serve(listener) }()
	defer server2.Close()
	page = "http://" + listener.Addr().String() + "/"
	call := func(operation string, args map[string]any) map[string]any {
		payload, _ := json.Marshal(map[string]any{"session": browserSession, "operation": operation, "args": args})
		return bridge.execute(owner, owner, job{ID: "44444444-4444-4444-8444-444444444444", Op: "browser", Args: payload})
	}
	if result := call("acquire", map[string]any{}); result["error"] != nil {
		t.Fatalf("acquire failed: %v", result)
	}
	defer call("release", map[string]any{})
	result := call("open", map[string]any{"url": page})
	if result["error"] != nil {
		t.Fatalf("open failed: %v", result)
	}
	tabs, _ := result["result"].(map[string]any)
	if tabs["tabTag"] == nil {
		t.Fatalf("no tabTag returned: %v", result)
	}
	// 页面确实在无头浏览器里加载了：标题读得回来。
	loaded := call("cdp", map[string]any{"tabTag": tabs["tabTag"], "method": "Runtime.evaluate", "params": map[string]any{"expression": "document.title", "returnByValue": true}})
	if loaded["error"] != nil || !strings.Contains(fmt.Sprint(loaded["result"]), "vega-headless") {
		t.Fatalf("page did not load in the headless browser: %v", loaded)
	}
	t.Logf("headless tab %v loaded %q", tabs["tabTag"], "vega-headless")
}
