package main

// 登录态同步：用两个假扩展（一个「你自己的 Chrome」、一个无头实例）跑真实的桥接协议，两个方向都验。
// 真机上的 CDP 调用（Network.getAllCookies / Network.setCookies）已在 login_borrow_live_test 里双向验证过。

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeExtension struct {
	clientID  string
	userAgent string
	bridge    *browserBridge
	token     string
	mu        sync.Mutex
	calls     []fakeCall
	stop      chan struct{}
	done      chan struct{}
}

type fakeCall struct {
	operation string
	args      map[string]any
}

// startFakeExtension 按扩展的真实协议连上桥接：/pair 拿令牌，然后一直 /poll、/reply。
func startFakeExtension(t *testing.T, bridge *browserBridge, clientID, userAgent string, handle func(call fakeCall) (any, error)) *fakeExtension {
	t.Helper()
	peer := &fakeExtension{clientID: clientID, userAgent: userAgent, bridge: bridge, stop: make(chan struct{}), done: make(chan struct{})}
	base := "http://127.0.0.1:" + itoaInt(int(bridge.port))
	post := func(path string, body map[string]any) (*http.Response, error) {
		payload, _ := json.Marshal(body)
		request, _ := http.NewRequest(http.MethodPost, base+path, bytes.NewReader(payload))
		request.Header.Set("Origin", extensionOrigin)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", userAgent)
		if peer.token != "" {
			request.Header.Set("Authorization", "Bearer "+peer.token)
		}
		return http.DefaultClient.Do(request)
	}
	pair, err := post("/pair", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var paired struct{ Token string }
	_ = json.NewDecoder(pair.Body).Decode(&paired)
	pair.Body.Close()
	peer.token = paired.Token
	if peer.token == "" {
		t.Fatal("no bridge token")
	}
	go func() {
		defer close(peer.done)
		client := &http.Client{Timeout: 25 * time.Second}
		for {
			select {
			case <-peer.stop:
				return
			default:
			}
			payload, _ := json.Marshal(map[string]any{"clientId": clientID})
			request, _ := http.NewRequest(http.MethodPost, base+"/poll", bytes.NewReader(payload))
			request.Header.Set("Origin", extensionOrigin)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("User-Agent", userAgent)
			request.Header.Set("Authorization", "Bearer "+peer.token)
			response, err := client.Do(request)
			if err != nil {
				return
			}
			var polled struct {
				Command *struct {
					ID        string         `json:"id"`
					Operation string         `json:"operation"`
					Args      map[string]any `json:"args"`
				} `json:"command"`
			}
			_ = json.NewDecoder(response.Body).Decode(&polled)
			response.Body.Close()
			if polled.Command == nil {
				continue
			}
			call := fakeCall{operation: polled.Command.Operation, args: polled.Command.Args}
			peer.mu.Lock()
			peer.calls = append(peer.calls, call)
			peer.mu.Unlock()
			reply := map[string]any{"clientId": clientID, "id": polled.Command.ID}
			if result, err := handle(call); err != nil {
				reply["error"] = err.Error()
			} else {
				reply["result"] = result
			}
			if _, err := post("/reply", reply); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		close(peer.stop)
		<-peer.done
	})
	return peer
}

func (peer *fakeExtension) recorded() []fakeCall {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return append([]fakeCall{}, peer.calls...)
}

func itoaInt(value int) string {
	digits := []byte{}
	if value == 0 {
		return "0"
	}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func TestBorrowLoginCopiesIdleTabCookiesIntoHeadlessBrowser(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	// 你自己的 Chrome：一个前台页签、一个后台页签。只有后台页签可以被静默借走。
	headed := startFakeExtension(t, bridge, "11111111-1111-4111-8111-111111111111", "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{
				{"tag": "H1", "url": "https://mine.test/active", "active": true},
				{"tag": "H2", "url": "https://mine.test/background", "active": false, "loading": false},
				{"tag": "H3", "url": "chrome://settings/", "active": false},
			}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			if call.args["tabTag"] != "H2" {
				t.Errorf("borrow must read an idle tab, got %v", call.args["tabTag"])
			}
			return map[string]any{"cookies": []any{
				map[string]any{"name": "sid", "value": "secret", "domain": ".mine.test", "path": "/", "secure": true, "httpOnly": true, "sameSite": "None", "expires": 4102444800.0},
				map[string]any{"name": "pref", "value": "dark", "domain": ".mine.test", "path": "/", "expires": -1.0},
				map[string]any{"name": "chips", "value": "x", "domain": ".mine.test", "path": "/", "partitionKey": map[string]any{"topLevelSite": "https://a.test"}},
				map[string]any{"name": "", "value": "nameless", "domain": ".mine.test"},
			}}, nil
		case call.operation == "stop":
			return map[string]any{"tabs": []any{}}, nil
		}
		return nil, nil
	})
	// 无头实例：一个 about:blank 页签，接收 setCookies。
	var pushed []any
	var pushedMu sync.Mutex
	headless := startFakeExtension(t, bridge, "22222222-2222-4222-8222-222222222222", "Mozilla/5.0 HeadlessChrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{{"tag": "C1", "url": "about:blank", "active": true}}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.setCookies":
			params, _ := call.args["params"].(map[string]any)
			batch, _ := params["cookies"].([]any)
			pushedMu.Lock()
			pushed = append(pushed, batch...)
			pushedMu.Unlock()
			return map[string]any{}, nil
		}
		return nil, nil
	})
	// 等到两个实例都被桥接看见（/poll 一次就够）。
	waitFor(t, func() bool {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		return len(bridge.clients) == 2
	})
	chrome := &headlessChrome{dir: t.TempDir()}
	bridge.borrowLogin(chrome)

	pushedMu.Lock()
	copied := len(pushed)
	first, _ := pushed[0].(map[string]any)
	pushedMu.Unlock()
	if copied != 2 {
		t.Fatalf("only valid cookies should be copied, got %d (%v)", copied, pushed)
	}
	if first["name"] != "sid" || first["value"] != "secret" || first["domain"] != ".mine.test" {
		t.Fatalf("cookie fields lost: %v", first)
	}
	if first["httpOnly"] != true || first["secure"] != true || first["sameSite"] != "None" || first["expires"] == nil {
		t.Fatalf("cookie flags lost: %v", first)
	}
	// 借完必须松开你自己的页签（调试横条/标签组不能留着）。
	stops := 0
	for _, call := range headed.recorded() {
		if call.operation == "stop" {
			stops++
			if call.args["tabTag"] != "H2" {
				t.Fatalf("detached the wrong tab: %v", call.args["tabTag"])
			}
		}
	}
	if stops != 1 {
		t.Fatalf("expected exactly one detach on your own Chrome tab, got %d", stops)
	}
	if !strings.Contains(chrome.currentNotice(), "同步 2 个 Cookie") {
		t.Fatalf("notice should say what was synced: %q", chrome.currentNotice())
	}
	// 节流：同一实例十分钟内不再读用户的页签。
	before := len(headed.recorded())
	bridge.borrowLogin(chrome)
	if after := len(headed.recorded()); after != before {
		t.Fatalf("borrow must be throttled, extra calls: %d", after-before)
	}
	_ = headless
}

