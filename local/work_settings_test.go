package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestWorkSettingsFollowTheAccountAndDoNotInventDuties(t *testing.T) {
	unpaired := httptest.NewRecorder()
	(&Agent{pinnedOrigin: "http://127.0.0.1:1", config: Config{ClientID: strings.Repeat("a", 32)}}).configure(unpaired, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=work", nil))
	page := unpaired.Body.String()
	if !strings.Contains(page, `id="tab-work"`) || !strings.Contains(page, "已停用的工作职责") || strings.Contains(page, `name="saveBot"`) || strings.Contains(page, `name="sshKeys"`) || strings.Contains(page, "工作职责</") {
		t.Fatalf("unpaired work tab leaked a form or restored duties: %s", page)
	}

	const token = "fixture-settings-token"
	protected, err := protectToken(token)
	if err != nil {
		t.Skipf("token protection unavailable: %v", err)
	}
	var saw []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("missing device credential")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		save, _ := body["save"].(string)
		saw = append(saw, save)
		if save == "scenes" {
			http.Error(w, `{"statusMessage":"Administrator permission required"}`, http.StatusForbidden)
			return
		}
		if save == "bot" {
			bot, _ := body["bot"].(map[string]any)
			if bot["instruction"] != "先核对" || bot["idleMinutes"] != float64(9) || bot["cwd"] != nil {
				t.Errorf("bot save payload = %#v", bot)
			}
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		_, _ = io.WriteString(w, `{"role":"operator","admin":false,"bots":[{"id":"e1","name":"测试牛马","instruction":"a<b>","cwd":"D:\\work","idleMinutes":10,"takeoverSeconds":15,"editable":true}]}`)
	}))
	defer server.Close()
	agent := &Agent{pinnedOrigin: server.URL, configToken: "test", config: Config{ClientID: strings.Repeat("b", 32), Servers: []ServerCredential{{Origin: server.URL, Token: protected, UserID: "owner"}}}}
	recorder := httptest.NewRecorder()
	agent.configure(recorder, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=work", nil))
	body := recorder.Body.String()
	for _, want := range []string{"测试牛马", "a&lt;b&gt;", "只有管理员可以修改", "保存工作原则", `value="10"`, `value="15"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("work settings missing %q", want)
		}
	}
	if strings.Contains(body, "保存场景") || strings.Contains(body, token) || strings.Contains(body, `name="duty"`) {
		t.Fatal("operator page showed admin fields, a duty editor, or the device token")
	}

	post := func(form url.Values) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", "http://"+localAddress)
		response := httptest.NewRecorder()
		agent.configure(response, request)
		return response
	}
	if saved := post(url.Values{"saveBot": {"1"}, "botId": {"e1"}, "instruction": {"先核对"}, "idleMinutes": {"9"}, "takeoverSeconds": {"15"}}); saved.Code != 303 || saved.Header().Get("Location") != "/config/test?saved=1&tab=work" {
		t.Fatalf("bot settings were not saved: %d %s", saved.Code, saved.Body.String())
	}
	if bad := post(url.Values{"saveScheduler": {"1"}, "globalSlots": {"nope"}, "perEmployeeSlots": {"3"}}); bad.Code != 400 || !strings.Contains(bad.Body.String(), "整数") {
		t.Fatalf("invalid scheduler was accepted: %d %s", bad.Code, bad.Body.String())
	}
	if denied := post(url.Values{"saveScenes": {"1"}, "lightweightAdd": {"demo/fast"}, "codingAdd": {"demo/fast"}, "computerAdd": {"demo/fast"}}); denied.Code != 400 || !strings.Contains(denied.Body.String(), "Administrator") {
		t.Fatalf("operator scene save was not rejected: %d %s", denied.Code, denied.Body.String())
	}
}
