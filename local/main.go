// Vega local execution agent. The website is used only for initial authorization.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	localAddress = "127.0.0.1:47673"
	maxBody      = 48 << 20
	maxOutput    = 2 << 20
)

type Agent struct {
	mu              sync.Mutex
	config          Config
	configPath      string
	dataDir         string
	pinnedOrigin    string
	configToken     string
	pendingOrigins  map[string]bool
	connections     map[*websocket.Conn]struct{}
	direct          map[string]*directConnection
	resumeInstances map[string]string
	updating        bool
	editing         bool
	context         context.Context
	lastSite        string
}

func main() {
	detachConsole()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version":
			fmt.Println(clientVersion)
			return
		case "--apply-update":
			must(applyUpdate(os.Args[2:]))
			return
		case "--butterfly-preview":
			// 只为看气泡与任务栏蝴蚋长什么样：真实提示来自 appuse（第二个参数 running/needs_review 看两种态）。
			kind := "needs_review"
			if len(os.Args) > 2 {
				kind = os.Args[2]
			}
			if kind == "confirm" {
				// 走 appuse 真正那条路：卡上点了什么、倒计时到了没有，都看最后这行输出。
				fmt.Println("confirm:", appuseConfirmInput("preview"))
				return
			}
			butterflyChipStart()
			if kind == "running" {
				butterflyNotify("running", "正在用鼠标键盘操作这台电脑（appuse act），期间请不要抢鼠标")
			} else {
				butterflyNotify("needs_review", "appuse 可能已经部分执行：点击后输入文字可能已发出；请核对屏幕上的实际结果")
			}
			time.Sleep(20 * time.Second)
			return
		case "--glow-preview":
			// 只为看光效与剑形指针：与 appuse 点亮时完全同一条路径（持有租约 → 亮光效/换指针 → 还原）。
			glowStart()
			lease, err := appuseAcquireInput("preview", "act")
			if err != nil {
				fmt.Fprintln(os.Stderr, "vega-local:", err)
				return
			}
			glowHold()
			time.Sleep(12 * time.Second)
			glowRelease()
			lease.release()
			return
		case "--grab-preview":
			// 抓屏自检：DXGI 与 GDI 各抓一帧逐像素比对，证明“优先 DXGI + 失败回退”没把画面弄坏。
			if err := grabPreview(); err != nil {
				fmt.Fprintln(os.Stderr, "vega-local:", err)
				os.Exit(1)
			}
			return
		case "--butterfly-panel-open":
			// 只验证入口：像点托盘一样拉起（或唤到前面）面板，然后退出，不再持有它。
			url := "http://127.0.0.1:8080/"
			if len(os.Args) > 2 {
				url = os.Args[2]
			}
			fmt.Println(butterflyPanelOpen(url))
			return
		case "--butterfly-panel":
			// 由客户端拉起的面板子进程：go run . --butterfly-panel <assistant-url>
			url := "http://127.0.0.1:8080/"
			if len(os.Args) > 2 {
				url = os.Args[2]
			}
			if !butterflyPanelRun(url) {
				fmt.Fprintln(os.Stderr, "vega-local: WebView2 不可用，无法打开蝴蝶面板")
			}
			return
		}
	}
	a, err := newAgent()
	if err != nil {
		alertUser(err.Error())
		return
	}
	runningAgent = a
	// 进程被强杀时品牌指针会留到下次登录：启动时无条件还原用户自己的指针。
	appuseResetCursorOnStart()
	glowStart()
	keyDir = filepath.Join(a.dataDir, "keys")
	a.clientLog("启动 %s · 站点 %s · 数据目录 %s", clientVersion, a.pinnedOrigin, a.dataDir)
	clearKeys()
	lis, err := net.Listen("tcp", localAddress)
	if err != nil {
		// 一个安装目录只跑一份：另一个站点的客户端已占用本机端口。
		alertUser("另一个站点的客户端正在运行。本机同一时间只能运行一个客户端，请先在托盘退出它，再启动这一个。")
		return
	}
	browserServer, browserErr := localChrome.start()
	if browserErr != nil {
		fmt.Fprintln(os.Stderr, "vega-local browser:", browserErr)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/agent", a.serveWS)
	mux.HandleFunc("/config/"+a.configToken, a.configure)
	a.assistantMount(mux) // 蝴蝶面板的本地页面与数据接口
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(lis) }()
	ctx, cancel := context.WithCancel(context.Background())
	must(notifyUpdateReady())
	// 第一次打开且还没配对：直接打开本安装包的站点，浏览器已登录就会自动开始配对。
	needsPairing := len(a.config.Servers) == 0
	a.startConnections(ctx)
	setSiteLabel(a.siteLabel())
	setTrayOffline(a.config.Offline)
	butterflySetEnabled(a.config.Butterfly)
	setAppuseConfirmSeconds(a.config.ConfirmSeconds)
	if needsPairing {
		go func() {
			time.Sleep(1 * time.Second)
			openBrowser(a.pinnedOrigin)
		}()
	}
	configure := func() { openBrowser("http://" + localAddress + "/config/" + a.configToken) }
	// 面板在启动时就预热好（窗口停屏幕外、页面先加载），点蝴蝶秒开，没有初始化白框。
	go func() {
		time.Sleep(2 * time.Second)
		butterflyPanelWarm(a.assistantURL())
	}()
	butterflySetOpen(func() {
		url := a.assistantURL()
		if url == "" {
			configure()
			return
		}
		// 蝴蝶面板里就是网页里的 BOT 会话；WebView2 不可用时退回系统浏览器。
		if !butterflyPanelOpen(url) {
			openBrowser(url)
		}
	})
	fmt.Fprintln(os.Stderr, "vega-local: connection settings at http://"+localAddress+"/config/"+a.configToken)
	a.clientLog("本地端口 %s 已启用（浏览器需在同一台电脑打开站点）", localAddress)
	quit := func() {
		butterflyPanelClose()
		cancel()
		a.mu.Lock()
		for conn := range a.connections {
			_ = conn.Close()
		}
		a.mu.Unlock()
		_ = srv.Close()
		if browserServer != nil {
			_ = browserServer.Close()
		}
		os.Exit(0)
	}
	go a.autoUpdate(ctx, quit)
	systrayRun(configure, quit, func(online bool) {
		if err := a.setOnline(online); err != nil {
			a.clientLog("上下线失败：%v", err)
		}
	})
}