func TestBorrowLoginWaitsWhenABrowserSessionOwnsTheLease(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	headed := startFakeExtension(t, bridge, "33333333-3333-4333-8333-333333333333", "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		return map[string]any{"tabs": []map[string]any{{"tag": "H9", "url": "https://mine.test/", "active": false}}}, nil
	})
	startFakeExtension(t, bridge, "44444444-4444-4444-8444-444444444444", "Mozilla/5.0 HeadlessChrome/157", func(call fakeCall) (any, error) {
		return map[string]any{"tabs": []map[string]any{{"tag": "C1", "url": "about:blank", "active": true}}}, nil
	})
	waitFor(t, func() bool {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		return len(bridge.clients) == 2
	})
	// 有会话正占着浏览器：这时借用户的页签会打断它，必须跳过。
	bridge.mu.Lock()
	bridge.connection = t.Context()
	bridge.session = browserSession
	bridge.mu.Unlock()
	chrome := &headlessChrome{dir: t.TempDir()}
	bridge.borrowLogin(chrome)
	if calls := headed.recorded(); len(calls) != 0 {
		t.Fatalf("must not touch the user's tabs while a session owns the browser: %v", calls)
	}
	if !chrome.loginDue(time.Now()) {
		t.Fatal("a skipped borrow must stay due for the next turn")
	}
}

