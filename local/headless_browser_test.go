package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const headlessPeerID = "aaaaaaaa-1111-4111-8111-111111111111"
const realPeerID = "bbbbbbbb-2222-4222-8222-222222222222"

// twoBrowsers 客户端自己拉起的一个无头实例（只认 launch 写进扩展副本的 clientID）加上用户自己的 Chrome。
func twoBrowsers(t *testing.T) (*browserBridge, *headlessChrome) {
	t.Helper()
	b := newBrowserBridge()
	b.clients[realPeerID] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	// 无头实例在 /poll 时就被认出（headless=true），切回有头模式也不能被当成你的浏览器。
	b.clients[headlessPeerID] = browserPeer{lastAt: time.Now(), browser: "Google Chrome", headless: true}
	h := &headlessChrome{}
	h.setClientID(headlessPeerID)
	headlessBrowser.Store(h)
	t.Cleanup(func() { headlessBrowser.Store(nil) })
	return b, h
}

// 无头模式只认本次启动的那个 clientID，有头模式只认用户自己的浏览器：无头实例的 UA 同样是 Chrome。
func TestBrowserRoutesToHeadlessOnlyInHeadlessMode(t *testing.T) {
	b, _ := twoBrowsers(t)
	status := b.status()
	if status["connected"] != true || status["headless"] != true || status["mode"] != "headless" {
		t.Fatal("headless mode did not pick the headless instance", status)
	}
	if b.primaryID != headlessPeerID {
		t.Fatal("headless mode kept the user's browser as primary", b.primaryID)
	}
	if labels, ok := status["browsers"].([]string); !ok || len(labels) != 2 || !strings.Contains(labels[0], "（无头）") || strings.Contains(labels[1], "（无头）") {
		t.Fatal("connected browsers must be labelled headless/real separately", status["browsers"])
	}
	headlessBrowser.Store(nil)
	status = b.status()
	if status["headless"] != false || status["mode"] != "real" {
		t.Fatal("real mode still reported the headless instance", status)
	}
	if b.primaryID != realPeerID {
		t.Fatal("real mode did not fall back to the user's browser", b.primaryID)
	}
	// 无头模式开着但无头实例没连上：不能把用户的浏览器当成无头用。
	headlessBrowser.Store(&headlessChrome{})
	delete(b.clients, headlessPeerID)
	b.primaryID = ""
	if status = b.status(); status["connected"] != false {
		t.Fatal("headless mode silently used the user's browser", status)
	}
}

// 路由只认本次启动的 clientID：用户自己的 Chrome 即使被旧版/UA 打上了无头标记，也不会被叫成无头实例；
// 自己的实例断了也不能退回你的浏览器。
func TestHeadlessClientIsBoundToTheLaunchedClientID(t *testing.T) {
	b, h := twoBrowsers(t)
	// 有头模式：你自己的浏览器才是 primary，我们拉起的那个不算。
	headlessBrowser.Store(nil)
	b.primaryID = ""
	if status := b.status(); status["connected"] != true || status["headless"] != false || b.primaryID != realPeerID {
		t.Fatalf("real mode did not fall back to the user's browser: %v (%q)", status, b.primaryID)
	}
	headlessBrowser.Store(h)
	b.mu.Lock()
	peer := b.clients[realPeerID]
	peer.headless = true // 旧版按 UA 打上的标记：不能拿来认无头
	b.clients[realPeerID] = peer
	b.mu.Unlock()
	if got := b.headlessClient(); got != headlessPeerID {
		t.Fatalf("user Chrome was taken for the headless instance: %q", got)
	}
	if status := b.status(); status["headless"] != true || b.primaryID != headlessPeerID {
		t.Fatalf("headless mode bound the wrong browser: %v (%q)", status, b.primaryID)
	}
	// 自己的实例断开：宁可报未连接，也不能落回用户的浏览器。
	delete(b.clients, headlessPeerID)
	b.primaryID = ""
	if got := b.headlessClient(); got != "" {
		t.Fatalf("headless client survived its own disconnect: %q", got)
	}
	if status := b.status(); status["connected"] != false || status["headless"] != false {
		t.Fatalf("headless mode fell back to the user's browser: %v", status)
	}
}