type job struct {
	Busy bool            `json:"busy"`
	Type string          `json:"type"`
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args"`
	// task_status 推送：服务端算好的任务栏五档（对齐 Nova taskbar_status）。
	Status *jobStatus    `json:"status"`
}

type jobStatus struct {
	Kind     string `json:"kind"`
	Text     string `json:"text"`
	Trailing string `json:"trailing"`
	Detail   string `json:"detail"`
	Thread   string `json:"thread"`
}

func (a *Agent) serveWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", 405)
		return
	}
	// Unapproved sites receive only permission status; no login exchange or jobs.
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return validOrigin(r.Header.Get("Origin")) }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	origin := r.Header.Get("Origin")
	conn.SetReadLimit(4096)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var auth struct {
		Type   string `json:"type"`
		Ticket string `json:"ticket"`
		UserID string `json:"userId"`
	}
	if conn.ReadJSON(&auth) != nil || auth.Type != "auth" || auth.UserID == "" {
		a.noteSite(origin, "站点连上来但没发有效的登录票据")
		pairingStatus(conn, connectionStatus{Code: "login_invalid"})
		return
	}
	a.noteSite(origin, "收到站点配对请求")
	if !a.allowOrigin(origin) {
		pairingStatus(conn, connectionStatus{Code: "permission_required"})
		return
	}
	a.mu.Lock()
	var existing string
	for _, saved := range a.config.Servers {
		if saved.Origin == origin && saved.UserID == auth.UserID {
			existing, _ = unprotectToken(saved.Token)
		}
	}
	clientID := a.config.ClientID
	a.mu.Unlock()
	pairingStatus(conn, connectionStatus{Code: "authorizing"})
	proof, err := verifyLogin(origin, auth.Ticket, clientID, existing)
	if err != nil {
		if failure, ok := err.(*pairingError); ok {
			a.noteSite(origin, "配对失败："+failure.connectionStatus.Code)
			pairingStatus(conn, failure.connectionStatus)
		} else {
			a.noteSite(origin, "配对失败："+err.Error())
			pairingStatus(conn, connectionStatus{Code: "login_invalid"})
		}
		return
	}
	if proof.UserID != auth.UserID {
		a.noteSite(origin, "配对失败：用户不一致")
		pairingStatus(conn, connectionStatus{Code: "login_invalid"})
		return
	}
	saved, err := a.saveCredential(origin, proof)
	if err != nil {
		a.noteSite(origin, "配对失败：凭据保存")
		pairingStatus(conn, connectionStatus{Code: "credential_save"})
		return
	}
	connection := a.startConnection(saved, proof.DeviceToken)
	if connection == nil {
		a.noteSite(origin, "配对失败：权限不足")
		pairingStatus(conn, connectionStatus{Code: "permission_required"})
		return
	}
	a.noteSite(origin, "配对成功，连后端中")
	pairingStatus(conn, connectionStatus{Code: "backend_connecting"})
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	for {
		a.mu.Lock()
		status, changed := connection.status, connection.changed
		a.mu.Unlock()
		if status.Code == "connected" {
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_ = conn.WriteJSON(map[string]any{"type": "paired", "instance": proof.Instance, "userId": proof.UserID, "clientId": clientID, "connected": true})
			return
		}
		if status.Code != "backend_connecting" {
			pairingStatus(conn, status)
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		case <-deadline.C:
			pairingStatus(conn, connectionStatus{Code: "backend_timeout"})
			return
		}
	}
}
func pairingStatus(conn *websocket.Conn, status connectionStatus) {
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = conn.WriteJSON(struct {
		Type string `json:"type"`
		connectionStatus
	}{Type: "status", connectionStatus: status})
}
func execute(ctx context.Context, j job) map[string]any {
	if j.Op == "exec" {
		var req execReq
		if json.Unmarshal(j.Args, &req) != nil || strings.TrimSpace(req.Command) == "" || len(req.Command) > 2<<20 {
			return failure("Invalid command")
		}
		return runCommand(ctx, req)
	}
	if j.Op == "file" {
		var req fileReq
		if json.Unmarshal(j.Args, &req) != nil || req.Path == "" {
			return failure("path required")
		}
		return fileOperation(req)
	}
	if j.Op == "key" {
		var req keyReq
		if json.Unmarshal(j.Args, &req) != nil {
			return failure("Invalid key request")
		}
		return keyOperation(req)
	}
	if j.Op == "appuse" {
		// 只有客户端能操作真实桌面；空参数在 appuseExecute 里按未执行退回，不会静默成功。
		if len(j.Args) == 0 {
			return failure("appuse 缺少参数；本批次尚未执行")
		}
		return appuseExecute(j.Args)
	}
	return failure("Unknown operation")
}
func failure(message string) map[string]any { return map[string]any{"error": message} }