func TestLoginCookieListKeepsOnlyPortableCookies(t *testing.T) {
	raw := map[string]any{"cookies": []any{
		map[string]any{"name": "a", "value": "1", "domain": ".x.test", "path": "/p", "secure": true, "httpOnly": false, "sameSite": "Lax", "expires": 1.9e9},
		map[string]any{"name": "b", "value": "2", "domain": "x.test", "expires": -1.0},
		map[string]any{"name": "c", "value": strings.Repeat("v", 9000), "domain": "x.test"},
		map[string]any{"name": "d", "value": "4", "domain": ".x.test", "partitionKey": map[string]any{"topLevelSite": "https://y.test"}},
		map[string]any{"value": "no-name", "domain": ".x.test"},
		map[string]any{"name": "e", "value": "5"},
		"not-a-cookie",
	}}
	cookies := loginCookieList(raw)
	if len(cookies) != 2 {
		t.Fatalf("want two portable cookies, got %d: %v", len(cookies), cookies)
	}
	if cookies[0]["path"] != "/p" || cookies[0]["sameSite"] != "Lax" || cookies[0]["expires"] == nil {
		t.Fatalf("first cookie lost fields: %v", cookies[0])
	}
	if _, has := cookies[0]["httpOnly"]; has {
		t.Fatalf("false flags must be omitted: %v", cookies[0])
	}
	if _, has := cookies[1]["expires"]; has {
		t.Fatalf("session cookies must not carry expires: %v", cookies[1])
	}
	if cookies[1]["path"] != "/" {
		t.Fatalf("default path must be /: %v", cookies[1])
	}
	if empty := loginCookieList(nil); len(empty) != 0 {
		t.Fatalf("nil result must stay empty: %v", empty)
	}
}

