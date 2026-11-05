package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRelayRulesAndAddressPolicy(t *testing.T) {
	rules, err := relayRules(" Git.Internal \ngit.internal:443\napi.internal:8080\n")
	if err != nil || !reflect.DeepEqual(rules, []string{"api.internal:8080", "git.internal:443", "git.internal:80"}) {
		t.Fatalf("%v %v", rules, err)
	}
	for _, value := range []string{"http://git.internal", "*.internal", "localhost", "x.localhost", "127.0.0.1:80", "[::1]:443", "bad..test", "-bad.test", "bad-.test", "a.test:0", "a.test:65536", "a.test:+80", "中文.test", "a.test:80:90", "a.test:８０", strings.Repeat("a", 64) + ".test"} {
		if _, err := relayRules(value); err == nil {
			t.Errorf("accepted %q", value)
		}
	}
	for _, value := range []string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "::", "169.254.169.254", "fe80::1", "224.0.0.1", "ff02::1", "255.255.255.255"} {
		if relayIPAllowed(net.ParseIP(value)) {
			t.Errorf("unsafe address %s", value)
		}
	}
	for _, value := range []string{"10.1.2.3", "192.168.1.2", "172.16.0.1", "fd00::1"} {
		if !relayIPAllowed(net.ParseIP(value)) {
			t.Errorf("intranet address rejected: %s", value)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if conn, err := dialRelay(ctx, "localhost", 80); err == nil {
		conn.Close()
		t.Fatal("resolved loopback must be blocked")
	}
}

func TestConnectionPageSavesAccountRelayAndSupplement(t *testing.T) {
	origin := "https://vega.example"
	a := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32), Supplement: "</textarea><script>bad</script>", TrustedOrigins: []string{origin}, Servers: []ServerCredential{{Origin: origin, UserID: "alice", Token: "secret-a"}, {Origin: origin, UserID: "bob", Token: "secret-b"}}}}
	post := func(form url.Values, requestOrigin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", requestOrigin)
		w := httptest.NewRecorder()
		a.configure(w, r)
		return w
	}
	form := url.Values{"saveRelay": {"1"}, "relayOrigin": {origin}, "relayUser": {"alice"}, "relayRules": {"git.internal\napi.internal:8080"}}
	if w := post(form, "https://evil.test"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := post(form, "http://"+localAddress); w.Code != 303 {
		t.Fatal(w.Body.String())
	}
	if len(a.config.Servers[0].Relay) != 3 || len(a.config.Servers[1].Relay) != 0 || a.config.Servers[0].Token != "secret-a" {
		t.Fatal("account isolation or credentials changed")
	}
	data, _ := os.ReadFile(a.configPath)
	var saved Config
	if json.Unmarshal(data, &saved) != nil || len(saved.Servers[0].Relay) != 3 {
		t.Fatal("rules not persisted")
	}
	form.Set("relayUser", "unknown")
	if w := post(form, "http://"+localAddress); w.Code != 400 {
		t.Fatal("unknown account accepted")
	}
	form.Set("relayUser", "alice")
	form.Set("relayRules", "*.internal")
	if w := post(form, "http://"+localAddress); w.Code != 400 || len(a.config.Servers[0].Relay) != 3 {
		t.Fatal("invalid rules replaced saved policy")
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	for _, text := range []string{"补充内容", "流量中继", "git.internal:443", "alice", "bob", "&lt;/textarea&gt;"} {
		if !strings.Contains(w.Body.String(), text) {
			t.Errorf("missing %s", text)
		}
	}
	if strings.Contains(w.Body.String(), "secret-") || strings.Contains(w.Body.String(), "<script>bad</script>") {
		t.Fatal("credentials or unescaped content in page")
	}
	supplement := url.Values{"saveSupplement": {"1"}, "supplement": {"新项目目录\nD:\\code"}}
	if w := post(supplement, "http://"+localAddress); w.Code != 303 || a.config.Supplement != supplement.Get("supplement") {
		t.Fatal("supplement not saved")
	}
	supplement.Set("supplement", strings.Repeat("中", 3000))
	if w := post(supplement, "http://"+localAddress); w.Code != 400 {
		t.Fatal("oversized supplement accepted")
	}
	supplement.Set("supplement", "")
	if w := post(supplement, "http://"+localAddress); w.Code != 303 || a.config.Supplement != "" {
		t.Fatal("supplement not cleared")
	}
	form.Set("relayRules", "")
	if w := post(form, "http://"+localAddress); w.Code != 303 || len(a.config.Servers[0].Relay) != 0 {
		t.Fatal("relay not disabled")
	}
}

func TestRelayPumpStreamsBinaryBothWaysWithAcknowledgements(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	local, target := net.Pipe()
	defer local.Close()
	defer target.Close()
	request := []byte("request\x00payload")
	response := bytes.Repeat([]byte{0, 1, 255, 17}, relayFrame/2+37)
	result := make(chan []byte, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.SetReadDeadline(time.Now().Add(4 * time.Second))
		kind, frame, err := ws.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(frame, []byte{2}) {
			return
		}
		if ws.WriteMessage(websocket.BinaryMessage, append([]byte{0}, request...)) != nil {
			return
		}
		received := []byte{}
		acknowledged := false
		for len(received) < len(response) || !acknowledged {
			_, frame, err = ws.ReadMessage()
			if err != nil || len(frame) == 0 {
				return
			}
			if frame[0] == 1 {
				acknowledged = true
				continue
			}
			if frame[0] != 0 || len(frame) > relayFrame+1 {
				return
			}
			received = append(received, frame[1:]...)
			if ws.WriteMessage(websocket.BinaryMessage, []byte{1}) != nil {
				return
			}
		}
		result <- received
	}))
	defer backend.Close()
	ws, _, err := websocket.DefaultDialer.DialContext(ctx, "ws"+strings.TrimPrefix(backend.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	done := make(chan struct{})
	go func() { pumpRelay(ctx, local, ws); close(done) }()
	target.SetDeadline(time.Now().Add(4 * time.Second))
	actual := make([]byte, len(request))
	if _, err := io.ReadFull(target, actual); err != nil || !bytes.Equal(actual, request) {
		t.Fatalf("request %q %v", actual, err)
	}
	if _, err := target.Write(response); err != nil {
		t.Fatal(err)
	}
	select {
	case actual = <-result:
		if !bytes.Equal(actual, response) {
			t.Fatal("response corruption")
		}
	case <-ctx.Done():
		t.Fatal("relay timed out")
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("relay did not close")
	}
}
