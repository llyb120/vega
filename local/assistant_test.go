package main

import (
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAssistantEmbedsCurrentRenderer(t *testing.T) {
	for _, name := range []string{"assets/index-DcdocK0f.js", "assets/index-BkOHlEB9.css", "grok_bridge.js"} {
		data, err := fs.ReadFile(assistantResources, "resources/grok/"+name)
		if err != nil || len(data) == 0 {
			t.Fatalf("missing embedded renderer resource %s: %v", name, err)
		}
	}
	data, err := fs.ReadFile(assistantResources, "resources/grok/index.html")
	if err != nil || !strings.Contains(string(data), "index-DcdocK0f.js") || strings.Contains(string(data), "legacy=1") {
		t.Fatalf("embedded entry must load the current renderer without a legacy redirect: %v", err)
	}
}

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

func TestAssistantStreamForwardsBeforeUpstreamCloses(t *testing.T) {
	const token = "fixture-stream-token"
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/local-agent/chat/stream" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("unexpected stream request: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"ready\"}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	defer close(release)
	protected, err := protectToken(token)
	if err != nil {
		t.Skipf("token protection unavailable: %v", err)
	}
	agent := &Agent{pinnedOrigin: upstream.URL, configToken: "test", config: Config{Servers: []ServerCredential{{Origin: upstream.URL, Token: protected}}}}
	mux := http.NewServeMux()
	agent.assistantMount(mux)
	local := httptest.NewServer(mux)
	defer local.Close()
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Post(local.URL+agent.assistantPath()+"api/stream", "application/json", strings.NewReader(`{"thread":"employee:e1"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	buffer := make([]byte, len("data: {\"type\":\"ready\"}\n\n"))
	if _, err := io.ReadFull(response.Body, buffer); err != nil || !strings.Contains(string(buffer), "ready") {
		t.Fatalf("stream buffered until close: %q, %v", buffer, err)
	}
	if response.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatal("stream content type lost")
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

func TestAssistantSendForwardsAttachmentSizedBodies(t *testing.T) {
	const token = "fixture-device-token"
	var got int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/local-agent/chat/send" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("unexpected request: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		got = len(body)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	protected, err := protectToken(token)
	if err != nil {
		t.Skipf("token protection unavailable: %v", err)
	}
	agent := &Agent{pinnedOrigin: server.URL, configToken: "test", config: Config{Servers: []ServerCredential{{Origin: server.URL, Token: protected}}}}
	mux := http.NewServeMux()
	agent.assistantMount(mux)
	payload := `{"text":"` + strings.Repeat("A", 2<<20) + `"}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, agent.assistantPath()+"api/send", strings.NewReader(payload))
	request.Header.Set("Origin", "http://"+localAddress)
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || got != len(payload) {
		t.Fatalf("attachment-sized send was not forwarded: status %d, got %d of %d", recorder.Code, got, len(payload))
	}
}
