package main

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 确认时间可在设置页改：3–600 秒生效并落盘，越界直接报错，没设置就用默认 15 秒。
func TestConfirmSecondsSettingAppliesAndPersists(t *testing.T) {
	timeout, text := appuseConfirmTimeout, appuseConfirmText
	defer func() { appuseConfirmTimeout, appuseConfirmText = timeout, text }()
	setAppuseConfirmSeconds(0)
	if appuseConfirmSeconds() != appuseConfirmDefault || !strings.Contains(appuseConfirmText, "15 秒") {
		t.Fatalf("没设置时应回到默认 %d 秒：%d / %s", appuseConfirmDefault, appuseConfirmSeconds(), appuseConfirmText)
	}

	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32)}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveConfirm": {"1"}, "confirmSeconds": {"45"}}); w.Code != 303 || appuseConfirmSeconds() != 45 || w.Header().Get("Location") != "/config/test?saved=1&tab=computer" {
		t.Fatalf("保存确认时间应立即生效：%d / %d 秒", w.Code, appuseConfirmSeconds())
	}
	if !strings.Contains(appuseConfirmText, "45 秒") {
		t.Fatalf("卡上的说明要跟着改：%s", appuseConfirmText)
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.ConfirmSeconds != 45 {
		t.Fatalf("确认时间没落盘：%v", err)
	}
	if w := httptest.NewRecorder(); func() bool {
		a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=client", nil))
		page := w.Body.String()
		return strings.Contains(page, `name="saveConfirm"`) && strings.Contains(page, `value="45"`)
	}() == false {
		t.Fatal("设置页应显示当前确认时间")
	}
	if w := post(url.Values{"saveConfirm": {"1"}, "confirmSeconds": {"1"}}); w.Code != 400 || appuseConfirmSeconds() != 45 {
		t.Fatalf("越界的秒数不该保存：%d / %d 秒", w.Code, appuseConfirmSeconds())
	}
}
