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

// 蝴蝶默认关闭；设置里打开才显示，且开关落盘（重启不会自己变回去）。
func TestButterflySettingDefaultsOffAndPersists(t *testing.T) {
	butterflyQuiet = true
	defer func() {
		butterflySetEnabled(true) // 仍处于 quiet：只复位开关，不碰真实窗口
		butterflyClear()
		butterflyQuiet = false
	}()
	// 与启动时一致：按配置默认关。
	butterflySetEnabled(false)

	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32)}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	if a.config.Butterfly {
		t.Fatal("新配置默认不显示蝴蝶")
	}
	butterflyNotify("needs_review", "需要核对")
	if butterflySnapshot() != nil {
		t.Fatal("默认关闭时不应留提示")
	}
	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=client", nil))
	if page := w.Body.String(); !strings.Contains(page, `name="saveButterfly"`) || strings.Contains(page, `name="butterflyOn" value="1" checked`) {
		t.Fatal("配置页默认不勾选蝴蝶开关")
	} else if !strings.Contains(page, `id="tab-client" class="tab" checked`) || !strings.Contains(page, `id="panel-client"`) {
		t.Fatal("保存后应停在「本机」页签")
	}

	if w := post(url.Values{"saveButterfly": {"1"}, "butterflyOn": {"1"}}); w.Code != 303 || !a.config.Butterfly || w.Header().Get("Location") != "/config/test?saved=1&tab=client" {
		t.Fatalf("勾选必须打开蝴蝶：%d", w.Code)
	}
	butterflyNotify("needs_review", "需要核对")
	if butterflySnapshot() == nil {
		t.Fatal("打开后提示应恢复")
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || !saved.Butterfly {
		t.Fatalf("蝴蝶开关没落盘：%v", err)
	}

	if w := post(url.Values{"saveButterfly": {"1"}}); w.Code != 303 || a.config.Butterfly {
		t.Fatalf("不勾选必须关掉蝴蝶：%d", w.Code)
	}
}
