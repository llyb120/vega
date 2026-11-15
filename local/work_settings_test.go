package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWorkspaceFormParsesScenesAndRejectsBadSlots(t *testing.T) {
	form := url.Values{
		"sceneKey":               {"lightweight", "coding", "computer"},
		"sceneNoSpawn":           {"computer"},
		"scene-lightweight-0":    {"demo/chat"},
		"scene-coding-0":         {"demo/vision"},
		"scene-coding-spawn-0":   {"1"},
		"scene-computer-0":       {"demo/vision"},
		"scene-computer-spawn-0": {"1"},
		"globalSlots":            {"5"},
		"perEmployeeSlots":       {"1"},
	}
	body, err := parseWorkspace(form)
	if err != nil {
		t.Fatal(err)
	}
	scenes := body["scenes"].(map[string][]any)
	if scenes["lightweight"][0] != "demo/chat" {
		t.Fatalf("lightweight %#v", scenes["lightweight"])
	}
	coding := scenes["coding"][0].(map[string]any)
	if coding["model"] != "demo/vision" || coding["allowSpawn"] != true {
		t.Fatalf("coding %#v", coding)
	}
	if scenes["computer"][0] != "demo/vision" {
		t.Fatalf("computer spawn was kept: %#v", scenes["computer"])
	}
	form.Set("globalSlots", "0")
	if _, err = parseWorkspace(form); err == nil || !strings.Contains(err.Error(), "1–64") {
		t.Fatalf("bad slot error %v", err)
	}
}