// /poll 只凭 clientID 认无头实例：扩展的 UA 不带 HeadlessChrome 也算，用户 Chrome 带了也不算。
func TestPollMarksHeadlessByClientID(t *testing.T) {
	bridge := newBrowserBridge()
	server, err := bridge.start()
	if err != nil {
		t.Skipf("loopback bridge busy: %v", err)
	}
	defer server.Close()
	h := &headlessChrome{}
	h.setClientID(headlessPeerID)
	headlessBrowser.Store(h)
	defer headlessBrowser.Store(nil)
	startFakeExtension(t, bridge, realPeerID, "Mozilla/5.0 HeadlessChrome/157", func(fakeCall) (any, error) { return nil, nil })
	startFakeExtension(t, bridge, headlessPeerID, "Mozilla/5.0 Chrome/157", func(fakeCall) (any, error) { return nil, nil })
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		bridge.mu.Lock()
		ready := len(bridge.clients) == 2
		bridge.mu.Unlock()
		if ready {
			break
		}
	}
	bridge.mu.Lock()
	ours, users := bridge.clients[headlessPeerID].headless, bridge.clients[realPeerID].headless
	bridge.mu.Unlock()
	if !ours || users {
		t.Fatalf("headless must follow the clientID, not the user agent: ours=%v users=%v", ours, users)
	}
	if got := bridge.headlessClient(); got != headlessPeerID {
		t.Fatalf("bridge bound the wrong instance: %q", got)
	}
}

// 无头模式开着、但浏览器起不来：直接报错，不静默改用别的浏览器。
func TestUnavailableHeadlessBrowserReportsFailureInsteadOfSwitching(t *testing.T) {
	b, _ := twoBrowsers(t)
	delete(b.clients, headlessPeerID)
	headlessBrowser.Store(&headlessChrome{dir: t.TempDir(), failure: &headlessFailure{message: "无头 Chrome 起不来", retryAt: time.Now().Add(time.Minute)}})
	defer headlessBrowser.Store(nil)
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := b.execute(owner, owner, browserJob("tabs", browserSession))
	if result["status"] != "unavailable" || !strings.Contains(result["error"].(string), "无头 Chrome 起不来") {
		t.Fatal("expected the headless failure, not a silent fallback", result)
	}
	// acquire 同样不能落到用户的浏览器上。
	if result = b.execute(owner, owner, browserJob("acquire", browserSession)); result["status"] != "unavailable" {
		t.Fatal("acquire fell back to the user's browser", result)
	}
	// status 只报告，不拉起浏览器。
	if result = b.execute(owner, owner, browserJob("status", browserSession)); result["result"] == nil {
		t.Fatal("status must not fail because the headless browser is down", result)
	}
}

func TestNoHeadlessLauncherKeepsUsingUserBrowser(t *testing.T) {
	headlessBrowser.Store(nil)
	b := connectedBrowser()
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := b.ensureHeadless(owner); err != nil {
		t.Fatal(err)
	}
	if result := b.execute(owner, owner, browserJob("acquire", browserSession)); result["error"] != nil {
		t.Fatal("real mode stopped working", result)
	}
}

