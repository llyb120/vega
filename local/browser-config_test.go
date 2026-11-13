package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestBrowserPlaceNormalizesToLocalOrCloud(t *testing.T) {
	if browserPlace("") != "cloud" || browserPlace("local") != "local" || browserPlace("bogus") != "cloud" {
		t.Fatal("unset or unknown values must mean the server browser")
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
