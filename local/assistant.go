package main

// 蝴蝶面板的界面与数据通道：面板里不登录网站、也不加载站点前端。
// 页面资源由本进程直接发给 WebView2，数据由这段代码带设备凭据
// 转发给本站点的 /api/local-agent/chat/*（原生客户端通道）。
// 地址带 configToken：本机别的程序不知道令牌就打不开，接口也只认这个令牌。

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

//go:embed assistant_page.html
var assistantPage []byte

//go:embed assistant_marked.js
var assistantMarked []byte

const assistantGrokPath = "grok/"

var assistantGrokAssets fs.FS // embedded on desktop (Windows & macOS)

func (a *Agent) assistantMount(mux *http.ServeMux) {
	base := a.assistantPath()
	mux.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, base)
		switch {
		case strings.HasPrefix(path, "api/"):
			a.assistantAPI(w, r, strings.TrimPrefix(path, "api/"))
		case path == "" && r.Method == http.MethodGet && assistantGrokAssets != nil:
			http.Redirect(w, r, base+assistantGrokPath, http.StatusFound)
		case path == "marked.js" && r.Method == http.MethodGet && assistantGrokAssets == nil:
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(assistantMarked)
		case path == "" && r.Method == http.MethodGet && assistantGrokAssets == nil:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(assistantPage)
		default:
			http.NotFound(w, r)
		}
	})
	if assistantGrokAssets != nil {
		grokBase := base + assistantGrokPath
		static := http.StripPrefix(grokBase, http.FileServerFS(assistantGrokAssets))
		mux.HandleFunc(grokBase, func(w http.ResponseWriter, r *http.Request) {
			path := strings.TrimPrefix(r.URL.Path, grokBase)
			if strings.HasPrefix(path, "api/") {
				a.assistantAPI(w, r, strings.TrimPrefix(path, "api/"))
				return
			}
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			// The bundled renderer is local UI, not a client for Grok accounts or external services.
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
			if path == "" || path == "index.html" || path == "grok_bridge.js" {
				w.Header().Set("Cache-Control", "no-store")
			}
			static.ServeHTTP(w, r)
		})
	}
}

// assistantPath 面板页面与接口在本地服务器上的路径前缀。
func (a *Agent) assistantPath() string {
	return "/assistant/" + a.configToken + "/"
}

// assistantBase 面板页面地址（本地环回 + 令牌）。
func (a *Agent) assistantBase() string {
	return "http://" + localAddress + a.assistantPath()
}

// assistantAPI 只开放现有设备通道的操作，不代理网站登录、OAuth 或任意 URL。
func (a *Agent) assistantAPI(w http.ResponseWriter, r *http.Request, op string) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+localAddress {
		http.Error(w, "cross-origin request denied", http.StatusForbidden)
		return
	}
	switch op {
	case "close":
		butterflyPanelPark()
		assistantReply(w, http.StatusOK, map[string]any{"ok": true})
		return
	case "authorize":
		if r.Header.Get("Origin") != "http://"+localAddress {
			http.Error(w, "local browser origin required", http.StatusForbidden)
			return
		}
		a.mu.Lock()
		address := a.deviceAuthURL
		a.mu.Unlock()
		if address == "" {
			assistantReply(w, http.StatusConflict, map[string]string{"error": "暂无待确认的站点授权。请检查「连接授权」中的站点状态；若授权已失效，请退出并重新启动客户端。"})
			return
		}
		openDeviceAuthorization(address)
		assistantReply(w, http.StatusOK, map[string]bool{"ok": true})
		return
	case "metadata", "threads", "messages", "send", "read", "control", "file":
	default:
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	site, token, ok := a.assistantCredential()
	if !ok {
		assistantReply(w, http.StatusConflict, map[string]any{"error": "客户端尚未授权，请在托盘「设置」中完成本站授权"})
		return
	}
	if op == "metadata" {
		assistantReply(w, http.StatusOK, map[string]string{"id": site.UserID, "name": "Vega"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, site.Origin+"/api/local-agent/chat/"+op, bytes.NewReader(body))
	if err != nil {
		assistantReply(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		assistantReply(w, http.StatusBadGateway, map[string]any{"error": "连不上站点，请检查网络和站点地址"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		assistantReply(w, http.StatusBadGateway, map[string]any{"error": "站点地址发生跳转，请从当前站点重新下载安装包"})
		return
	}
	limit := int64(8 << 20)
	if op == "file" || op == "messages" {
		limit = 48 << 20 // 25MiB binary plus base64, or a page of full step outputs
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		assistantReply(w, http.StatusBadGateway, map[string]any{"error": "站点返回的内容无法完整读取"})
		return
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		assistantReply(w, response.StatusCode, map[string]any{"error": "站点拒绝此请求，请检查客户端授权和账号权限"})
		return
	}
	if response.StatusCode == http.StatusNotFound {
		// 老版本服务端没有这几个接口（还得要网站 cookie）：给页面一句能看懂的话。
		assistantReply(w, http.StatusConflict, map[string]any{"error": "服务端还没有更新到支持桌面对话的版本（缺少 /api/local-agent/chat）"})
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
func (a *Agent) assistantCredential() (ServerCredential, string, bool) {
	a.mu.Lock()
	servers := append([]ServerCredential{}, a.config.Servers...)
	pinned := a.pinnedOrigin
	a.mu.Unlock()
	// 设备凭据只属于安装包指定的站点（含目录），不能回退到同主机的其它站点。
	for i := len(servers) - 1; i >= 0; i-- {
		saved := servers[i]
		if saved.Origin != pinned || !validSiteBase(saved.Origin) {
			continue
		}
		if token, err := unprotectToken(saved.Token); err == nil && token != "" {
			return saved, token, true
		}
	}
	return ServerCredential{}, "", false
}

// assistantReply 出错时也回 JSON，页面直接把 error 显示在聊天区。
func assistantReply(w http.ResponseWriter, status int, value any) {
	data, _ := json.Marshal(value)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