// 无头浏览器里新登录的站点（你自己 Chrome 没有的 Cookie）要写回你的 Chrome；
// 两边都有的有效会话谁也不动。
func TestSyncLoginWritesNewLoginsBackToYourChrome(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	var back []any
	var backMu sync.Mutex
	headed := startFakeExtension(t, bridge, "55555555-5555-4555-8555-555555555555", "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{
				{"tag": "H1", "url": "https://mine.test/active", "active": true},
				{"tag": "H2", "url": "https://mine.test/background", "active": false},
			}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			if call.args["tabTag"] != "H2" {
				t.Errorf("sync must read an idle tab, got %v", call.args["tabTag"])
			}
			return map[string]any{"cookies": []any{
				map[string]any{"name": "sid", "value": "mine", "domain": ".mine.test", "path": "/", "expires": 4102444800.0},
			}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.setCookies":
			params, _ := call.args["params"].(map[string]any)
			batch, _ := params["cookies"].([]any)
			backMu.Lock()
			back = append(back, batch...)
			backMu.Unlock()
			return map[string]any{}, nil
		case call.operation == "stop":
			return map[string]any{}, nil
		}
		return nil, nil
	})
	var forward []any
	var forwardMu sync.Mutex
	var later bool
	var laterMu sync.Mutex
	startFakeExtension(t, bridge, "66666666-6666-4666-8666-666666666666", "Mozilla/5.0 HeadlessChrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{{"tag": "C1", "url": "about:blank", "active": true}}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			cookies := []any{
				map[string]any{"name": "sid", "value": "mine", "domain": ".mine.test", "path": "/", "expires": 4102444800.0},
				map[string]any{"name": "agent", "value": "fresh", "domain": ".shop.test", "path": "/", "secure": true},
			}
			laterMu.Lock()
			if later {
				cookies = append(cookies, map[string]any{"name": "later", "value": "new", "domain": ".later.test", "path": "/"})
			}
			laterMu.Unlock()
			return map[string]any{"cookies": cookies}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.setCookies":
			params, _ := call.args["params"].(map[string]any)
			batch, _ := params["cookies"].([]any)
			forwardMu.Lock()
			forward = append(forward, batch...)
			forwardMu.Unlock()
			return map[string]any{}, nil
		}
		return nil, nil
	})
	waitFor(t, func() bool {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		return len(bridge.clients) == 2
	})
	chrome := &headlessChrome{dir: t.TempDir()}
	bridge.borrowLogin(chrome)

	backMu.Lock()
	written := append([]any{}, back...)
	backMu.Unlock()
	if len(written) != 1 {
		t.Fatalf("only the headless-only login should reach your Chrome, got %v", written)
	}
	entry, _ := written[0].(map[string]any)
	if entry["name"] != "agent" || entry["value"] != "fresh" || entry["domain"] != ".shop.test" || entry["secure"] != true {
		t.Fatalf("cookie written back to your Chrome lost fields: %v", entry)
	}
	forwardMu.Lock()
	overwrote := append([]any{}, forward...)
	forwardMu.Unlock()
	if len(overwrote) != 0 {
		t.Fatalf("an existing session must not be overwritten by the other side: %v", overwrote)
	}
	if !strings.Contains(chrome.currentNotice(), "写回你自己的 Chrome") {
		t.Fatalf("notice should mention the write-back: %q", chrome.currentNotice())
	}
	stops := 0
	for _, call := range headed.recorded() {
		if call.operation == "stop" {
			stops++
		}
	}
	if stops != 1 {
		t.Fatalf("the user's tab must be detached once after reading and writing, got %d", stops)
	}
	// 无头登录态没变：一轮结束时不碰你自己的 Chrome（attach 会弹一下调试横条）。
	previous := headlessBrowser.Load()
	headlessBrowser.Store(chrome)
	defer headlessBrowser.Store(previous)
	before := len(headed.recorded())
	bridge.syncLoginAfterTurn()
	if after := len(headed.recorded()); after != before {
		t.Fatalf("an unchanged headless profile must not touch your Chrome again: %v", headed.recorded()[before:])
	}
	// 无头里新登录一个站点：一轮结束就写回你的 Chrome，不必等十分钟。
	laterMu.Lock()
	later = true
	laterMu.Unlock()
	bridge.syncLoginAfterTurn()
	waitFor(t, func() bool {
		backMu.Lock()
		defer backMu.Unlock()
		return len(back) == 2
	})
	backMu.Lock()
	freshEntry, _ := back[1].(map[string]any)
	backMu.Unlock()
	if freshEntry["name"] != "later" || freshEntry["domain"] != ".later.test" {
		t.Fatalf("only the newly logged-in cookie should be written back: %v", freshEntry)
	}
}