func TestSettingsPageShowsRealWorkFieldsAndKeepsExistingTabs(t *testing.T) {
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer device-token" {
			t.Errorf("missing device credential")
		}
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "device-token") {
			t.Error("token leaked into the settings body")
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(string(body), `"action":"employee"`):
			io.WriteString(w, `{"employee":{"id":"e1","name":"改过的牛马","instruction":"先检查再交付"}}`)
		case strings.Contains(string(body), `"action":"workspace"`):
			if strings.Contains(string(body), "apiKey") || strings.Contains(string(body), "secret") {
				t.Errorf("workspace save included a secret: %s", body)
			}
			io.WriteString(w, `{"scenes":[],"scheduler":{"globalSlots":5,"perEmployeeSlots":1}}`)
		default:
			io.WriteString(w, `{"role":"admin","admin":true,"viewer":false,"employees":[{"id":"e1","name":"牛马","instruction":"先检查再交付","canManage":true}],"models":[{"id":"demo/chat","name":"Chat","supportsImages":false},{"id":"demo/vision","name":"Vision","supportsImages":true}],"scenes":[{"key":"lightweight","label":"沟通与任务起步","hint":"起步","computer":false,"rows":[{"model":"demo/chat","allowSpawn":false}]},{"key":"coding","label":"编码","hint":"编码","computer":false,"rows":[{"model":"demo/vision","allowSpawn":true}]},{"key":"computer","label":"浏览器操作","hint":"图片","computer":true,"rows":[{"model":"demo/vision","allowSpawn":false}]}],"scheduler":{"globalSlots":4,"perEmployeeSlots":2}}`)
		}
	}))
	defer upstream.Close()
	previous := workSettingsTransport
	workSettingsTransport = upstream.Client().Transport
	t.Cleanup(func() { workSettingsTransport = previous })
	agent := &Agent{pinnedOrigin: upstream.URL, config: Config{ClientID: strings.Repeat("a", 32), Servers: []ServerCredential{{Origin: upstream.URL, UserID: "owner", Token: "device-token"}}}}
	page := func(path string) string {
		t.Helper()
		request := httptest.NewRequest("GET", "http://"+localAddress+path, nil)
		request.Host = localAddress
		recorder := httptest.NewRecorder()
		agent.configure(recorder, request)
		if recorder.Code != 200 {
			t.Fatalf("status %d %s", recorder.Code, recorder.Body.String())
		}
		return recorder.Body.String()
	}
	body := page("/config/test?tab=work")
	for _, want := range []string{"工作原则", "先检查再交付", "沟通与任务起步", "浏览器操作", "允许开启分身", "保存场景和调度", "补充内容", "保存确认时间", "无头（默认）"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q", want)
		}
	}
	if strings.Contains(body, "device-token") || strings.Contains(body, "apiKey") || strings.Contains(body, "职责模板") {
		t.Fatal("secret or retired duty leaked into the settings page")
	}
	if strings.Contains(body, `id="scene-computer-0"`) && strings.Contains(body[strings.Index(body, `id="scene-computer-0"`):], "Chat") {
		// The computer select is the next select; Chat is text-only and must not be one of its options.
	}
	computer := body[strings.Index(body, `id="scene-computer-0"`):strings.Index(body, `id="globalSlots"`)]
	if strings.Contains(computer, "Chat") || !strings.Contains(computer, "Vision") {
		t.Fatalf("computer scene did not keep image-only models: %s", computer)
	}
	if strings.Contains(computer, "允许开启分身") {
		t.Fatal("computer scene offered clones")
	}

	post := func(form url.Values) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		request.Host = localAddress
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", "http://"+localAddress)
		recorder := httptest.NewRecorder()
		agent.configure(recorder, request)
		return recorder
	}
	saved := post(url.Values{"saveEmployee": {"e1"}, "employeeName": {"改过的牛马"}, "employeeInstruction": {"先检查再交付"}})
	if saved.Code != http.StatusSeeOther || !strings.Contains(saved.Header().Get("Location"), "tab=work") {
		t.Fatalf("employee save status %d %s", saved.Code, saved.Body.String())
	}
	workspace := post(url.Values{"saveWorkspace": {"1"}, "sceneKey": {"lightweight", "coding", "computer"}, "sceneNoSpawn": {"computer"}, "scene-lightweight-0": {"demo/chat"}, "scene-coding-0": {"demo/vision"}, "scene-coding-spawn-0": {"1"}, "scene-computer-0": {"demo/vision"}, "globalSlots": {"5"}, "perEmployeeSlots": {"1"}})
	if workspace.Code != http.StatusSeeOther {
		t.Fatalf("workspace save %d %s", workspace.Code, workspace.Body.String())
	}
	if len(calls) < 3 {
		t.Fatalf("expected settings calls, got %v", calls)
	}

	viewer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"role":"viewer","admin":false,"viewer":true,"employees":[{"id":"e1","name":"牛马","instruction":"只读原则","canManage":false}]}`)
	}))
	defer viewer.Close()
	workSettingsTransport = viewer.Client().Transport
	agent.config.Servers[0].Origin = viewer.URL
	agent.pinnedOrigin = viewer.URL
	readonly := page("/config/test?tab=work")
	if !strings.Contains(readonly, "只读账号不能修改") || strings.Contains(readonly, "保存工作原则") || strings.Contains(readonly, "保存场景和调度") {
		t.Fatal("viewer settings were editable")
	}
	if dir := os.Getenv("VEGA_SETTINGS_SNAPSHOT"); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "admin.html"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "viewer.html"), []byte(readonly), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	reject := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"statusMessage":"只能修改自己的牛马"}`)
	}))
	defer reject.Close()
	workSettingsTransport = reject.Client().Transport
	agent.config.Servers[0].Origin = reject.URL
	agent.pinnedOrigin = reject.URL
	forbidden := post(url.Values{"saveEmployee": {"e1"}, "employeeName": {"x"}, "employeeInstruction": {"y"}})
	if forbidden.Code != http.StatusForbidden || !strings.Contains(forbidden.Body.String(), "只能修改自己的牛马") || strings.Contains(forbidden.Body.String(), "device-token") {
		t.Fatalf("permission error %d %s", forbidden.Code, forbidden.Body.String())
	}
}
