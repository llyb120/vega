package main

// 无头浏览器：客户端自己拉起一个隐藏的 Chrome，用 CDP 把内置的 Vega Chrome 扩展装进去，并把本机
// Chrome 的登录态复制到它自己的 profile。参考 Nova 的 headless_browser.rs：设置里打开（默认）时
// chrome_* 工具改发给这个实例，用户自己的浏览器完全不被打扰；选「我自己的 Chrome」就用用户打开的浏览器。

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// 启动后等扩展连上来的上限（Chrome 冷启动 + 扩展 service worker 起来）。
	headlessStartTimeout = 25 * time.Second
	// 启动失败后至少等这么久再重试，避免连续的工具调用反复拉起一个起不来的 Chrome。
	headlessRetryAfter = 20 * time.Second
	// 扩展没取走命令前的最长等待：进程还在就再给它一次机会，不再拉第二个（同 profile 的第二个 Chrome 会直接退出）。
	headlessAttachGrace = 10 * time.Second
	// 这么久没人用浏览器就回收进程；profile 落盘，登录态不丢，下次用再拉起。
	headlessIdleReclaim = 15 * time.Minute
	// Chrome 写出 DevToolsActivePort 的时间。
	headlessPortWait = 15 * time.Second
	// 杀掉旧实例后等它退出的上限：这段时间不重写扩展副本。
	headlessExitWait = 5 * time.Second
)

// headlessBrowser 非 nil 表示设置里选的是「无头」（默认）；nil 表示用用户自己的浏览器。
var headlessBrowser atomic.Pointer[headlessChrome]

// headlessChrome 一个保持登录态的隐藏 Chrome。进程只在真正要用浏览器时才拉起。
type headlessChrome struct {
	dir       string                 // profile 目录（Chrome 的 --user-data-dir）
	extension func() (string, error) // 内置扩展解压目录
	// bridge 拉起时的桥接：停止时要把自己从它的实例表里摘掉。
	bridge *browserBridge

	mu       sync.Mutex
	cmd      *exec.Cmd
	done     chan struct{} // 进程真正退出的关闭信号（stop 用它等旧 Chrome 走干净）
	output   tailOutput
	failure  *headlessFailure
	lastUsed time.Time
	// client 本次启动写进扩展副本的 clientID：桥接只凭它认这个实例，不看 UA、也不看「新出现的客户端」。
	// 走原子值：status() 拿着 b.mu 时不能再去抢 h.mu。
	client atomic.Pointer[string]
	// lastLogin 上次从「你自己开的 Chrome」同步登录态的时间（每次启动重置，新实例重新借一次）。
	lastLogin time.Time
	// notice 只用来给界面一句提示，走原子值：status() 拿着 b.mu，不能再去抢 h.mu。
	notice atomic.Pointer[string]
}

// clientID 本次启动写进扩展副本的实例标识；空表示还没拉起过（或已停止）。
func (h *headlessChrome) clientID() string {
	if value := h.client.Load(); value != nil {
		return *value
	}
	return ""
}

func (h *headlessChrome) setClientID(id string) { h.client.Store(&id) }

// live 这次启动的实例是否已连上桥接：认 clientID，不认 UA 或「启动后新出现的客户端」。
func (h *headlessChrome) live(b *browserBridge) bool {
	id := h.clientID()
	return id != "" && b.headlessClient() == id
}

type headlessFailure struct {
	message string
	retryAt time.Time
}

// browserModeHeadless 设置里是否用客户端自己的无头 Chrome（默认）。
func (a *Agent) browserModeHeadless() bool { return a.config.BrowserMode != "real" }

// applyBrowserMode 把设置同步到桥接：无头模式装好启动器，选「我自己的 Chrome」立刻停掉自己拉起的那个。
func (a *Agent) applyBrowserMode() {
	if !a.browserModeHeadless() {
		headlessStop()
		return
	}
	if headlessBrowser.Load() != nil {
		return
	}
	headlessBrowser.Store(&headlessChrome{dir: filepath.Join(a.dataDir, "headless-browser"), extension: a.writeBundledExtension})
}