func TestLoginMergeOnlyFillsGapsAndReplacesExpiredCookies(t *testing.T) {
	future, past := 4102444800.0, 1000.0
	theirs := []map[string]any{
		{"name": "same", "value": "v", "domain": ".a.test", "path": "/", "expires": future},
		{"name": "rotate", "value": "stale", "domain": ".a.test", "path": "/", "expires": past},
		{"name": "both", "value": "user", "domain": ".a.test", "path": "/", "expires": future},
		{"name": "user-only", "value": "u", "domain": ".a.test", "path": "/"},
		// 已经过期的来源 Cookie 搬过去也不会生效，不该反复写。
		{"name": "stale-src", "value": "x", "domain": ".a.test", "path": "/", "expires": past},
	}
	mine := []map[string]any{
		{"name": "same", "value": "v", "domain": ".a.test", "path": "/", "expires": future},
		{"name": "rotate", "value": "fresh", "domain": ".a.test", "path": "/", "expires": future},
		{"name": "both", "value": "agent", "domain": ".a.test", "path": "/", "expires": future},
		{"name": "agent-only", "value": "a", "domain": ".b.test", "path": "/"},
		{"name": "stale-agent", "value": "y", "domain": ".a.test", "path": "/", "expires": past},
	}
	forward, back := loginMerge(theirs, mine)
	names := func(list []map[string]any) []string {
		values := []string{}
		for _, cookie := range list {
			values = append(values, cookie["name"].(string))
		}
		return values
	}
	if got := strings.Join(names(forward), ","); got != "user-only" {
		t.Fatalf("your Chrome's own logins should fill the headless gaps only, got %s", got)
	}
	if got := strings.Join(names(back), ","); got != "rotate,agent-only" {
		t.Fatalf("the headless side should only fill your Chrome's gaps and refresh an expired cookie, got %s", got)
	}
	if back[0]["value"] != "fresh" {
		t.Fatalf("an expired cookie must be replaced by the live one: %v", back[0])
	}
}

// 镜像：已经写回过的无头 Cookie 不会因为你删了它又被种回来；新值才算新登录；
// 换一个无头实例不能继承旧镜像。
func TestLoginMirrorKeepsDeletedCookiesFromComingBack(t *testing.T) {
	owner := "mirror-owner-1"
	sid := func(value string) []map[string]any {
		return []map[string]any{{"name": "sid", "value": value, "domain": ".m.test", "path": "/", "expires": 4102444800.0}}
	}
	if loginMirrorUnchanged(owner, sid("1")) {
		t.Fatal("an instance that was never synced is not 'unchanged'")
	}
	if got := loginUnmirrored(owner, sid("1")); len(got) != 1 {
		t.Fatalf("the first sync must offer every cookie: %v", got)
	}
	recordMirror(owner, sid("1"))
	if !loginMirrorUnchanged(owner, sid("1")) {
		t.Fatal("the same profile must count as unchanged")
	}
	// 用户在自己 Chrome 里删掉了它：镜像没变 → 不会再写回去。
	if got := loginUnmirrored(owner, sid("1")); len(got) != 0 {
		t.Fatalf("a mirrored cookie must not be written back again: %v", got)
	}
	// 无头里换成了新值：这才是新登录。
	if loginMirrorUnchanged(owner, sid("2")) {
		t.Fatal("a changed value is a change")
	}
	if got := loginUnmirrored(owner, sid("2")); len(got) != 1 || got[0]["value"] != "2" {
		t.Fatalf("a changed value must be offered once: %v", got)
	}
	if loginMirrorUnchanged("mirror-owner-2", sid("2")) {
		t.Fatal("a new headless instance must not inherit the mirror")
	}
}

