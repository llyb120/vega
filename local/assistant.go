package main

// 蝴蝶面板的界面与数据通道：面板里不登录网站、也不加载站点前端。
// 页面（assistant_page.html）由本进程直接发给 WebView2，数据由这段代码带设备凭据
// 转发给本站点的 /api/local-agent/chat/*（原生客户端通道）。
// 地址带 configToken：本机别的程序不知道令牌就打不开，接口也只认这个令牌。

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

//go:embed assistant_page.html
var assistantPage []byte

//go:embed assistant_marked.js
var assistantMarked []byte

// assistantMount 把面板页面和它的几个接口挂到本地服务器上。
func (a *Agent) assistantMount(mux *http.ServeMux) {
	base := a.assistantPath()
	mux.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/threads"):
			a.assistantProxy(w, r, "threads")
		case strings.HasSuffix(r.URL.Path, "/api/messages"):
			a.assistantProxy(w, r, "messages")
		case strings.HasSuffix(r.URL.Path, "/api/send"):
			a.assistantProxy(w, r, "send")
		case strings.HasSuffix(r.URL.Path, "/api/read"):
			a.assistantProxy(w, r, "read")
		case strings.HasSuffix(r.URL.Path, "/api/control"):
			// 待确认气泡上的「允许 / 拒绝 / 回答」：透传给牛马的 employee.control。
			a.assistantProxy(w, r, "control")
		case strings.HasSuffix(r.URL.Path, "/api/close"):
			// 页面上的 × 只是把面板收回屏幕外（WebView2 留在内存里，下次点蝴蝶秒开）。
			butterflyPanelPark()
			assistantReply(w, http.StatusOK, map[string]any{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/marked.js"):
			// markdown 渲染用 marked（MIT），面板里不带构建步骤，直接内嵌发出去。
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(assistantMarked)
		case r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(assistantPage)
		default:
			http.NotFound(w, r)
		}
	})
}

// assistantPath 面板页面与接口在本地服务器上的路径前缀。
func (a *Agent) assistantPath() string {
	return "/assistant/" + a.configToken + "/"
}

// assistantBase 面板页面地址（本地环回 + 令牌）。
func (a *Agent) assistantBase() string {
	return "http://" + localAddress + a.assistantPath()
}

// assistantProxy 用设备凭据把请求转给站点。原生客户端的请求不带 Origin、不带查询串，
// 所以参数全部走 body，站点那边也只收 POST。
func (a *Agent) assistantProxy(w http.ResponseWriter, r *http.Request, op string) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	// 页面只从本机这个地址加载，其它来源一律拒绝。
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+localAddress {
		http.Error(w, "cross-origin request denied", http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "unreadable body", http.StatusBadRequest)
		return
	}
	origin, token, ok := a.assistantCredential()
	if !ok {
		assistantReply(w, http.StatusConflict, map[string]any{"error": "还没有配对站点，请先在托盘打开配置页完成配对"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/api/local-agent/chat/"+op, bytes.NewReader(body))
	if err != nil {
		assistantReply(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		assistantReply(w, http.StatusBadGateway, map[string]any{"error": "连不上站点：" + err.Error()})
		return
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusUnauthorized {
		// 老版本服务端没有这几个接口（还得要网站 cookie）：给页面一句能看懂的话。
		assistantReply(w, http.StatusConflict, map[string]any{"error": "服务端还没有更新到支持蝴蝶面板的版本（缺少 /api/local-agent/chat）"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	if len(data) == 0 {
		_, _ = w.Write([]byte("{}"))
		return
	}
	_, _ = w.Write(data)
}

// assistantCredential 当前站点 + 它的设备凭据（DPAPI 解出来的原始 token）。
func (a *Agent) assistantCredential() (string, string, bool) {
	a.mu.Lock()
	servers := append([]ServerCredential{}, a.config.Servers...)
	pinned := a.pinnedOrigin
	a.mu.Unlock()
	for _, liked := range []bool{true, false} {
		for _, saved := range servers {
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

// assistantReply 出错时也回 JSON，页面直接把 error 显示在聊天区。
func assistantReply(w http.ResponseWriter, status int, value any) {
	data, _ := json.Marshal(value)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
