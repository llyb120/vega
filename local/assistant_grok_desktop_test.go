//go:build windows || (darwin && cgo)

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAssistantGrokReplacesClassicMount(t *testing.T) {
	a := &Agent{configToken: "fixture"}
	mux := http.NewServeMux()
	a.assistantMount(mux)
	base := a.assistantPath()
	grok := base + assistantGrokPath
	for _, test := range []struct{ path, content, body string }{
		{grok, "text/html", "grok_bridge.js"},
		{grok + "grok_bridge.js", "javascript", "coordinatorPort"},
		{grok + "assets/index-DcdocK0f.js", "javascript", ""},
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, test.path, nil))
		if w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Content-Type"), test.content) || !strings.Contains(w.Body.String(), test.body) {
			t.Fatalf("GET %s: status=%d, content-type=%s", test.path, w.Code, w.Header().Get("Content-Type"))
		}
		if test.path == grok && (!strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") || w.Header().Get("Referrer-Policy") != "no-referrer") {
			t.Fatal("renderer must not leak its loopback path or allow external frames")
		}
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, base, nil))
	if w.Code != http.StatusFound || w.Header().Get("Location") != grok {
		t.Fatal("the old URL must resolve to the new renderer")
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, base+"marked.js", nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("Windows must not serve the classic renderer")
	}
	for _, test := range []struct {
		path, origin string
		status       int
	}{
		{grok + "api/threads", "https://not-the-site.test", http.StatusForbidden},
		{grok + "api/threads", "", http.StatusConflict},
		{grok + "api/create", "", http.StatusNotFound},
		{"/assistant/wrong/grok/api/threads", "", http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader("{}"))
		r.Header.Set("Origin", test.origin)
		mux.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("POST %s: got %d, want %d", test.path, w.Code, test.status)
		}
	}
}