// host-only Cookie 必须用 url 写，否则会把登录扩散到子域；域 Cookie 保留 domain。
func TestLoginCookieParamWritesHostOnlyCookiesWithURL(t *testing.T) {
	hostOnly := loginCookieParam(map[string]any{"name": "h", "value": "1", "domain": "x.test", "path": "/p", "secure": true, "sameSite": 8.0, "expires": 4102444800.0})
	if hostOnly == nil || hostOnly["url"] != "https://x.test/p" {
		t.Fatalf("host-only cookie must land on its own host: %v", hostOnly)
	}
	if _, has := hostOnly["domain"]; has {
		t.Fatalf("host-only cookie must not carry a domain: %v", hostOnly)
	}
	if _, has := hostOnly["sameSite"]; has {
		t.Fatalf("an unknown sameSite value must be dropped: %v", hostOnly)
	}
	if hostOnly["secure"] != true || hostOnly["httpOnly"] != false || hostOnly["expires"] == nil {
		t.Fatalf("flags lost: %v", hostOnly)
	}
	domainCookie := loginCookieParam(map[string]any{"name": "d", "value": "1", "domain": ".x.test", "path": "/", "sameSite": "Lax"})
	if domainCookie == nil || domainCookie["domain"] != ".x.test" || domainCookie["url"] != nil || domainCookie["sameSite"] != "Lax" {
		t.Fatalf("domain cookie must keep its domain: %v", domainCookie)
	}
	if _, has := domainCookie["expires"]; has {
		t.Fatalf("session cookies must not carry expires: %v", domainCookie)
	}
	if partitioned := loginCookieParam(map[string]any{"name": "p", "value": "1", "domain": ".x.test", "partitionKey": map[string]any{"topLevelSite": "https://a.test"}}); partitioned != nil {
		t.Fatalf("partitioned cookies cannot be moved: %v", partitioned)
	}
	if nameless := loginCookieParam(map[string]any{"value": "1", "domain": ".x.test"}); nameless != nil {
		t.Fatalf("a cookie without a name is not portable: %v", nameless)
	}
}

// 你删掉的登录不会被无头实例种回去：镜像只写它没见过的新登录。
func TestSyncLoginDoesNotResurrectACookieDeletedInYourChrome(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	var back []any
	var backMu sync.Mutex
	var loggedOut bool
	var logoutMu sync.Mutex
	headed := startFakeExtension(t, bridge, "77777777-7777-4777-8777-777777777777", "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{
				{"tag": "H1", "url": "https://mine.test/active", "active": true},
				{"tag": "H2", "url": "https://mine.test/background", "active": false},
			}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			logoutMu.Lock()
			out := loggedOut
			logoutMu.Unlock()
			if out {
				return map[string]any{"cookies": []any{}}, nil
			}
			return map[string]any{"cookies": []any{
				map[string]any{"name": "sid", "value": "mine", "domain": ".mine.test", "path": "/", "expires": 4102444800.0},
			}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.setCookies":
			params, _ := call.args["params"].(map[string]any)
			batch, _ := params["cookies"].([]any)
			backMu.Lock()
			back = append(back, batch...)
			backMu.Unlock()
			return map[string]any{}, nil
		case call.operation == "stop":
			return map[string]any{}, nil
		}
		return nil, nil
	})
	headlessID := "88888888-8888-4888-8888-888888888888"
	startFakeExtension(t, bridge, headlessID, "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{{"tag": "C1", "url": "about:blank", "active": true}}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			return map[string]any{"cookies": []any{
				map[string]any{"name": "agent", "value": "fresh", "domain": ".shop.test", "path": "/"},
			}}, nil
		}
		return nil, nil
	})
	waitFor(t, func() bool {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		return len(bridge.clients) == 2
	})
	chrome := &headlessChrome{dir: t.TempDir()}
	chrome.setClientID(headlessID)
	previous := headlessBrowser.Load()
	headlessBrowser.Store(chrome)
	defer headlessBrowser.Store(previous)

	bridge.borrowLogin(chrome)
	backMu.Lock()
	first := len(back)
	backMu.Unlock()
	if first != 1 {
		t.Fatalf("the headless login should be written once, got %v", back)
	}
	// 你在 Chrome 里退出登录（那条 Cookie 没了），无头里还是同一个值：不应再写回去。
	logoutMu.Lock()
	loggedOut = true
	logoutMu.Unlock()
	chrome.resetLogin()
	bridge.borrowLogin(chrome)
	backMu.Lock()
	after := len(back)
	backMu.Unlock()
	if after != first {
		t.Fatalf("a deleted login must not come back: %v", back[first:])
	}
	_ = headed
}