// headlessStop 停掉客户端自己拉起的 Chrome（切换设置、客户端退出时）。
func headlessStop() {
	if h := headlessBrowser.Swap(nil); h != nil {
		h.stop()
	}
}

// headlessReclaim 闲置回收：长时间没用就退出进程，下次用浏览器再拉起。
func headlessReclaim(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if h := headlessBrowser.Load(); h != nil && h.idle() {
				h.stop()
				h.note("无头浏览器闲置已回收；下次用浏览器时会自动重新启动，登录态保留")
			}
		}
	}
}

func (h *headlessChrome) idle() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	// 有会话正占着浏览器（回合还没结束）就不回收：杀掉它不会让那一轮自动重来，
	// 只会让下一次操作报「无头 Chrome 没有连上」，要用户再说一次「继续」。
	return h.cmd != nil && time.Since(h.lastUsed) > headlessIdleReclaim && (h.bridge == nil || !h.bridge.leased())
}

func (h *headlessChrome) touch() {
	h.mu.Lock()
	h.lastUsed = time.Now()
	h.mu.Unlock()
}

// loginDue 该不该再同步一次登录态：刚启动要借，之后每 loginBorrowEvery 一次。
func (h *headlessChrome) loginDue(now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lastLogin.IsZero() || now.Sub(h.lastLogin) >= loginBorrowEvery
}

// markLogin 记下这次同步的时间（成功与失败都记：不在同一轮里反复折腾用户的页签）。
func (h *headlessChrome) markLogin() {
	h.mu.Lock()
	h.lastLogin = time.Now()
	h.mu.Unlock()
}

// resetLogin 让下一轮立刻可以再同步（一轮浏览器操作结束时用）。
func (h *headlessChrome) resetLogin() {
	h.mu.Lock()
	h.lastLogin = time.Time{}
	h.mu.Unlock()
}

func (h *headlessChrome) note(text string) {
	h.notice.Store(&text)
}

func (h *headlessChrome) currentNotice() string {
	if text := h.notice.Load(); text != nil {
		return *text
	}
	return ""
}

func (h *headlessChrome) stop() {
	h.mu.Lock()
	cmd, done := h.stopLocked()
	h.failure = nil
	h.mu.Unlock()
	// 等旧进程真的退出：下次启动要整份重写 <user-data-dir>/extension，旧 Chrome 还握着文件时 Windows 会拒绝。
	waitHeadlessExit(cmd, done, headlessExitWait)
}

