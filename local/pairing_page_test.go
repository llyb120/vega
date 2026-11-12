package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// 设置页「浏览器」卡片：无头是默认项，并且会把上一次登录态借用的结果给人看，
// 否则用户看不出无头浏览器为什么还没有他自己 Chrome 里的登录态。
func TestSettingsPageRendersBrowserModeAndBorrowNotice(t *testing.T) {
	page := func(a *Agent) string {
		t.Helper()
		request := httptest.NewRequest("GET", "/config/x?tab=access", nil)
		request.Host = localAddress
		recorder := httptest.NewRecorder()
		a.configure(recorder, request)
		if recorder.Code != 200 {
			t.Fatalf("settings page status %d: %s", recorder.Code, recorder.Body.String())
		}
		return recorder.Body.String()
	}
	a := &Agent{config: Config{ClientID: strings.Repeat("a", 32)}, pinnedOrigin: "http://127.0.0.1:47999", dataDir: t.TempDir()}
	body := page(a)
	for _, want := range []string{"无头（默认）", "用我自己开的 Chrome", "保存浏览器设置"} {
		if !strings.Contains(body, want) {
			t.Fatalf("settings page is missing %q", want)
		}
	}

	previous := headlessBrowser.Load()
	defer headlessBrowser.Store(previous)
	instance := &headlessChrome{dir: t.TempDir()}
	headlessBrowser.Store(instance)
	instance.note("已从你自己的 Chrome 同步 2 个 Cookie")
	if body = page(a); !strings.Contains(body, "同步 2 个 Cookie") {
		t.Fatal("headless mode did not show the last login-borrow result")
	}

	// 有头模式不用这个提示：它讲的是无头实例的登录态。
	a.config.BrowserMode = "real"
	if body = page(a); strings.Contains(body, "同步 2 个 Cookie") {
		t.Fatal("the borrow result belongs to the headless mode only")
	}
	if !strings.Contains(body, `value="real" checked`) {
		t.Fatal("headed mode is not selected in the page")
	}
}
