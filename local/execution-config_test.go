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

func TestFsMasterIsSavedPerEmployee(t *testing.T) {
	origin := "https://vega.example"
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	self := strings.Repeat("a", 32)
	a := &Agent{configPath: path, config: Config{ClientID: self, TrustedOrigins: []string{origin}}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	if err := a.saveExecutionPlace("cloud"); err == nil {
		t.Fatal("旧的账户级执行位置接口必须要求指定牛马")
	}
	if err := a.saveFsMaster("", "cloud"); err == nil {
		t.Fatal("未指定牛马不能保存文件系统 Master")
	}
	if err := a.saveFsMaster("emp-a", "cloud"); err != nil {
		t.Fatal(err)
	}
	if err := a.saveFsMaster("emp-b", self); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil {
		t.Fatalf("config not persisted: %v", err)
	}
	if got := a.rememberedEmployeeMaster("emp-a", "fs"); got != "cloud" {
		t.Fatalf("emp-a fs master: %s", got)
	}
	if got := a.rememberedEmployeeMaster("emp-b", "fs"); got != self {
		t.Fatalf("emp-b fs master: %s", got)
	}

	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveFsMaster": {"1"}, "employeeId": {"emp-a"}, "fsMaster": {self}}); w.Code != 303 {
		t.Fatalf("form must save per-employee fs master: %d %s", w.Code, w.Body.String())
	}
	if a.rememberedEmployeeMaster("emp-a", "fs") != self || a.rememberedEmployeeMaster("emp-b", "fs") != self {
		t.Fatal("saving emp-a must not clear emp-b")
	}
	a.runtime = &RuntimeView{Employees: []EmployeeMasterView{
		{ID: "emp-a", Name: "甲", FsMaster: "cloud", BrowserMaster: "cloud"},
		{ID: "emp-b", Name: "乙", FsMaster: self, BrowserMaster: "cloud"},
	}}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=client", nil))
	page := w.Body.String()
	if !strings.Contains(page, "文件系统 Master") || !strings.Contains(page, "甲") || !strings.Contains(page, "乙") {
		t.Fatal("page must list each employee's filesystem Master")
	}
	if strings.Contains(page, "接单状态") || strings.Contains(page, `name="setOffline"`) || strings.Contains(page, "保存执行位置") {
		t.Fatal("page must not offer 接单状态 or the old execution-place switch")
	}
}

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