// waitHeadlessExit 等被杀的进程真正退出（最多 timeout）。没有进程或没有信号就立即返回。
func waitHeadlessExit(cmd *exec.Cmd, done chan struct{}, timeout time.Duration) {
	if cmd == nil || done == nil {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
}

func (h *headlessChrome) stopLocked() (*exec.Cmd, chan struct{}) {
	cmd, done := h.cmd, h.done
	h.cmd, h.done = nil, nil
	// 进程被杀掉后扩展不会再轮询，但它在桥接里要留到 45 秒过期：立刻摘掉，
	// 否则 status() 报已连接、ensure() 也以为还活着，下一次操作要卡到取命令超时。
	if id := h.clientID(); id != "" {
		h.setClientID("")
		if h.bridge != nil {
			h.bridge.forget(id)
		}
	}
	if cmd == nil {
		return nil, nil
	}
	// configureCommand 在 Windows 上给的是 taskkill /T /F，渲染进程一起收掉。
	if cmd.Cancel != nil {
		_ = cmd.Cancel()
		return cmd, done
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	return cmd, done
}

// saveBrowserMode 保存「浏览器」设置（无头 / 我自己的 Chrome）并立刻生效。
func (a *Agent) saveBrowserMode(mode string) error {
	if mode != "headless" && mode != "real" {
		return fmt.Errorf("浏览器设置只能是 headless 或 real")
	}
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.BrowserMode = mode
	err := a.saveConfig(next)
	if err == nil {
		a.config = next
	}
	a.mu.Unlock()
	if err != nil {
		return fmt.Errorf("浏览器设置未保存：%w", err)
	}
	a.applyBrowserMode()
	return nil
}

// ensure 保证有一个连上扩展的无头 Chrome：没有就现拉（只在真正要用浏览器时拉起）。
func (h *headlessChrome) ensure(b *browserBridge, ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.bridge = b
	if h.live(b) {
		h.lastUsed = time.Now()
		return nil
	}
	if h.cmd != nil {
		if err := h.await(b, ctx, headlessAttachGrace); err == nil {
			h.lastUsed = time.Now()
			return nil
		}
		return errors.New("无头 Chrome 还在启动，但扩展没有连上来；稍后重试，或在「设置 → 浏览器」改用「我自己的 Chrome」")
	}
	if h.failure != nil && time.Now().Before(h.failure.retryAt) {
		return errors.New(h.failure.message)
	}
	if err := h.launch(b, ctx); err != nil {
		h.stopLocked()
		h.failure = &headlessFailure{message: err.Error(), retryAt: time.Now().Add(headlessRetryAfter)}
		return err
	}
	h.failure = nil
	h.lastUsed = time.Now()
	return nil
}

func (h *headlessChrome) launch(b *browserBridge, ctx context.Context) error {
	binary := headlessChromeBinary()
	if binary == "" {
		return errors.New("无头浏览器需要本机安装 Google Chrome（也可以用环境变量 VEGA_CHROME_PATH 指定 chrome.exe）；或在「设置 → 浏览器」改用「我自己的 Chrome」")
	}
	extension, err := h.extension()
	if err != nil {
		return errors.New("内置扩展解压失败：" + err.Error())
	}
	if err = os.MkdirAll(h.dir, 0o700); err != nil {
		return errors.New("创建无头浏览器目录失败：" + err.Error())
	}
	// 每次启动一个新 UUID，写死进这次要加载的扩展副本：扩展连回来时桥接凭它认这个实例。
	clientID, err := newClientID()
	if err != nil {
		return errors.New("生成无头实例标识失败：" + err.Error())
	}
	patched, err := h.patchExtension(extension, clientID)
	if err != nil {
		return err
	}
	h.setClientID(clientID)
	h.seedLogin()
	// 新实例重新借一次登录态：期间你在自己 Chrome 里新登录的站点就跟着进来。
	h.lastLogin = time.Time{}
	// 上次异常退出可能留下指向旧端口的 DevToolsActivePort。
	_ = os.Remove(filepath.Join(h.dir, "DevToolsActivePort"))
	args := []string{
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		// 宽度按常见桌面给、高度拉高：截图一屏能看到更多内容。
		"--window-size=1440,1800",
		// 只留给本机 CDP 加载扩展用；端口随机且只绑 127.0.0.1。
		"--remote-debugging-port=0",
		// Chrome 137+ 不再支持 --load-extension，扩展只能由 CDP 加载；加了 --load-extension /
		// --disable-extensions-except 反而会让扩展「加载成功但完全不启动」。
		"--enable-unsafe-extension-debugging",
		// 不用 "started debugging this browser" 那条调试横栏：无头也会出现，扩展每次 attach 都把视口
		// 压矮 56px，前后两次截图/坐标就对不上。这个 profile 里只有 Vega 扩展，隐藏它是安全的。
		"--silent-debugger-extension-api",
		"--user-data-dir=" + h.dir,
		"about:blank",
	}
	// CommandContext 只为了让 configureCommand 能设置 Cancel（收进程树用），context 本身不参与取消。
	cmd := exec.CommandContext(context.Background(), binary, args...)
	cmd.Dir = h.dir
	configureCommand(cmd)
	h.output.reset()
	cmd.Stderr = &h.output
	if err = cmd.Start(); err != nil {
		return errors.New("启动无头 Chrome 失败：" + err.Error())
	}
	h.cmd = cmd
	done := make(chan struct{})
	h.done = done
	go func() {
		_ = cmd.Wait()
		h.mu.Lock()
		if h.cmd == cmd {
			h.cmd, h.done = nil, nil
		}
		h.mu.Unlock()
		close(done)
	}()
	h.note("")
	// 加载失败不算致命：扩展可能已在 profile 里，下面等它连上来才算成功。
	if port, path, portErr := waitDevToolsPort(filepath.Join(h.dir, "DevToolsActivePort"), headlessPortWait); portErr != nil {
		h.note(portErr.Error())
	} else if loadErr := loadUnpacked(port, path, patched); loadErr != nil {
		h.note("扩展加载失败：" + loadErr.Error())
	}
	return h.await(b, ctx, headlessStartTimeout)
}

// workerClientIDLine 是内置扩展 worker.js 里生成实例标识的那一行；无头实例把它替换成固定 UUID。
const workerClientIDLine = "clientId: crypto.randomUUID(),"

// patchExtension 把内置扩展复制到 <user-data-dir>/extension，并把这次启动的 clientID 写死进 worker.js：
// 扩展连回来时只凭这个 UUID 认实例。manifest 不动（扩展 ID 由它的 key 决定，要保持稳定）。
func (h *headlessChrome) patchExtension(source, clientID string) (string, error) {
	target := filepath.Join(h.dir, "extension")
	if err := os.RemoveAll(target); err != nil {
		return "", errors.New("清理无头浏览器扩展目录失败：" + err.Error())
	}
	if err := copyExtension(source, target); err != nil {
		return "", errors.New("复制内置扩展失败：" + err.Error())
	}
	worker := filepath.Join(target, "worker.js")
	text, err := os.ReadFile(worker)
	if err != nil {
		return "", errors.New("读不到内置扩展的 worker.js：" + err.Error())
	}
	// 源码里找不到那一行就不猜：宁可不启动，也不能悄悄回到「看着像无头」的启发式。
	if !bytes.Contains(text, []byte(workerClientIDLine)) {
		_ = os.RemoveAll(target)
		return "", errors.New("内置扩展协议已变（worker.js 里没有 " + workerClientIDLine + "），请先更新客户端")
	}
	patched := bytes.Replace(text, []byte(workerClientIDLine), []byte(`clientId: "`+clientID+`",`), 1)
	if err = os.WriteFile(worker, patched, 0o600); err != nil {
		return "", errors.New("写入无头浏览器扩展失败：" + err.Error())
	}
	return target, nil
}

// copyExtension 整份复制扩展（目录 0700、文件 0600）；任何文件失败都算失败，不用半份扩展去启动。
func copyExtension(from, to string) error {
	if err := os.MkdirAll(to, 0o700); err != nil {
		return err
	}
	return filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, path)
		if err != nil || rel == "." {
			return err
		}
		target := filepath.Join(to, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
}

// newClientID 生成扩展用的 UUID v4（8-4-4-4-12，版本位 4）。
func newClientID() (string, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return "", err
	}
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16]), nil
}