func TestDevToolsActivePortIsRead(t *testing.T) {
	file := filepath.Join(t.TempDir(), "DevToolsActivePort")
	if _, _, err := waitDevToolsPort(file, 200*time.Millisecond); err == nil {
		t.Fatal("missing DevToolsActivePort must fail, not wait forever")
	}
	if err := os.WriteFile(file, []byte("51517\n/devtools/browser/6f0c\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	port, path, err := waitDevToolsPort(file, time.Second)
	if err != nil || port != 51517 || path != "/devtools/browser/6f0c" {
		t.Fatalf("unexpected DevToolsActivePort: %d %q %v", port, path, err)
	}
}

// 本机 Chrome 登录态复制进无头 profile：目录递归复制，leveldb 的 LOCK 不复制。
func TestLoginStateCopySkipsLevelDBLocks(t *testing.T) {
	source, target := t.TempDir(), t.TempDir()
	web := filepath.Join(source, "Default", "Local Storage")
	if err := os.MkdirAll(web, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		filepath.Join(web, "000001.log"): "log",
		filepath.Join(web, "LOCK"):       "lock",
	} {
		if err := os.WriteFile(name, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := copyLoginState(filepath.Join(source, "Default"), filepath.Join(target, "Default")); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "Default", "Local Storage", "000001.log")); err != nil || string(data) != "log" {
		t.Fatal("nested login state was not copied", err)
	}
	if _, err := os.Stat(filepath.Join(target, "Default", "Local Storage", "LOCK")); !os.IsNotExist(err) {
		t.Fatal("the leveldb LOCK file must not be copied")
	}
}

// seedLogin 只认本机 Chrome 的用户目录；不同平台目录位置不同，测试按平台拼。
func TestSeedLoginCopiesLocalChromeIntoHeadlessProfile(t *testing.T) {
	base := t.TempDir()
	var userData string
	switch runtime.GOOS {
	case "windows":
		t.Setenv("LOCALAPPDATA", base)
		userData = filepath.Join(base, "Google", "Chrome", "User Data")
	case "darwin":
		t.Setenv("HOME", base)
		userData = filepath.Join(base, "Library", "Application Support", "Google", "Chrome")
	default:
		t.Setenv("HOME", base)
		userData = filepath.Join(base, ".config", "google-chrome")
	}
	if err := os.MkdirAll(filepath.Join(userData, "Default", "Network"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		filepath.Join(userData, "Local State"):                   "{}",
		filepath.Join(userData, "Default", "Network", "Cookies"): "cookies",
	} {
		if err := os.WriteFile(name, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	profile := t.TempDir()
	(&headlessChrome{dir: profile}).seedLogin()
	for _, parts := range [][]string{{"Local State"}, {"Default", "Network", "Cookies"}} {
		if _, err := os.Stat(filepath.Join(append([]string{profile}, parts...)...)); err != nil {
			t.Fatalf("login state %v not seeded: %v", parts, err)
		}
	}
}

// 加载扩展只用一帧文本 + 一帧回包，这里验证编解码本身不会把内容弄坏。
func TestWebSocketTextFrameRoundtrip(t *testing.T) {
	for _, payload := range [][]byte{[]byte(`{"id":1}`), bytes.Repeat([]byte("x"), 300)} {
		var frame bytes.Buffer
		if err := writeWebSocketText(&frame, payload); err != nil {
			t.Fatal(err)
		}
		opcode, data, err := readWebSocketFrame(bufio.NewReader(&frame))
		if err != nil || opcode != 1 || !bytes.Equal(data, payload) {
			t.Fatalf("frame %d bytes did not roundtrip (opcode %d, %v)", len(payload), opcode, err)
		}
	}
}

// 切换设置 / 退出时的 stop 要能重复调用，并把启动失败的重试退避清掉（否则切回无头会白等 20 秒）。
func TestHeadlessStopClearsRetryBackoff(t *testing.T) {
	headless := &headlessChrome{dir: t.TempDir(), failure: &headlessFailure{message: "x", retryAt: time.Now().Add(time.Minute)}}
	headless.stop()
	headless.stop()
	if headless.failure != nil {
		t.Fatal("stop kept the retry backoff")
	}
}

// 扩展副本里写死这次的 clientID，manifest 原样保留；源目录（用户手动加载的那份）不能被改。
func TestPatchedExtensionCarriesThisLaunchClientID(t *testing.T) {
	source, err := filepath.Abs(filepath.Join("extension", "vega-chrome"))
	if err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(filepath.Join(source, "worker.js"))
	if err != nil {
		t.Fatalf("bundled extension missing: %v", err)
	}
	if !bytes.Contains(text, []byte(workerClientIDLine)) {
		t.Fatal("bundled worker.js lost the clientId line the headless launcher patches")
	}
	id, err := newClientID()
	if err != nil || !extensionClientID.MatchString(id) {
		t.Fatalf("generated id is not an extension client id: %q %v", id, err)
	}
	h := &headlessChrome{dir: filepath.Join(t.TempDir(), "profile")}
	target, err := h.patchExtension(source, id)
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(h.dir, "extension") {
		t.Fatalf("the launch must load its own copy, got %q", target)
	}
	patched, err := os.ReadFile(filepath.Join(target, "worker.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(patched, []byte(`clientId: "`+id+`",`)) {
		t.Fatal("the copy does not carry this launch's clientID")
	}
	if bytes.Contains(patched, []byte(workerClientIDLine)) {
		t.Fatal("the random clientId line survived patching")
	}
	if after, readErr := os.ReadFile(filepath.Join(source, "worker.js")); readErr != nil || !bytes.Contains(after, []byte(workerClientIDLine)) {
		t.Fatal("patching modified the bundled extension in place")
	}
	var manifest struct {
		ManifestVersion int    `json:"manifest_version"`
		Key             string `json:"key"`
		Background      struct {
			ServiceWorker string `json:"service_worker"`
		} `json:"background"`
	}
	data, err := os.ReadFile(filepath.Join(target, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("the copied manifest is not loadable: %v", err)
	}
	if manifest.ManifestVersion != 3 || manifest.Key == "" || manifest.Background.ServiceWorker != "worker.js" {
		t.Fatalf("the copied manifest changed: %+v", manifest)
	}
	if entries, err := os.ReadDir(target); err != nil || len(entries) < 5 {
		t.Fatalf("the extension copy is incomplete: %v %v", entries, err)
	}
	// 再启动一次换新 ID：旧文件不能残留。
	next, err := newClientID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.patchExtension(source, next); err != nil {
		t.Fatal(err)
	}
	if patched, err = os.ReadFile(filepath.Join(target, "worker.js")); err != nil || bytes.Contains(patched, []byte(id)) {
		t.Fatalf("a stale client id survived the next launch: %v", err)
	}
	// Windows 不保留 POSIX 权限位，只在类 Unix 上校验。
	if runtime.GOOS != "windows" {
		for _, name := range []string{"worker.js", "manifest.json"} {
			if info, err := os.Stat(filepath.Join(target, name)); err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("%s must be 0600: %v %v", name, info, err)
			}
		}
		if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("the extension copy must be 0700: %v %v", info, err)
		}
	}
}

// worker.js 协议变了就不猜：宁可启动失败，也不能静默回到启发式。
func TestPatchExtensionRefusesAChangedWorkerProtocol(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "worker.js"), []byte("const model = {clientId: uuidv4(), next: 1};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &headlessChrome{dir: filepath.Join(t.TempDir(), "profile")}
	_, err := h.patchExtension(source, headlessPeerID)
	if err == nil || !strings.Contains(err.Error(), "内置扩展协议已变") {
		t.Fatalf("a changed worker protocol must fail loudly, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(h.dir, "extension")); statErr == nil {
		t.Fatal("a half-patched extension copy must not be left behind")
	}
}

// 停掉无头浏览器要立刻把它从桥接里摘掉；否则 status 报已连接，ensure 也不再重新拉起。
func TestStopForgetsTheInstanceAndRelaunches(t *testing.T) {
	b, h := twoBrowsers(t)
	h.bridge = b
	h.cmd = &exec.Cmd{}
	b.queues[headlessPeerID] = make(chan *browserCommand, 1)
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	launches := 0
	h.extension = func() (string, error) { launches++; return "", os.ErrNotExist }
	binary := filepath.Join(t.TempDir(), "chrome")
	if err := os.WriteFile(binary, []byte("stub"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VEGA_CHROME_PATH", binary)
	// 还连着：不能重新启动。
	if err := h.ensure(b, owner); err != nil {
		t.Fatalf("a connected instance must be reused: %v", err)
	}
	if launches != 0 {
		t.Fatal("ensure relaunched a connected browser")
	}
	h.stop()
	if _, ok := b.clients[headlessPeerID]; ok {
		t.Fatal("stop left the instance in the bridge")
	}
	if _, ok := b.queues[headlessPeerID]; ok {
		t.Fatal("stop left the command queue behind")
	}
	if got := b.headlessClient(); got != "" {
		t.Fatalf("stopped instance still reported as headless: %q", got)
	}
	if status := b.status(); status["connected"] != false {
		t.Fatalf("stopped instance still reported as connected: %v", status)
	}
	// 停掉之后必须真的重新拉起（而不是以为还活着），失败也走回退避。
	err := h.ensure(b, owner)
	if err == nil || !strings.Contains(err.Error(), "内置扩展解压失败") {
		t.Fatalf("ensure did not try a new launch: %v", err)
	}
	if launches != 1 {
		t.Fatalf("expected exactly one launch attempt, got %d", launches)
	}
	if again := h.ensure(b, owner); again == nil || launches != 1 {
		t.Fatalf("a failed launch must back off instead of retrying: %v (%d launches)", again, launches)
	}
}

// await 只等这次启动的那个 clientID：用户自己的 Chrome 先连上来不算数。
func TestAwaitWaitsForItsOwnClientID(t *testing.T) {
	b := newBrowserBridge()
	b.clients[realPeerID] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	h := &headlessChrome{cmd: &exec.Cmd{}}
	h.setClientID(headlessPeerID)
	headlessBrowser.Store(h)
	defer headlessBrowser.Store(nil)
	err := h.await(b, context.Background(), 300*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "扩展没连上来") {
		t.Fatalf("await accepted another Chrome as the headless instance: %v", err)
	}
	b.clients[headlessPeerID] = browserPeer{lastAt: time.Now(), browser: "Google Chrome"}
	if err = h.await(b, context.Background(), time.Second); err != nil {
		t.Fatalf("await missed its own instance: %v", err)
	}
}

// 杀掉无头 Chrome 后要等它真的退出，才能重写 <user-data-dir>/extension：旧进程还握着文件时
// Windows 会拒绝复制/删除，下一次启动就白白退避 20 秒。
func TestStopWaitsForTheBrowserProcessToExit(t *testing.T) {
	delayed := make(chan struct{})
	go func() { time.Sleep(120 * time.Millisecond); close(delayed) }()
	started := time.Now()
	waitHeadlessExit(exec.Command(os.Args[0]), delayed, time.Second)
	if time.Since(started) < 100*time.Millisecond {
		t.Fatal("waitHeadlessExit returned before the browser exited")
	}
	// 一直不退出时按上限返回，不能把回收/退出卡死。
	started = time.Now()
	waitHeadlessExit(exec.Command(os.Args[0]), make(chan struct{}), 50*time.Millisecond)
	if elapsed := time.Since(started); elapsed < 50*time.Millisecond || elapsed > time.Second {
		t.Fatalf("waitHeadlessExit timeout = %v", elapsed)
	}
	waitHeadlessExit(nil, nil, time.Second)

	// stop 交出 cmd/done 后必须等到进程退出才返回（stopLocked 自己不能等：cmd.Wait 那条 goroutine 还要抢 h.mu）。
	done := make(chan struct{})
	h := &headlessChrome{cmd: exec.Command(os.Args[0]), done: done}
	stopped := make(chan struct{})
	go func() { h.stop(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("stop returned while the old browser was still exiting")
	case <-time.After(100 * time.Millisecond):
	}
	close(done)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("stop did not return after the browser exited")
	}
}

// 回合中途（有会话占着浏览器）不回收：杀掉无头实例不会让那一轮自动重来，
// 只会让下一次操作报「无头 Chrome 没有连上」。
func TestReclaimSkipsAHeadlessBrowserHeldByASession(t *testing.T) {
	b, h := twoBrowsers(t)
	h.mu.Lock()
	h.cmd = exec.Command(os.Args[0])
	h.lastUsed = time.Now().Add(-2 * headlessIdleReclaim)
	h.bridge = b
	h.mu.Unlock()
	if !h.idle() {
		t.Fatal("an idle headless browser should be reclaimable")
	}
	b.mu.Lock()
	b.connection, b.session = context.Background(), realPeerID
	b.mu.Unlock()
	if h.idle() {
		t.Fatal("a headless browser held by a running turn must not be reclaimed")
	}
}