// 同时连了多个浏览器时只跟第一个（Chrome 优先）：别把 A 的登录写进 B。
func TestSyncLoginOnlyTalksToTheFirstHeadedPeer(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	chrome := startFakeExtension(t, bridge, "99999999-9999-4999-8999-999999999999", "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{{"tag": "H2", "url": "https://mine.test/background", "active": false}}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			return map[string]any{"cookies": []any{}}, nil
		}
		return map[string]any{}, nil
	})
	edge := startFakeExtension(t, bridge, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Mozilla/5.0 Chrome/157 Edg/157", func(call fakeCall) (any, error) {
		return map[string]any{"tabs": []map[string]any{{"tag": "E2", "url": "https://edge.test/background", "active": false}}}, nil
	})
	headlessID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	startFakeExtension(t, bridge, headlessID, "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		switch {
		case call.operation == "tabs":
			return map[string]any{"tabs": []map[string]any{{"tag": "C1", "url": "about:blank", "active": true}}}, nil
		case call.operation == "cdp" && call.args["method"] == "Network.getAllCookies":
			return map[string]any{"cookies": []any{
				map[string]any{"name": "agent", "value": "fresh", "domain": ".shop.test", "path": "/"},
			}}, nil
		}
		return map[string]any{}, nil
	})
	waitFor(t, func() bool {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		return len(bridge.clients) == 3
	})
	instance := &headlessChrome{dir: t.TempDir()}
	instance.setClientID(headlessID)
	previous := headlessBrowser.Load()
	headlessBrowser.Store(instance)
	defer headlessBrowser.Store(previous)
	bridge.borrowLogin(instance)
	hasWrite := func(peer *fakeExtension) bool {
		for _, call := range peer.recorded() {
			if call.operation == "cdp" && call.args["method"] == "Network.setCookies" {
				return true
			}
		}
		return false
	}
	if !hasWrite(chrome) {
		t.Fatalf("the headless login should be written into Chrome: %v", chrome.recorded())
	}
	if calls := edge.recorded(); len(calls) != 0 {
		t.Fatalf("another browser profile must never be touched: %v", calls)
	}
}

// 一条被 CDP 拒掉的 Cookie 不能拖死整批：逐条重试，能写的先落地。
func TestPushCookiesRetriesOneBadCookie(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	var written []any
	var writtenMu sync.Mutex
	clientID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	startFakeExtension(t, bridge, clientID, "Mozilla/5.0 Chrome/157", func(call fakeCall) (any, error) {
		if call.operation != "cdp" || call.args["method"] != "Network.setCookies" {
			return map[string]any{}, nil
		}
		params, _ := call.args["params"].(map[string]any)
		batch, _ := params["cookies"].([]any)
		for _, item := range batch {
			if cookie, _ := item.(map[string]any); cookie["name"] == "bad" {
				return nil, errors.New("Invalid cookie fields")
			}
		}
		writtenMu.Lock()
		written = append(written, batch...)
		writtenMu.Unlock()
		return map[string]any{}, nil
	})
	waitFor(t, func() bool {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		return len(bridge.clients) == 1
	})
	cookies := []map[string]any{
		{"name": "one", "value": "1", "domain": ".x.test", "path": "/"},
		{"name": "bad", "value": "2", "domain": ".x.test", "path": "/"},
		{"name": "two", "value": "3", "domain": ".x.test", "path": "/"},
	}
	applied, err := bridge.pushCookies(clientID, "C1", cookies)
	if applied != 2 || err == nil {
		t.Fatalf("the good cookies must still land: applied=%d err=%v", applied, err)
	}
	writtenMu.Lock()
	kept := len(written)
	writtenMu.Unlock()
	if kept != 2 {
		t.Fatalf("only the rejected cookie may be dropped, got %v", written)
	}
}

func waitFor(t *testing.T, ready func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if ready() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}
