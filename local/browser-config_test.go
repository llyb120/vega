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

func TestBrowserPlaceDefaultsToLocalAndSavesCloud(t *testing.T) {
	if browserPlace("") != "local" || browserPlace("cloud") != "cloud" || browserPlace("bogus") != "local" {
		t.Fatal("unset or unknown values must mean the local browser")
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
		t.Fatalf("unchecked box must mean the cloud browser: %d", w.Code)
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	if !strings.Contains(w.Body.String(), "浏览器位置") || strings.Contains(w.Body.String(), `name="browserLocal" value="1" checked`) {
		t.Fatal("page must offer the browser location and reflect the saved value")
	}
}

func TestHelloAndHeartbeatCarryTheBrowserLocation(t *testing.T) {
	// 旧服务端不支持 resume 时用一次性 runner：没有位置就不上报，避免被当成非法值。
	runner := newJobRunner(nil, false)
	if runner.browser != "" {
		t.Fatal("a fresh runner must not claim a location")
	}
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32), Browser: "cloud"}, direct: map[string]*directConnection{}}
	if browserPlace(agent.config.Browser) != "cloud" {
		t.Fatal("saved location must reach the hello message")
	}
}
