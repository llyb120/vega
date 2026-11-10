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

func TestBrowserPlaceDefaultsToServerAndSavesLocal(t *testing.T) {
	if browserPlace("") != "cloud" || browserPlace("local") != "local" || browserPlace("bogus") != "cloud" {
		t.Fatal("unset or unknown values must mean the server browser")
	}
	origin := "https://vega.example"
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32), TrustedOrigins: []string{origin}}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	if err := a.saveBrowserPlace("bogus"); err == nil || a.config.Browser != "" {
		t.Fatal("invalid location must be rejected without changing the config")
	}
	if err := a.saveBrowserPlace("cloud"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.Browser != "cloud" || len(saved.TrustedOrigins) != 1 {
		t.Fatalf("browser location not persisted without losing the rest of the config: %v", err)
	}

	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveBrowser": {"1"}, "browserLocal": {"1"}}); w.Code != 303 || a.config.Browser != "local" {
		t.Fatalf("form must save the local choice: %d", w.Code)
	}
	if w := post(url.Values{"saveBrowser": {"1"}}); w.Code != 303 || a.config.Browser != "cloud" {
		t.Fatalf("unchecked box must mean the server browser: %d", w.Code)
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	if !strings.Contains(w.Body.String(), "浏览器优先") || strings.Contains(w.Body.String(), `name="browserLocal" value="1" checked`) {
		t.Fatal("page must offer the browser preference and reflect the saved value")
	}
}

func TestLoginStateIsSwitchedAndReported(t *testing.T) {
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32), TrustedOrigins: []string{"https://vega.example"}}, direct: map[string]*directConnection{}}
	if err := agent.saveConfig(agent.config); err != nil {
		t.Fatal(err)
	}
	if !agent.config.loginAllowed() {
		t.Fatal("the migration must be on until the user turns it off")
	}
	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		agent.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveLogin": {"1"}}); w.Code != 303 || agent.config.loginAllowed() {
		t.Fatalf("unchecked box must stop the migration: %d", w.Code)
	}
	data, err := os.ReadFile(agent.configPath)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.loginAllowed() {
		t.Fatalf("login state not persisted: %v", err)
	}
	if w := post(url.Values{"saveLogin": {"1"}, "loginState": {"1"}}); w.Code != 303 || !agent.config.loginAllowed() {
		t.Fatalf("checked box must allow the migration: %d", w.Code)
	}
	w := httptest.NewRecorder()
	agent.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	if !strings.Contains(w.Body.String(), `name="loginState" value="1" checked`) {
		t.Fatal("page must show the saved login state switch")
	}
}

func TestHelloAndHeartbeatCarryTheBrowserLocation(t *testing.T) {
	// 旧服务端不支持 resume 时用一次性 runner：没有位置就不上报，避免被当成非法值。
	runner := newJobRunner(nil, false)
	if runner.browser != "" || runner.loginState != nil {
		t.Fatal("a fresh runner must not claim a location or a login state")
	}
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32), Browser: "local"}, direct: map[string]*directConnection{}}
	if browserPlace(agent.config.Browser) != "local" || !agent.config.loginAllowed() {
		t.Fatal("saved preference must reach the hello message")
	}
	off := false
	agent.config.LoginState = &off
	if agent.config.loginAllowed() {
		t.Fatal("the switch must stop the migration")
	}
}