type execReq struct {
	Cwd     string `json:"cwd"`
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}
type limitedOutput struct {
	mu        sync.Mutex
	data      bytes.Buffer
	truncated bool
}

func (b *limitedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := maxOutput - b.data.Len()
	if n > remaining {
		p = p[:remaining]
		b.truncated = true
	}
	_, _ = b.data.Write(p)
	return n, nil
}
func runCommand(parent context.Context, req execReq) map[string]any {
	if message := commandPolicyError(req.Command); message != "" {
		return failure(message)
	}
	if req.Timeout < 1 || req.Timeout > 600 {
		return failure("Invalid timeout")
	}
	st, err := os.Stat(req.Cwd)
	if err != nil || !st.IsDir() {
		return failure("cwd must be an existing directory on this machine")
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(req.Timeout)*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		shell := os.Getenv("VEGA_POWERSHELL")
		if shell == "" {
			shell = "powershell.exe"
		}
		cmd = exec.CommandContext(ctx, shell, "-NoProfile", "-NonInteractive", "-Command", req.Command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", req.Command)
	}
	cmd.Dir = req.Cwd
	configureCommand(cmd)
	cmd.WaitDelay = 2 * time.Second
	output := &limitedOutput{}
	cmd.Stdout = output
	cmd.Stderr = output
	err = cmd.Run()
	code := 0
	message := ""
	if err != nil {
		code = -1
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			message = err.Error()
		}
	}
	if ctx.Err() != nil {
		code = -1
		message = "Cancelled/timeout"
	}
	return map[string]any{"output": output.data.String(), "truncated": output.truncated, "exitCode": code, "error": message}
}

type fileReq struct {
	Op      string     `json:"op"`
	Cwd     string     `json:"cwd"`
	Path    string     `json:"path"`
	Content string     `json:"content"`
	Edits   []fileEdit `json:"edits"`
}
type fileEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

