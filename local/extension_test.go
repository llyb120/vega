package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 内置扩展要能整份写到本机：manifest 是新的 Vega 身份，worker 找的是 Vega 自己的端口段。
func TestWriteBundledExtensionWritesVegaManifestAndPorts(t *testing.T) {
	a := &Agent{dataDir: t.TempDir()}
	dir, err := a.writeBundledExtension()
	if err != nil {
		t.Fatalf("writeBundledExtension: %v", err)
	}
	if dir != a.extensionDir() {
		t.Fatalf("dir = %s, want %s", dir, a.extensionDir())
	}
	var manifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Key     string `json:"key"`
	}
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("manifest JSON: %v", err)
	}
	if manifest.Name != "Vega Chrome" || manifest.Version != "0.2.0" || manifest.Key == "" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	worker, err := os.ReadFile(filepath.Join(dir, "worker.js"))
	if err != nil {
		t.Fatalf("worker.js: %v", err)
	}
	if !strings.Contains(string(worker), "for (let port=47753") {
		t.Fatal("worker.js does not discover Vega's own loopback ports")
	}
	if strings.Contains(string(worker), "for (let port=47653") {
		t.Fatal("worker.js still discovers Nova's ports")
	}
	// 重写一份要清掉旧文件，Chrome 加载到半新半旧会启动失败。
	stale := filepath.Join(dir, "stale.js")
	if err = os.WriteFile(stale, []byte("x"), 0o600); err != nil {
		t.Fatalf("stale: %v", err)
	}
	if _, err = a.writeBundledExtension(); err != nil {
		t.Fatalf("second writeBundledExtension: %v", err)
	}
	if _, err = os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("leftover file survived a rewrite: %v", err)
	}
}

func allowExtensionInstall(t *testing.T, allowed bool) {
	t.Helper()
	previous := browserExtensionInstallSupported
	browserExtensionInstallSupported = func() bool { return allowed }
	t.Cleanup(func() { browserExtensionInstallSupported = previous })
}

func pairedAgent(t *testing.T, origin, token string) *Agent {
	t.Helper()
	protected, err := protectToken(token)
	if err != nil {
		t.Fatalf("protectToken: %v", err)
	}
	a := &Agent{dataDir: t.TempDir()}
	a.config.Servers = []ServerCredential{{Origin: origin, UserID: "user-1", Token: protected}}
	return a
}

func TestInstallExtensionAsksSiteWithBundledPath(t *testing.T) {
	allowExtensionInstall(t, true)
	const token = "ttttttttttttttttttttttttttttttttttttttttttt"
	var method, authorization, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, authorization = r.Method, r.Header.Get("Authorization")
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("body: %v", err)
		}
		path = body.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"employee":"测试牛马","employeeId":"e1"}`))
	}))
	defer server.Close()
	a := pairedAgent(t, server.URL, token)
	if err := a.installExtension(); err != nil {
		t.Fatalf("installExtension: %v", err)
	}
	if method != http.MethodPost {
		t.Fatalf("method = %s", method)
	}
	if authorization != "Bearer "+token {
		t.Fatalf("authorization = %q", authorization)
	}
	if path != a.extensionDir() {
		t.Fatalf("path = %q, want %q", path, a.extensionDir())
	}
	if _, err := os.Stat(filepath.Join(path, "manifest.json")); err != nil {
		t.Fatalf("extension was not written: %v", err)
	}
	a.mu.Lock()
	message := a.lastExtension
	a.mu.Unlock()
	if !strings.Contains(message, "测试牛马") || !strings.Contains(message, path) {
		t.Fatalf("lastExtension = %q", message)
	}
}

func TestInstallExtensionSurfacesSiteConfigurationHint(t *testing.T) {
	allowExtensionInstall(t, true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"statusMessage":"没有可用的牛马：请先在「数字牛马」里新建一个，或等它空闲"}`))
	}))
	defer server.Close()
	a := pairedAgent(t, server.URL, strings.Repeat("s", 43))
	err := a.installExtension()
	if err == nil || !strings.Contains(err.Error(), "没有可用的牛马") {
		t.Fatalf("err = %v", err)
	}
	a.mu.Lock()
	message := a.lastExtension
	a.mu.Unlock()
	if message != "" {
		t.Fatalf("a rejected request must not report success: %q", message)
	}
}

func TestInstallExtensionUncertainResultRequiresChecking(t *testing.T) {
	allowExtensionInstall(t, true)
	for _, scenario := range []string{"disconnect", "invalid-response"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "disconnect" {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err == nil {
						_ = conn.Close()
					}
					return
				}
				_, _ = w.Write([]byte("invalid"))
			}))
			defer server.Close()
			a := pairedAgent(t, server.URL, strings.Repeat("s", 43))
			err := a.installExtension()
			if err == nil || !strings.Contains(err.Error(), "可能已创建") || !strings.Contains(err.Error(), "核对") {
				t.Fatalf("an uncertain submission must not be reported as unstarted: %v", err)
			}
		})
	}
}

func TestInstallExtensionRequiresAPairedSite(t *testing.T) {
	allowExtensionInstall(t, true)
	a := &Agent{dataDir: t.TempDir()}
	err := a.installExtension()
	if err == nil || !strings.Contains(err.Error(), "还没和站点配对") {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallExtensionIsWindowsOnly(t *testing.T) {
	allowExtensionInstall(t, false)
	a := &Agent{dataDir: t.TempDir()}
	err := a.installExtension()
	if err == nil || !strings.Contains(err.Error(), "只支持 Windows 客户端") {
		t.Fatalf("err = %v", err)
	}
}

// 配置页要真的把按钮、解压目录和上一次的结果渲染出来（模板用位置参数，加字段最容易错位）。
func TestConfigPageOffersExtensionUpdate(t *testing.T) {
	allowExtensionInstall(t, true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"employee":"测试牛马"}`))
	}))
	defer server.Close()
	a := pairedAgent(t, server.URL, strings.Repeat("p", 43))
	a.configPath = filepath.Join(t.TempDir(), "trusted-sites.json")
	a.direct = map[string]*directConnection{}
	page := func() string {
		w := httptest.NewRecorder()
		a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=access", nil))
		return w.Body.String()
	}
	for _, want := range []string{`name="updateExtension" value="1"`, "更新浏览器扩展", a.extensionDir(), `id="panel-access"`} {
		if !strings.Contains(page(), want) {
			t.Fatalf("config page is missing %q", want)
		}
	}
	form := url.Values{"updateExtension": {"1"}}
	r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Origin", "http://"+localAddress)
	w := httptest.NewRecorder()
	a.configure(w, r)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, body = %s", w.Code, w.Body.String())
	}
	if location := w.Header().Get("Location"); location != "/config/test?saved=1&tab=access" {
		t.Fatalf("location = %q", location)
	}
	if !strings.Contains(page(), "测试牛马") {
		t.Fatal("the page must show which employee got the install task")
	}
}
