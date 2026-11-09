package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRemovePairingIsScopedToServerAndAccount(t *testing.T) {
	const first = "http://vega.example:8317"
	const second = "https://other.example"
	for _, tc := range []struct {
		name, origin, user, requestOrigin string
		status                            int
		failSave, updating                bool
	}{
		{name: "connected account", origin: first, user: "alice", status: 303},
		{name: "offline account", origin: first, user: "old", status: 303},
		{name: "same account ID on another server", origin: second, user: "alice", status: 303},
		{name: "unknown account", origin: first, user: "missing", status: 400},
		{name: "unknown server", origin: "https://missing.example", user: "alice", status: 400},
		{name: "cross origin", origin: first, user: "alice", requestOrigin: "https://evil.example", status: 403},
		{name: "save fails", origin: first, user: "alice", failSave: true, status: 500},
		{name: "updating", origin: first, user: "alice", updating: true, status: 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := Config{ClientID: strings.Repeat("c", 32), Supplement: "keep", TrustedOrigins: []string{first, second}, Servers: []ServerCredential{
				{Origin: first, UserID: "alice", Token: "secret-a", Relay: []string{"git.internal:443"}},
				{Origin: first, UserID: "old", Token: "secret-old"},
				{Origin: second, UserID: "alice", Token: "secret-b", Relay: []string{"other.internal:443"}},
			}}
			path := filepath.Join(t.TempDir(), "trusted-sites.json")
			a := &Agent{configPath: path, config: config, direct: make(map[string]*directConnection), updating: tc.updating}
			contexts := map[string]context.Context{}
			for _, origin := range []string{first, second} {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				key := origin + "\x00alice"
				contexts[key] = ctx
				a.direct[key] = &directConnection{origin: origin, cancel: cancel, status: connectionStatus{Code: "connected"}}
			}
			if err := a.saveConfig(config); err != nil {
				t.Fatal(err)
			}
			page := httptest.NewRecorder()
			a.configure(page, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
			for _, account := range config.Servers {
				label := "所属服务器地址：<strong><code>" + account.Origin + "</code></strong><br>账户 ID：<code>" + account.UserID + "</code>"
				confirmation := "确认移除 " + account.Origin + " 下账户 " + account.UserID + " 的配对"
				if !strings.Contains(page.Body.String(), label) || !strings.Contains(page.Body.String(), confirmation) {
					t.Fatal("account row or removal confirmation does not identify its server and account")
				}
			}
			if strings.Contains(page.Body.String(), "secret-") {
				t.Fatal("device credentials exposed")
			}
			if tc.failSave {
				a.configPath = filepath.Join(path, "blocked.json") // The parent is a file, so saving must fail.
			}
			form := url.Values{"removeAccount": {"1"}, "relayOrigin": {tc.origin}, "relayUser": {tc.user}}
			r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			requestOrigin := tc.requestOrigin
			if requestOrigin == "" {
				requestOrigin = "http://" + localAddress
			}
			r.Header.Set("Origin", requestOrigin)
			response := httptest.NewRecorder()
			a.configure(response, r)
			if response.Code != tc.status {
				t.Fatalf("HTTP %d: %s", response.Code, response.Body.String())
			}
			expected := config
			if tc.status == 303 {
				expected.Servers = nil
				for _, saved := range config.Servers {
					if saved.Origin != tc.origin || saved.UserID != tc.user {
						expected.Servers = append(expected.Servers, saved)
					}
				}
				if response.Header().Get("Location") != "/config/test?unpaired=1&tab=relay" {
					t.Fatal("missing removal confirmation")
				}
			}
			if !reflect.DeepEqual(a.config, expected) {
				t.Fatal("wrong account removed, or unrelated configuration changed")
			}
			data, err := os.ReadFile(path)
			var persisted Config
			if err != nil || json.Unmarshal(data, &persisted) != nil || !reflect.DeepEqual(persisted, expected) {
				t.Fatal("persisted configuration differs from expected")
			}
			for key, ctx := range contexts {
				removed := tc.status == 303 && key == tc.origin+"\x00"+tc.user
				if (ctx.Err() != nil) != removed || (a.direct[key] == nil) != removed {
					t.Fatal("wrong connection cancelled or removed from the registry")
				}
			}
		})
	}
}
