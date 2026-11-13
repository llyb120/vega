package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 同一站点可以配多个账号（配对时新的追加在末尾）：蝴蝶面板要跟最近配对的账号走。
// 跟着最早那个的话，用户换了账号后面板左栏一直是空的。
func TestAssistantCredentialFollowsTheNewestPairing(t *testing.T) {
	newest, err := protectToken(strings.Repeat("n", 43))
	if err != nil {
		t.Skipf("token protection unavailable on this platform: %v", err)
	}
	oldest, err := protectToken(strings.Repeat("o", 43))
	if err != nil {
		t.Skipf("token protection unavailable on this platform: %v", err)
	}
	origin := "https://vega.example"
	agent := &Agent{pinnedOrigin: origin, config: Config{Servers: []ServerCredential{
		{Origin: origin, UserID: "old", Token: oldest},
		{Origin: origin, UserID: "new", Token: newest},
	}}}
	if _, token, ok := agent.assistantCredential(); !ok || token != strings.Repeat("n", 43) {
		t.Fatalf("picked %q (ok=%v), want the newest pairing", token, ok)
	}
	agent.config.Servers[1].Token = "broken"
	if _, token, ok := agent.assistantCredential(); !ok || token != strings.Repeat("o", 43) {
		t.Fatalf("picked %q (ok=%v), want the older pairing as fallback", token, ok)
	}
}

func TestAssistantFileProxyPreservesLargeDownloadAndChecksOrigin(t *testing.T) {
	const token = "fixture-device-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/local-agent/chat/file" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("unexpected request: %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		fmt.Fprint(w, `{"data":"`+strings.Repeat("Y", 9<<20)+`"}`)
	}))
	defer server.Close()
	protected, err := protectToken(token)
	if err != nil {
		t.Skipf("token protection unavailable: %v", err)
	}
	agent := &Agent{pinnedOrigin: server.URL, configToken: "test", config: Config{Servers: []ServerCredential{{Origin: server.URL, UserID: "u1", Token: protected}}}}
	mux := http.NewServeMux()
	agent.assistantMount(mux)
	post := func(origin string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, agent.assistantPath()+"api/file", strings.NewReader(`{"blobId":"blob-1"}`))
		request.Header.Set("Origin", origin)
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	if denied := post("https://untrusted.test"); denied.Code != http.StatusForbidden {
		t.Fatalf("foreign origin answered %d", denied.Code)
	}
	if response := post("http://" + localAddress); response.Code != http.StatusOK || response.Body.Len() <= 9<<20 {
		t.Fatalf("download proxy truncated or failed: status %d, bytes %d", response.Code, response.Body.Len())
	}
}
