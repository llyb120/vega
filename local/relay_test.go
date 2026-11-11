package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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

func TestConnectionPageSavesAccountPairingAndSupplement(t *testing.T) {
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
	form := url.Values{"saveRelay": {"1"}, "relayOrigin": {origin}, "relayUser": {"alice"}, "relayOn": {"1"}}
	if w := post(form, "https://evil.test"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if a.config.Servers[0].Token != "secret-a" || a.config.Servers[1].Token != "secret-b" {
		t.Fatal("account isolation or credentials changed")
	}
	w := httptest.NewRecorder()
	a.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test", nil))
	page := w.Body.String()
	for _, text := range []string{"补充内容", "账户配对", "alice", "bob", "&lt;/textarea&gt;"} {
		if !strings.Contains(page, text) {
			t.Errorf("missing %s", text)
		}
	}
	if strings.Contains(page, "启用流量中继") || strings.Contains(page, `name="relayOn"`) || strings.Contains(page, "secret-") || strings.Contains(page, "<script>bad</script>") {
		t.Fatal("relay switch or credentials leaked into the page")
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
	if !a.config.Servers[0].relayAllowed() {
		t.Fatal("中继开关已取消，必须允许借用网桥")
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
	backend := httptest.NewServer(newChannelServer(func(peer *channelPeer, r *http.Request) {
		ready, ok := peer.poll()
		if !ok || !bytes.Equal(ready.binary, []byte{2}) {
			return
		}
		if peer.sendFrame(append([]byte{0}, request...)) != nil {
			return
		}
		received := []byte{}
		acknowledged := false
		for len(received) < len(response) || !acknowledged {
			frame, ok := peer.poll()
			if !ok || len(frame.binary) == 0 {
				return
			}
			if frame.binary[0] == 1 {
				acknowledged = true
				continue
			}
			if frame.binary[0] != 0 || len(frame.binary) > relayFrame+1 {
				return
			}
			received = append(received, frame.binary[1:]...)
			if peer.sendFrame([]byte{1}) != nil {
				return
			}
		}
		result <- received
	}))
	defer backend.Close()
	ws, _, err := DialContext(ctx, "http"+strings.TrimPrefix(backend.URL, "http"), nil)
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

func TestRelaySwitchAndPermits(t *testing.T) {
	off := false
	on := true
	legacy := ServerCredential{Relay: []string{"git.internal:443"}}
	if !legacy.relayAllowed() {
		t.Fatal("legacy credentials with rules stay enabled")
	}
	legacy.RelayOn = &off
	if !legacy.relayAllowed() {
		t.Fatal("旧的关闭开关也必须视为允许")
	}
	legacy.RelayOn = &on
	if !legacy.relayAllowed() {
		t.Fatal("switch on should re-enable saved rules")
	}
	if !(ServerCredential{RelayOn: &on}).relayAllowed() {
		t.Fatal("an enabled switch with no rules still serves fallback traffic")
	}
	if !(ServerCredential{}).relayAllowed() {
		t.Fatal("a never configured account counts as allowed")
	}
	rules := []string{"git.internal:443"}
	for _, test := range []struct {
		enabled  bool
		target   relayTarget
		expected bool
	}{
		{true, relayTarget{Host: "git.internal", Port: 443}, true},
		{true, relayTarget{Host: "git.internal", Port: 22}, false},
		{true, relayTarget{Host: "api.internal", Port: 443, Fallback: true}, true},
		{true, relayTarget{Host: "api.internal", Port: 443}, false},
		{false, relayTarget{Host: "git.internal", Port: 443}, false},
		{false, relayTarget{Host: "api.internal", Port: 443, Fallback: true}, false},
	} {
		if relayPermits(rules, test.enabled, test.target) != test.expected {
			t.Errorf("permits(%v) = %v", test, !test.expected)
		}
	}
}
