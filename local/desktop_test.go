package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 客户端窗口的页面是嵌进二进制的：路径拼错就是白窗口，这里钉住三件事——
// 根路径给 index.html、同目录的资源按类型发、往上跳的路径一律 404。
func TestDesktopAssetsServeTheClientPage(t *testing.T) {
	agent := &Agent{configToken: "t0ken"}
	mux := http.NewServeMux()
	agent.assistantMount(mux)
	base := agent.assistantPath()
	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder
	}

	cases := []struct{ name, body, contentType string }{
		{"", `<div class="app"`, "text/html"},
		{"style.css", "--side-w: 280px", "text/css"},
		{"app.js", "setInterval(pollMessages", "text/javascript"},
		{"bot-avatar.js", "window.BotAvatar", "text/javascript"},
		{"marked.js", "marked", "text/javascript"},
	}
	for _, want := range cases {
		response := get(base + want.name)
		if response.Code != http.StatusOK {
			t.Fatalf("%q 没发出去：%d", want.name, response.Code)
		}
		if !strings.Contains(response.Body.String(), want.body) {
			t.Fatalf("%q 的内容不对：%q", want.name, response.Body.String()[:80])
		}
		if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, want.contentType) {
			t.Fatalf("%q 的类型是 %q，想要 %q", want.name, contentType, want.contentType)
		}
	}

	// 往上跳的路径被 ServeMux 先规整掉（3xx），不存在的就是 404——两种都不许把源码发出去。
	for _, path := range []string{base + "../assistant.go", base + "nope.js"} {
		response := get(path)
		if response.Code == http.StatusOK {
			t.Fatalf("%q 把文件发出去了", path)
		}
	}
}

// 窗口几何：读得出上次记的，太小的（坏文件/旧版本）当没有。
func TestDesktopGeometryRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, ok := loadDesktopGeometry(dir, desktopMinWidth, desktopMinHeight); ok {
		t.Fatal("空目录不该有几何")
	}
	saveDesktopGeometry(dir, desktopGeometry{X: 120, Y: 90, Width: 1040, Height: 760})
	geometry, ok := loadDesktopGeometry(dir, desktopMinWidth, desktopMinHeight)
	if !ok || geometry.Width != 1040 || geometry.Height != 760 || geometry.X != 120 {
		t.Fatalf("读回来的是 %+v (ok=%v)", geometry, ok)
	}
	saveDesktopGeometry(dir, desktopGeometry{Width: 300, Height: 200})
	if _, ok := loadDesktopGeometry(dir, desktopMinWidth, desktopMinHeight); ok {
		t.Fatal("比最小尺寸还小的几何不该采用")
	}
}