// await 等这次启动的实例（写死进扩展副本的 clientID）连上来：别人的 Chrome 连上来不算。
func (h *headlessChrome) await(b *browserBridge, ctx context.Context, timeout time.Duration) error {
	clientID := h.clientID()
	if clientID == "" {
		return errors.New("无头浏览器没有生成实例标识，请重试；没有执行任何网页操作")
	}
	started := time.Now()
	for time.Since(started) < timeout {
		if b.headlessClient() == clientID {
			return nil
		}
		if h.cmd == nil {
			return h.exitError()
		}
		select {
		case <-ctx.Done():
			return errors.New("无头浏览器启动已取消；没有执行任何网页操作")
		case <-time.After(200 * time.Millisecond):
		}
	}
	hint := ""
	if tail := h.output.tail(); tail != "" {
		hint = "；stderr：" + tail
	}
	if notice := h.currentNotice(); notice != "" {
		hint += "；" + notice
	}
	return errors.New("无头 Chrome 已经启动，但扩展没连上来：请确认本机 Chrome 版本 ≥125" + hint)
}

func (h *headlessChrome) exitError() error {
	message := "无头 Chrome 启动后立即退出：这个 profile 可能正被另一个 Chrome 占用，请重试"
	if tail := h.output.tail(); tail != "" {
		message += "；stderr：" + tail
	}
	return errors.New(message)
}

