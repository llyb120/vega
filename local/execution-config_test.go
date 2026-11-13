package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfflineConfigIsIgnoredWhileProcessIsRunning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32), Offline: true, TrustedOrigins: []string{"https://vega.example"}}, direct: map[string]*directConnection{}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	page := w.Body.String()
	if strings.Contains(page, "已下线") || strings.Contains(page, `name="setOnline"`) || strings.Contains(page, `name="setOffline"`) {
		t.Fatal("旧的上下线开关必须从页面移除，进程开着就是上线")
	}
}
