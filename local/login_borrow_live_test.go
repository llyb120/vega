package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 真机验证整条借用链路：你开的 Chrome（扩展连上桥接）里种一条 Cookie → borrowLogin →
// 无头实例用 Network.getCookies 读得到。需要本机 Chrome 并显式打开：
//
//	VEGA_TEST_CHROME=1 go test -run BorrowLoginLive -v
func TestBorrowLoginLiveFromHeadedChrome(t *testing.T) {
	if os.Getenv("VEGA_TEST_CHROME") != "1" {
		t.Skip("set VEGA_TEST_CHROME=1 to launch real Chrome instances")
	}
	binary := headlessChromeBinary()
	if binary == "" {
		t.Skip("no Chrome found")
	}
	extension, err := filepath.Abs(filepath.Join("extension", "vega-chrome"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(extension, "manifest.json")); err != nil {
		t.Fatalf("bundled extension missing: %v", err)
	}
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()

	// 你开的 Chrome：和客户端无头实例同一套启动方式，只是不加 --headless=new。
	profile := filepath.Join(t.TempDir(), "headed")
	headed := exec.CommandContext(context.Background(), binary,
		"--no-first-run", "--no-default-browser-check", "--window-size=1000,700",
		"--remote-debugging-port=0", "--user-data-dir="+profile, "about:blank")
	configureCommand(headed)
	if err = headed.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if headed.Cancel != nil {
			_ = headed.Cancel()
		} else if headed.Process != nil {
			_ = headed.Process.Kill()
		}
	}()
	port, path, err := waitDevToolsPort(filepath.Join(profile, "DevToolsActivePort"), 20*time.Second)
	if err != nil {
		t.Fatalf("headed Chrome did not start: %v", err)
	}
	if err = loadUnpacked(port, path, extension); err != nil {
		t.Fatalf("load extension into headed Chrome: %v", err)
	}
	peer := ""
	for deadline := time.Now().Add(40 * time.Second); time.Now().Before(deadline) && peer == ""; time.Sleep(200 * time.Millisecond) {
		if peers := bridge.headedPeers(); len(peers) > 0 {
			peer = peers[0]
		}
	}
	if peer == "" {
		t.Fatal("headed Chrome extension never connected to the bridge")
	}

	// 一个本站页面：Cookie 用真实 URL 种，避免公共后缀/安全上下文判断。
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	site := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<title>vega-borrow</title>ok")
	})}
	go func() { _ = site.Serve(listener) }()
	defer site.Close()
	siteURL := "http://" + listener.Addr().String() + "/"

	// 借用只读后台页签：先多开一个页签（默认 about:blank），让种 Cookie 的那页退到后台。
	if _, err = bridge.internal(peer, "open", map[string]any{}, 20*time.Second); err != nil {
		t.Fatalf("open tab in headed Chrome: %v", err)
	}
	tabs, err := bridge.internal(peer, "tabs", map[string]any{}, 20*time.Second)
	if err != nil {
		t.Fatalf("tabs: %v", err)
	}
	active := ""
	for _, tab := range tabList(tabs) {
		if tab["active"] == true {
			active, _ = tab["tag"].(string)
		}
	}
	if active == "" {
		t.Fatalf("no active tab to write the cookie: %v", tabs)
	}
	if _, err = bridge.internal(peer, "cdp", map[string]any{
		"tabTag": active, "method": "Network.setCookies",
		"params": map[string]any{"cookies": []map[string]any{{"name": "vega-borrow", "value": "live", "url": siteURL}}},
	}, 20*time.Second); err != nil {
		t.Fatalf("set cookie in headed Chrome: %v", err)
	}

	// 无头实例起来后借用一次。
	headless := &headlessChrome{dir: filepath.Join(t.TempDir(), "headless-browser"), extension: func() (string, error) { return extension, nil }}
	headlessBrowser.Store(headless)
	defer headlessStop()
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err = headless.ensure(bridge, owner); err != nil {
		t.Fatalf("headless Chrome did not come up: %v", err)
	}
	// 第一条浏览器命令前就应该把你自己 Chrome 的登录态搬过来（ensureHeadless 负责）。
	if err = bridge.ensureHeadless(owner); err != nil {
		t.Fatalf("ensureHeadless: %v", err)
	}
	if notice := headless.currentNotice(); !strings.Contains(notice, "同步") {
		t.Fatalf("borrow did not report a sync: %q", notice)
	}

	client := bridge.headlessClient()
	tab, err := bridge.anyTab(client)
	if err != nil {
		t.Fatalf("headless tabs: %v", err)
	}
	raw, err := bridge.internal(client, "cdp", map[string]any{
		"tabTag": tab, "method": "Network.getCookies", "params": map[string]any{"urls": []string{siteURL}},
	}, 20*time.Second)
	if err != nil {
		t.Fatalf("read cookies from headless instance: %v", err)
	}
	if !strings.Contains(fmt.Sprint(raw), "vega-borrow") {
		t.Fatalf("cookie did not reach the headless browser: %v", raw)
	}
	// 反向：无头浏览器里新登录的站点，同步一次就回到你自己的 Chrome。
	if _, err = bridge.internal(client, "cdp", map[string]any{
		"tabTag": tab, "method": "Network.setCookies",
		"params": map[string]any{"cookies": []map[string]any{{"name": "vega-agent-login", "value": "back", "url": siteURL}}},
	}, 20*time.Second); err != nil {
		t.Fatalf("set a new login in the headless browser: %v", err)
	}
	headless.mu.Lock()
	headless.lastLogin = time.Time{} // 取消节流，当作下一轮同步
	headless.mu.Unlock()
	bridge.borrowLogin(headless)
	back, err := bridge.internal(peer, "cdp", map[string]any{
		"tabTag": active, "method": "Network.getCookies", "params": map[string]any{"urls": []string{siteURL}},
	}, 20*time.Second)
	if err != nil {
		t.Fatalf("read cookies back from your own Chrome: %v", err)
	}
	if !strings.Contains(fmt.Sprint(back), "vega-agent-login") {
		t.Fatalf("the headless login was not written back to your own Chrome: %v", back)
	}
	t.Logf("synced both ways with %s: your Chrome → headless, then a headless login → your Chrome", siteURL)
}

// cookiesOf 取出 CDP 返回的 cookie 列表，只用于日志里的条数。
func cookiesOf(raw any) []any {
	object, _ := raw.(map[string]any)
	list, _ := object["cookies"].([]any)
	return list
}
