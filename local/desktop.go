package main

// 桌面窗口：客户端自己的聊天程序。页面（ui/）由本进程直接发给窗口，数据用设备凭据经
// /api/local-agent/chat 转发到站点；窗口不加载站点前端，也不需要站点 Cookie，拿不到令牌就打不开。
// 与网页里的牛马会话是同一份数据：左栏牛马与群聊、右侧对话，发送、读历史、待确认卡都在这里。

import (
	"bytes"
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed ui/index.html ui/style.css ui/app.js ui/markdown.js ui/bot-avatar.js
var desktopAssets embed.FS

// desktopFiles 只发这几个文件：窗口里跑的是这一套页面，不接受任意路径。
var desktopFiles = map[string]string{
	"":              "ui/index.html",
	"index.html":    "ui/index.html",
	"style.css":     "ui/style.css",
	"app.js":        "ui/app.js",
	"markdown.js":   "ui/markdown.js",
	"bot-avatar.js": "ui/bot-avatar.js",
}

var desktopTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
}

// desktopHost 是窗口宿主的抽象：Windows 上是 WebView2 桌面窗口（见 desktop_windows.go）；
// 其它平台没有窗口宿主，退回系统浏览器打开同一套页面。
type desktopHost interface {
	Show()
	Minimise()
	ToggleMaximise()
	Close()
	Drag()
	Visible() bool
}

var desktopWindow desktopHost

// desktopBase 是窗口页面与接口的路径前缀（带本机令牌：别的程序不知道就打不开）。
func (a *Agent) desktopBase() string { return "/window/" + a.configToken + "/" }

// desktopURL 是窗口要打开的地址（本地环回 + 令牌）。
func (a *Agent) desktopURL() string { return "http://" + localAddress + a.desktopBase() }

// desktopMount 挂上窗口页面与接口。
func (a *Agent) desktopMount(mux *http.ServeMux) {
	base := a.desktopBase()
	mux.HandleFunc(base, a.desktopPage)
	mux.HandleFunc(base+"api/", a.desktopAPI)
}

// desktopShow 打开窗口（没有窗口宿主时退回系统浏览器）。
func (a *Agent) desktopShow() {
	if desktopWindow != nil {
		desktopWindow.Show()
		return
	}
	openBrowser(a.desktopURL())
}

// desktopClose 关掉窗口（客户端退出时不让它单独留在桌面上）。
func desktopClose() {
	if desktopWindow != nil {
		desktopWindow.Close()
	}
}

// desktopPage 发页面文件；只认 desktopFiles 里的名字。
func (a *Agent) desktopPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, a.desktopBase())
	file, ok := desktopFiles[rel]
	if !ok {
		http.NotFound(w, r)
		return
	}
	data, err := desktopAssets.ReadFile(file)
	if err != nil {
		http.Error(w, "page unavailable", http.StatusInternalServerError)
		return
	}
	kind := desktopTypes[".html"]
	switch {
	case strings.HasSuffix(file, ".js"):
		kind = desktopTypes[".js"]
	case strings.HasSuffix(file, ".css"):
		kind = desktopTypes[".css"]
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}