// seedLogin 把本机 Chrome 的登录态尽力复制进无头 profile。真实 Chrome 正在运行时个别文件被占用，
// 复制不到就跳过（下次启动再试），不阻塞启动。
// shortcut: 只认 Default profile，也不从运行中的 Chrome 用 CDP 补 cookie；要多 profile 时再按 Local State 选择。
func (h *headlessChrome) seedLogin() {
	source := chromeUserDataDir()
	if source == "" {
		return
	}
	for _, parts := range [][]string{
		{"Local State"},
		{"Default", "Cookies"}, {"Default", "Cookies-journal"}, {"Default", "Cookies-wal"},
		{"Default", "Network", "Cookies"}, {"Default", "Network", "Cookies-journal"}, {"Default", "Network", "Cookies-wal"},
		{"Default", "Local Storage"}, {"Default", "Session Storage"}, {"Default", "IndexedDB"}, {"Default", "Web Data"},
	} {
		from := filepath.Join(append([]string{source}, parts...)...)
		if _, err := os.Stat(from); err != nil {
			continue
		}
		_ = copyLoginState(from, filepath.Join(append([]string{h.dir}, parts...)...))
	}
}

// copyLoginState 复制文件或目录；leveldb 的 LOCK 是进程锁，复制过去只会占住目标目录。
func copyLoginState(from, to string) error {
	st, err := os.Stat(from)
	if err != nil {
		return err
	}
	if st.IsDir() {
		if err = os.MkdirAll(to, 0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Name() == "LOCK" {
				continue
			}
			_ = copyLoginState(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name()))
		}
		return nil
	}
	if !st.Mode().IsRegular() {
		return nil
	}
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		return err
	}
	return os.WriteFile(to, data, 0o600)
}

func chromeUserDataDir() string {
	switch runtime.GOOS {
	case "windows":
		if base := os.Getenv("LOCALAPPDATA"); base != "" {
			return filepath.Join(base, "Google", "Chrome", "User Data")
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
		}
	default:
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".config", "google-chrome")
		}
	}
	return ""
}

