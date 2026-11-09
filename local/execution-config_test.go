package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutionPlaceDefaultsToClientAndSavesCloud(t *testing.T) {
	if executionPlace("") != "client" || executionPlace("cloud") != "cloud" || executionPlace("bogus") != "client" {
		t.Fatal("unset or unknown values must mean client-first execution")
	}
	origin := "https://vega.example"
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32), TrustedOrigins: []string{origin}}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	if err := a.saveExecutionPlace("bogus"); err == nil || a.config.Prefer != "" {
		t.Fatal("invalid location must be rejected without changing the config")
	}
	if err := a.saveExecutionPlace("cloud"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.Prefer != "cloud" || len(saved.TrustedOrigins) != 1 {
		t.Fatalf("execution location not persisted without losing the rest of the config: %v", err)
	}

	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveExecution": {"1"}, "executionClient": {"1"}}); w.Code != 303 || a.config.Prefer != "client" {
		t.Fatalf("form must save the client-first choice: %d", w.Code)
	}
	if w := post(url.Values{"saveExecution": {"1"}}); w.Code != 303 || a.config.Prefer != "cloud" {
		t.Fatalf("unchecked box must mean server-first execution: %d", w.Code)
	}
}

func TestOfflineLeavesTheConnectionToTheHandoff(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32)}, direct: map[string]*directConnection{}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	connectionCtx, stop := context.WithCancel(ctx)
	a.direct["https://vega.example\x00u1"] = &directConnection{jobs: newJobRunner(connectionCtx, true), cancel: stop}
	if err := a.setOnline(false); err != nil {
		t.Fatal(err)
	}
	if connectionCtx.Err() != nil {
		t.Fatal("下线要先把连接留给站点交接，交接完由站点断开；立刻断开只能硬交接")
	}
}

func TestOfflineStopsTakingWorkAndComesBackOnline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	a := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32)}, direct: map[string]*directConnection{}}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	if err := a.setOnline(false); err != nil {
		t.Fatal(err)
	}
	if !a.config.Offline {
		t.Fatal("going offline must persist so a restart does not silently take work")
	}
	if a.startConnection(ServerCredential{Origin: "https://vega.example", UserID: "u1"}, "token") != nil {
		t.Fatal("an offline client must not connect to any site")
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	if page := w.Body.String(); !strings.Contains(page, "已下线") || !strings.Contains(page, `name="setOnline"`) {
		t.Fatal("page must show the offline state and offer coming back online")
	}
	if err := a.setOnline(true); err != nil || a.config.Offline {
		t.Fatalf("coming back online must clear the flag: %v", err)
	}
}