// desktopAPI 是窗口的接口：聊天类原样转发站点，图片用 GET（页面里 <img> 直接用），其余是本机动作。
func (a *Agent) desktopAPI(w http.ResponseWriter, r *http.Request) {
	op := strings.TrimPrefix(r.URL.Path, a.desktopBase()+"api/")
	if op == "image" {
		a.desktopImage(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		desktopReply(w, http.StatusBadRequest, map[string]any{"error": "请求内容读不出来"})
		return
	}
	switch op {
	case "state":
		a.desktopState(w)
	case "window":
		a.desktopWindowAction(w, body)
	case "open":
		a.desktopOpen(w, body)
	case "confirm":
		a.desktopConfirmAnswer(w, body)
	default:
		a.desktopForward(w, op, body)
	}
}

// desktopForward 把聊天接口原样转给站点（threads/messages/send/read/control/me）。
func (a *Agent) desktopForward(w http.ResponseWriter, op string, body []byte) {
	if !desktopChatOps[op] {
		desktopReply(w, http.StatusNotFound, map[string]any{"error": "窗口接口不存在"})
		return
	}
	status, data, err := a.siteRequest(http.MethodPost, "/api/local-agent/chat/"+op, body)
	if err != nil {
		desktopReply(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if status == http.StatusNotFound || status == http.StatusUnauthorized {
		desktopReply(w, http.StatusConflict, map[string]any{"error": "站点还没有更新到支持客户端窗口的版本（缺少 /api/local-agent/chat）；请升级站点后重新配对一次"})
		return
	}
	desktopWrite(w, status, data)
}

var desktopChatOps = map[string]bool{"threads": true, "messages": true, "send": true, "read": true, "control": true, "me": true}

// desktopImage 读一张消息里的图片/附件头像：页面用 <img> 拿不到站点 Cookie，这里用设备凭据代取。
func (a *Agent) desktopImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	payload := map[string]string{}
	switch {
	case query.Get("blobId") != "":
		payload["blobId"] = query.Get("blobId")
	case query.Get("path") != "":
		payload["path"] = query.Get("path")
	case query.Get("employee") != "":
		payload["employee"] = query.Get("employee")
	default:
		http.Error(w, "image required", http.StatusBadRequest)
		return
	}
	body, _ := json.Marshal(payload)
	status, data, err := a.siteRequest(http.MethodPost, "/api/local-agent/chat/image", body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	var image struct {
		Mime string `json:"mime"`
		Data string `json:"data"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &image) != nil || image.Data == "" {
		http.Error(w, "image unavailable", http.StatusBadGateway)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(image.Data)
	if err != nil {
		http.Error(w, "image unavailable", http.StatusBadGateway)
		return
	}
	mime := image.Mime
	if !strings.HasPrefix(mime, "image/") {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(raw)
}

// desktopState 给窗口的轮询：连接、操作电脑前的确认卡、操作提示和账号。
func (a *Agent) desktopState(w http.ResponseWriter) {
	a.mu.Lock()
	connected := false
	for _, connection := range a.direct {
		if connection.status.Code == "connected" {
			connected = true
		}
	}
	origin := a.pinnedOrigin
	a.mu.Unlock()
	active, text, left := desktopConfirmStatus()
	notice := windowNoticeSnapshot()
	answer := map[string]any{"connected": connected, "origin": origin, "version": clientVersion, "me": desktopMe(a)}
	answer["confirm"] = map[string]any{"active": active, "text": text, "left": left}
	if notice != nil {
		answer["notice"] = map[string]any{"kind": notice.Kind, "text": notice.Text}
	} else {
		answer["notice"] = nil
	}
	desktopReply(w, http.StatusOK, answer)
}

// desktopMe 是窗口左下角显示的账号（最近配对的站点账号）。
func desktopMe(a *Agent) any {
	status, data, err := a.siteRequest(http.MethodPost, "/api/local-agent/chat/me", nil)
	if err != nil || status != http.StatusOK {
		return nil
	}
	var me struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if json.Unmarshal(data, &me) != nil || me.Name == "" {
		return nil
	}
	return me
}

// desktopWindowAction 是自绘标题栏的按钮：最小化 / 最大化 / 关闭 / 拖动。
func (a *Agent) desktopWindowAction(w http.ResponseWriter, body []byte) {
	var request struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal(body, &request)
	switch request.Action {
	case "min":
		if desktopWindow != nil {
			desktopWindow.Minimise()
		}
	case "max":
		if desktopWindow != nil {
			desktopWindow.ToggleMaximise()
		}
	case "close":
		if desktopWindow != nil {
			desktopWindow.Close()
		}
		return
	case "drag":
		if desktopWindow != nil {
			desktopWindow.Drag()
		}
	}
	desktopReply(w, http.StatusOK, map[string]any{"ok": true})
}

// desktopOpen 在系统浏览器里打开站点页面或本机设置页。
func (a *Agent) desktopOpen(w http.ResponseWriter, body []byte) {
	var request struct {
		URL    string `json:"url"`
		Config bool   `json:"config"`
	}
	_ = json.Unmarshal(body, &request)
	address := strings.TrimSpace(request.URL)
	if request.Config {
		address = "http://" + localAddress + "/config/" + a.configToken
	}
	if !desktopAddressAllowed(address, a.pinnedOrigin) {
		desktopReply(w, http.StatusBadRequest, map[string]any{"error": "只允许打开本站点或本机设置页"})
		return
	}
	openBrowser(address)
	desktopReply(w, http.StatusOK, map[string]any{"ok": true})
}

func desktopAddressAllowed(address, origin string) bool {
	if strings.HasPrefix(address, "http://"+localAddress+"/") {
		return true
	}
	if origin == "" || !validOrigin(origin) || (address != origin && !strings.HasPrefix(address, origin+"/")) {
		return false
	}
	return true
}

// desktopConfirmAnswer 是确认卡上「现在接管 / 我在用」的答复入口。
func (a *Agent) desktopConfirmAnswer(w http.ResponseWriter, body []byte) {
	var request struct {
		Option string `json:"option"`
	}
	_ = json.Unmarshal(body, &request)
	if request.Option != "" {
		choice := "allow"
		if request.Option == "reject" || request.Option == "busy" {
			choice = "reject"
		}
		appuseConfirmAnswer(choice)
	}
	desktopReply(w, http.StatusOK, map[string]any{"ok": true})
}

func desktopReply(w http.ResponseWriter, status int, value any) {
	data, _ := json.Marshal(value)
	desktopWrite(w, status, data)
}

func desktopWrite(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if len(data) == 0 {
		data = []byte("{}")
	}
	_, _ = w.Write(data)
}

// desktopConfirmStatus 给页面看的那份确认卡状态。
func desktopConfirmStatus() (bool, string, int) {
	confirmCard.Lock()
	defer confirmCard.Unlock()
	if !confirmCard.active {
		return false, "", 0
	}
	left := int(time.Until(confirmCard.deadline).Seconds())
	if left < 0 {
		left = 0
	}
	return true, confirmCard.text, left
}

var confirmCard struct {
	sync.Mutex
	active   bool
	text     string
	deadline time.Time
}

func desktopConfirmBegin(text string) {
	confirmCard.Lock()
	confirmCard.active, confirmCard.text, confirmCard.deadline = true, text, time.Now().Add(appuseConfirmTimeout)
	confirmCard.Unlock()
}

func desktopConfirmEnd() {
	confirmCard.Lock()
	confirmCard.active = false
	confirmCard.Unlock()
}

// windowNotice 是窗口里那条「正在操作这台电脑 / 请核对结果」的提示。
type windowNotice struct {
	Kind string
	Text string
	At   time.Time
}

var windowNoticeState struct {
	sync.Mutex
	current *windowNotice
}

func windowNotify(kind, text string) {
	windowNoticeState.Lock()
	previous := windowNoticeState.current
	windowNoticeState.current = &windowNotice{Kind: kind, Text: text, At: time.Now()}
	windowNoticeState.Unlock()
	// 可能已经部分执行时必须让人看见：把窗口叫到前面，别只写在会话记录里。
	if kind == "needs_review" && desktopWindow != nil {
		desktopWindow.Show()
	}
	_ = previous
}

func windowClearIfKind(kind string) {
	windowNoticeState.Lock()
	current := windowNoticeState.current
	if current != nil && current.Kind == kind {
		windowNoticeState.current = nil
	}
	windowNoticeState.Unlock()
}

func windowNoticeSnapshot() *windowNotice {
	windowNoticeState.Lock()
	defer windowNoticeState.Unlock()
	return windowNoticeState.current
}

// windowConfirmCard 是 appuseConfirmCard 的窗口实现：窗口开着就弹卡问一句，没有窗口按原逻辑视为同意。
func windowConfirmCard() bool {
	if desktopWindow == nil {
		return false
	}
	desktopWindow.Show()
	desktopConfirmBegin(appuseConfirmText)
	return true
}

// desktopGeometry 是窗口位置与大小：下次还按它打开（收口在显示器工作区内）。
type desktopGeometry struct {
	X, Y, Width, Height int32
}

func desktopGeometryPath(dir string) string { return filepath.Join(dir, "window.json") }

func loadDesktopGeometry(dir string) (desktopGeometry, bool) {
	data, err := os.ReadFile(desktopGeometryPath(dir))
	if err != nil {
		return desktopGeometry{}, false
	}
	var geometry desktopGeometry
	if json.Unmarshal(data, &geometry) != nil || geometry.Width < desktopMinWidth || geometry.Height < desktopMinHeight {
		return desktopGeometry{}, false
	}
	return geometry, true
}

func saveDesktopGeometry(dir string, geometry desktopGeometry) {
	if geometry.Width < desktopMinWidth || geometry.Height < desktopMinHeight {
		return
	}
	data, err := json.Marshal(geometry)
	if err != nil {
		return
	}
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(desktopGeometryPath(dir), data, 0o600)
}

const (
	desktopWidth     = 1040
	desktopHeight    = 760
	desktopMinWidth  = 860
	desktopMinHeight = 620
)

// desktopFrame 首次打开的位置：没有记住就按参考图尺寸居中在工作区里；记住的窗口放不进当前屏幕时
// 按工作区收缩后再居中，不会一半在屏幕外。
func desktopFrame(work desktopRect, saved *desktopGeometry, scale func(int32) int32) (int32, int32, int32, int32) {
	width, height := scale(desktopWidth), scale(desktopHeight)
	if saved != nil {
		width, height = saved.Width, saved.Height
	}
	if limit := work.Right - work.Left; limit > 0 && width > limit {
		width = limit
	}
	if limit := work.Bottom - work.Top; limit > 0 && height > limit {
		height = limit
	}
	x := work.Left + (work.Right-work.Left-width)/2
	y := work.Top + (work.Bottom-work.Top-height)/2
	if saved != nil && saved.X >= work.Left && saved.Y >= work.Top && saved.X+saved.Width <= work.Right && saved.Y+saved.Height <= work.Bottom {
		x, y = saved.X, saved.Y
	}
	if x < work.Left {
		x = work.Left
	}
	if y < work.Top {
		y = work.Top
	}
	if x+width > work.Right {
		x = work.Right - width
	}
	if y+height > work.Bottom {
		y = work.Bottom - height
	}
	return x, y, width, height
}

// siteRequest 用设备凭据请求站点。原生客户端请求不带 Origin、不带查询串。
func (a *Agent) siteRequest(method, path string, payload []byte) (int, []byte, error) {
	origin, token, ok := a.assistantCredential()
	if !ok {
		return 0, nil, fmt.Errorf("这台电脑还没和站点配对：先在同一台电脑的浏览器打开站点完成连接授权")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, origin+path, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 45 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("连不上站点：%w", err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 48<<20))
	return response.StatusCode, data, nil
}

// assistantCredential 当前站点 + 它的设备凭据（DPAPI 解出来的原始 token）。
// 同一站点可以配多个账号，配对时新的追加在末尾：窗口跟最近配对的账号走。
func (a *Agent) assistantCredential() (string, string, bool) {
	a.mu.Lock()
	servers := append([]ServerCredential{}, a.config.Servers...)
	pinned := a.pinnedOrigin
	a.mu.Unlock()
	for _, liked := range []bool{true, false} {
		for i := len(servers) - 1; i >= 0; i-- {
			saved := servers[i]
			if liked != (saved.Origin == pinned) || !validOrigin(saved.Origin) {
				continue
			}
			if token, err := unprotectToken(saved.Token); err == nil && token != "" {
				return saved.Origin, token, true
			}
		}
	}
	return "", "", false
}

type desktopRect struct{ Left, Top, Right, Bottom int32 }