func headlessChromeBinary() string {
	if path := os.Getenv("VEGA_CHROME_PATH"); path != "" {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	candidates := []string{}
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if base != "" {
				candidates = append(candidates, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
		if local != "" {
			candidates = append(candidates, filepath.Join(local, "Google", "Chrome", "Application", "chrome.exe"))
		}
	case "darwin":
		candidates = append(candidates, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
	default:
		candidates = append(candidates, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser")
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// waitDevToolsPort 等 Chrome 写出 DevToolsActivePort（第一行端口，第二行浏览器级 ws 路径）。
func waitDevToolsPort(file string, timeout time.Duration) (int, string, error) {
	for deadline := time.Now().Add(timeout); time.Now().Before(deadline); time.Sleep(150 * time.Millisecond) {
		text, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(text)), "\n")
		if len(lines) < 2 {
			continue
		}
		port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
		if err == nil && port > 0 {
			return port, strings.TrimSpace(lines[1]), nil
		}
	}
	return 0, "", errors.New("读不到无头 Chrome 的调试端口（可能被同 profile 的残留 Chrome 占用）")
}

// loadUnpacked 用 CDP 让这个无头 Chrome 加载扩展；本机只走 127.0.0.1 的随机调试端口。
func loadUnpacked(port int, path, extension string) error {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	request := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		path, port, base64.StdEncoding.EncodeToString(key))
	if _, err = io.WriteString(conn, request); err != nil {
		return err
	}
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		return err
	}
	if !strings.Contains(status, " 101") {
		return fmt.Errorf("CDP 握手失败：%s", strings.TrimSpace(status))
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	payload, err := json.Marshal(map[string]any{"id": 1, "method": "Extensions.loadUnpacked", "params": map[string]string{"path": extension}})
	if err != nil {
		return err
	}
	if err = writeWebSocketText(conn, payload); err != nil {
		return err
	}
	for {
		opcode, data, err := readWebSocketFrame(reader)
		if err != nil {
			return err
		}
		if opcode != 1 || len(data) == 0 {
			continue
		}
		var reply struct {
			ID    int `json:"id"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &reply) != nil || reply.ID != 1 {
			continue
		}
		if reply.Error != nil {
			return errors.New(reply.Error.Message)
		}
		return nil
	}
}

// writeWebSocketText 一个客户端文本帧（必须加掩码）。
func writeWebSocketText(w io.Writer, payload []byte) error {
	frame := []byte{0x81}
	n := len(payload)
	switch {
	case n < 126:
		frame = append(frame, byte(n)|0x80)
	case n < 65536:
		frame = append(frame, 126|0x80, byte(n>>8), byte(n))
	default:
		frame = append(frame, 127|0x80, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	mask := make([]byte, 4)
	_, _ = rand.Read(mask)
	frame = append(frame, mask...)
	for i, value := range payload {
		frame = append(frame, value^mask[i%4])
	}
	_, err := w.Write(frame)
	return err
}

// readWebSocketFrame 只解一个帧（服务端发来的帧不带掩码）；分片和 ping/pong 直接跳过。
func readWebSocketFrame(r *bufio.Reader) (byte, []byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, err
	}
	opcode := head[0] & 0x0f
	size := uint64(head[1] & 0x7f)
	switch size {
	case 126:
		extended := make([]byte, 2)
		if _, err := io.ReadFull(r, extended); err != nil {
			return 0, nil, err
		}
		size = uint64(binary.BigEndian.Uint16(extended))
	case 127:
		extended := make([]byte, 8)
		if _, err := io.ReadFull(r, extended); err != nil {
			return 0, nil, err
		}
		size = binary.BigEndian.Uint64(extended)
	}
	if size > 8<<20 {
		return 0, nil, errors.New("CDP 响应过大")
	}
	var mask []byte
	if head[1]&0x80 != 0 {
		mask = make([]byte, 4)
		if _, err := io.ReadFull(r, mask); err != nil {
			return 0, nil, err
		}
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return 0, nil, err
	}
	for i := range data {
		if mask != nil {
			data[i] ^= mask[i%4]
		}
	}
	return opcode, data, nil
}

// tailOutput 只留最后一点 Chrome 的 stderr：启动失败时这几行是唯一的线索。
type tailOutput struct {
	mu   sync.Mutex
	data []byte
}

const tailOutputLimit = 4096

func (t *tailOutput) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.data = append(t.data, p...)
	if len(t.data) > tailOutputLimit {
		t.data = t.data[len(t.data)-tailOutputLimit:]
	}
	return len(p), nil
}

func (t *tailOutput) reset() {
	t.mu.Lock()
	t.data = nil
	t.mu.Unlock()
}

// tail 最后几行（去掉空行），Chrome 的报错都在最后。
func (t *tailOutput) tail() string {
	t.mu.Lock()
	text := string(t.data)
	t.mu.Unlock()
	lines := []string{}
	for _, line := range strings.Split(text, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) > 6 {
		lines = lines[len(lines)-6:]
	}
	return strings.Join(lines, " | ")
}
