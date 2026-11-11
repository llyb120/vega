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

func TestBrowserMasterIsSavedPerEmployee(t *testing.T) {
	if browserPlace("") != "cloud" || browserPlace("local") != "local" || browserPlace("bogus") != "cloud" {
		t.Fatal("unset or unknown values must mean the server browser")
	}
	origin := "https://vega.example"
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	self := strings.Repeat("a", 32)
	a := &Agent{configPath: path, config: Config{ClientID: self, TrustedOrigins: []string{origin}}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	if err := a.saveBrowserPlace("cloud"); err == nil {
		t.Fatal("旧的账户级浏览器接口必须要求指定牛马")
	}
	if err := a.saveBrowserMaster("emp-a", "cloud"); err != nil {
		t.Fatal(err)
	}
	if err := a.saveBrowserMaster("emp-b", "local"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil {
		t.Fatalf("config not persisted: %v", err)
	}
	if a.rememberedEmployeeMaster("emp-a", "browser") != "cloud" {
		t.Fatal("emp-a browser master should be cloud")
	}
	if a.rememberedEmployeeMaster("emp-b", "browser") != self {
		t.Fatal("local must mean this client")
	}

	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveBrowserMaster": {"1"}, "employeeId": {"emp-a"}, "browserMaster": {self}}); w.Code != 303 {
		t.Fatalf("form must save per-employee browser master: %d %s", w.Code, w.Body.String())
	}
	if a.rememberedEmployeeMaster("emp-a", "browser") != self {
		t.Fatal("emp-a browser master not updated")
	}
	a.runtime = &RuntimeView{Employees: []EmployeeMasterView{{ID: "emp-a", Name: "甲", FsMaster: "cloud", BrowserMaster: self}}}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=access", nil))
	page := w.Body.String()
	if !strings.Contains(page, "浏览器 Master") || !strings.Contains(page, "甲") {
		t.Fatal("page must offer the per-employee browser Master")
	}
	if strings.Contains(page, `name="loginState"`) || strings.Contains(page, `name="sshKeys"`) || strings.Contains(page, "本地 SSH 密钥授权") {
		t.Fatal("login-state and SSH switches must be removed")
	}
}

func TestLoginStateIsAlwaysAllowed(t *testing.T) {
	off := false
	agent := &Agent{config: Config{LoginState: &off}}
	if !agent.config.loginAllowed() {
		t.Fatal("旧的登录态关闭配置也必须视为允许")
	}
	w := httptest.NewRecorder()
	agent.configPath = filepath.Join(t.TempDir(), "trusted-sites.json")
	_ = agent.saveConfig(agent.config)
	agent.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=access", nil))
	if strings.Contains(w.Body.String(), `name="loginState"`) {
		t.Fatal("page must not show the login-state switch")
	}
}

func TestHelloAndHeartbeatCarryTheBrowserLocation(t *testing.T) {
	runner := newJobRunner(nil, false)
	if runner.browser != "" || runner.loginState != nil {
		t.Fatal("a fresh runner must not claim a location or a login state")
	}
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32), Browser: "local"}}
	if browserPlace(agent.config.Browser) != "local" || !agent.config.loginAllowed() {
		t.Fatal("saved preference must reach the hello message")
	}
	off := false
	agent.config.LoginState = &off
	if !agent.config.loginAllowed() {
		t.Fatal("the deprecated switch must no longer stop the migration")
	}
}