func fileOperation(req fileReq) map[string]any {
	path := strings.TrimPrefix(strings.TrimSpace(req.Path), "@")
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return failure(err.Error())
		}
		path = filepath.Join(home, strings.TrimLeft(path[1:], "/\\"))
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(req.Cwd, path)
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return failure(err.Error())
	}
	switch req.Op {
	case "stat":
		st, err := os.Stat(path)
		return map[string]any{"path": path, "isDir": err == nil && st.IsDir()}
	case "list":
		return listWorkspace(path)
	case "upload":
		root, err := filepath.EvalSymlinks(req.Cwd)
		if err != nil {
			return failure(err.Error())
		}
		root, err = filepath.Abs(root)
		if err != nil {
			return failure(err.Error())
		}
		file, err := filepath.EvalSymlinks(path)
		if err != nil {
			return failure(err.Error())
		}
		rel, err := filepath.Rel(root, file)
		st, statErr := os.Stat(file)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) || statErr != nil || !st.Mode().IsRegular() {
			return failure("Only regular files within the working directory may be uploaded")
		}
		return map[string]any{"path": file}
	case "read":
		f, err := os.Open(path)
		if err != nil {
			return failure(err.Error())
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return failure(err.Error())
		}
		if !st.Mode().IsRegular() || st.Size() > 32<<20 {
			return failure("Regular file required, max32MiB")
		}
		data, err := io.ReadAll(io.LimitReader(f, (32<<20)+1))
		if err != nil {
			return failure(err.Error())
		}
		if len(data) > 32<<20 {
			return failure("File exceeds32MiB")
		}
		return map[string]any{"path": path, "content": base64.StdEncoding.EncodeToString(data)}
	case "write":
		data, err := base64.StdEncoding.DecodeString(req.Content)
		if err != nil || len(data) > 32<<20 {
			return failure("Invalid content or exceeds32MiB")
		}
		if err = writeAtomic(path, data); err != nil {
			return failure(err.Error())
		}
		return map[string]any{"path": path, "bytes": len(data)}
	case "edit":
		return editFile(path, req.Edits)
	}
	return failure("Unknown file operation")
}
func writeAtomic(path string, data []byte) error {
	mode := os.FileMode(0644)
	if st, err := os.Lstat(path); err == nil {
		if !st.Mode().IsRegular() {
			return fmt.Errorf("Regular file required")
		}
		mode = st.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".vega-edit-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func editFile(path string, edits []fileEdit) map[string]any {
	if len(edits) == 0 {
		return failure("edits required")
	}
	st, err := os.Lstat(path)
	if err != nil {
		return failure(err.Error())
	}
	if !st.Mode().IsRegular() || st.Size() > 32<<20 {
		return failure("Regular text file required, max32MiB")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return failure(err.Error())
	}
	if !utf8.Valid(b) || bytes.ContainsRune(b, 0) {
		return failure("Not a UTF-8 text file")
	}
	value := string(b)
	crlf := strings.Contains(value, "\r\n")
	type replacement struct {
		start, end int
		text       string
	}
	ranges := make([]replacement, 0, len(edits))
	for _, e := range edits {
		if e.OldText == "" {
			return failure("Exact nonempty oldText required")
		}
		old := e.OldText
		start := strings.Index(value, old)
		if start < 0 && crlf {
			old = strings.ReplaceAll(strings.ReplaceAll(old, "\r\n", "\n"), "\n", "\r\n")
			start = strings.Index(value, old)
		}
		if start < 0 || strings.Index(value[start+1:], old) >= 0 {
			return failure("oldText must match exactly one region; no file changed")
		}
		ranges = append(ranges, replacement{start, start + len(old), e.NewText})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	for i := 1; i < len(ranges); i++ {
		if ranges[i].start < ranges[i-1].end {
			return failure("Overlapping edits; no file changed")
		}
	}
	for i := len(ranges) - 1; i >= 0; i-- {
		r := ranges[i]
		value = value[:r.start] + r.text + value[r.end:]
	}
	if len(value) > 32<<20 {
		return failure("Edited file exceeds32MiB")
	}
	if err = writeAtomic(path, []byte(value)); err != nil {
		return failure(err.Error())
	}
	return map[string]any{"path": path, "bytes": len(value)}
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
