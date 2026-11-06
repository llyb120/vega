package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A multi-megabyte result over a slow uplink must not stall the socket: it is posted over HTTP while
// heartbeats keep flowing on the WebSocket, and the result is released once the server accepts it.
func TestLargeResultUploadsOverHTTPWithoutBlockingHeartbeat(t *testing.T) {
	clientID, token := strings.Repeat("c", 32), strings.Repeat("t", 43)
	pings := make(chan time.Time, 64)
	inline := make(chan map[string]any, 8)
	uploaded := make(chan map[string]any, 1)
	accepted := make(chan *backendPeer, 2)
	instances := make(chan string, 2)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/local-agent/result", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("X-Vega-Instance") == "" {
			http.Error(w, "unauthorized", 401)
			return
		}
		// Throttle the upload to ~1 MB/s, like a slow office uplink.
		var body []byte
		buf := make([]byte, 64<<10)
		for {
			n, err := r.Body.Read(buf)
			body = append(body, buf[:n]...)
			if err == io.EOF {
				break
			}
			if err != nil {
				return
			}
			time.Sleep(64 * time.Millisecond)
		}
		var value map[string]any
		if json.Unmarshal(body, &value) != nil {
			http.Error(w, "bad", 400)
			return
		}
		value["instance"] = r.Header.Get("X-Vega-Instance")
		uploaded <- value
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/api/local-agent/socket", func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello struct{ Type, ClientID, Instance string }
		if conn.ReadJSON(&hello) != nil || hello.Type != "hello" {
			return
		}
		peer := &backendPeer{conn: conn}
		_ = peer.send(map[string]any{"type": "ready", "userId": "alice", "clientId": clientID, "resume": true})
		instances <- hello.Instance
		accepted <- peer
		for {
			var value map[string]any
			if conn.ReadJSON(&value) != nil {
				return
			}
			if value["type"] == "ping" {
				pings <- time.Now()
				_ = peer.send(map[string]string{"type": "pong"})
			} else {
				inline <- value
			}
		}
	})
	backend := httptest.NewServer(mux)
	defer backend.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent := &Agent{config: Config{ClientID: clientID, TrustedOrigins: []string{backend.URL}}, connections: make(map[*websocket.Conn]struct{}), context: ctx}
	connection := agent.startConnection(ServerCredential{Origin: backend.URL, UserID: "alice"}, token)
	if connection == nil {
		t.Fatal("connection did not start")
	}
	peer := receive(t, accepted)
	instance := receive(t, instances)
	dir := t.TempDir()
	content := strings.Repeat("v", 6<<20) // ~8 MB once base64-encoded: ~8s at 1 MB/s
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	small, big := "01234567-0123-0123-0123-0123456789aa", "01234567-0123-0123-0123-0123456789bb"
	started := time.Now()
	if err := peer.send(map[string]any{"id": big, "op": "file", "args": map[string]string{"op": "read", "cwd": dir, "path": "big.txt"}}); err != nil {
		t.Fatal(err)
	}
	if err := peer.send(map[string]any{"id": small, "op": "exec", "args": map[string]any{"cwd": dir, "command": "echo hi", "timeout": 10}}); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, inline); got["id"] != small {
		t.Fatalf("small results stay on the socket and are not queued behind the big one: %v", got["id"])
	}
	var result map[string]any
	last, maxGap := started, time.Duration(0)
	for result == nil {
		select {
		case at := <-pings:
			if gap := at.Sub(last); gap > maxGap {
				maxGap = gap
			}
			last = at
		case result = <-uploaded:
		case value := <-inline:
			t.Fatalf("a large result went over the socket: %v", value["id"])
		case <-time.After(30 * time.Second):
			t.Fatal("large result never arrived")
		}
	}
	elapsed := time.Since(started)
	t.Logf("8 MB result uploaded in %s; longest heartbeat gap %s", elapsed.Round(time.Millisecond), maxGap.Round(time.Millisecond))
	if result["id"] != big || result["instance"] != instance {
		t.Fatalf("wrong upload: id=%v instance=%v", result["id"], result["instance"])
	}
	encoded := result["result"].(map[string]any)["content"].(string)
	if decoded, _ := base64.StdEncoding.DecodeString(encoded); string(decoded) != content {
		t.Fatal("upload corrupted the result")
	}
	if elapsed > 4*time.Second && maxGap > 7*time.Second {
		t.Fatalf("heartbeat stalled for %s during the upload", maxGap)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		connection.jobs.mu.Lock()
		_, retained := connection.jobs.tasks[big]
		connection.jobs.mu.Unlock()
		if !retained {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("an accepted upload was not released")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLargeResultFallsBackToSocketWhenUploadFails(t *testing.T) {
	clientID, token := strings.Repeat("c", 32), strings.Repeat("t", 43)
	inline := make(chan map[string]any, 8)
	accepted := make(chan *backendPeer, 2)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/local-agent/result", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upload broken", 503)
	})
	mux.HandleFunc("/api/local-agent/socket", func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello struct{ Type, ClientID, Instance string }
		if conn.ReadJSON(&hello) != nil || hello.Type != "hello" {
			return
		}
		peer := &backendPeer{conn: conn}
		_ = peer.send(map[string]any{"type": "ready", "userId": "alice", "clientId": clientID, "resume": true})
		accepted <- peer
		for {
			var value map[string]any
			if conn.ReadJSON(&value) != nil {
				return
			}
			if value["type"] == "ping" {
				_ = peer.send(map[string]string{"type": "pong"})
			} else {
				inline <- value
			}
		}
	})
	backend := httptest.NewServer(mux)
	defer backend.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent := &Agent{config: Config{ClientID: clientID, TrustedOrigins: []string{backend.URL}}, connections: make(map[*websocket.Conn]struct{}), context: ctx}
	connection := agent.startConnection(ServerCredential{Origin: backend.URL, UserID: "alice"}, token)
	if connection == nil {
		t.Fatal("connection did not start")
	}
	peer := receive(t, accepted)
	dir := t.TempDir()
	content := strings.Repeat("v", 300<<10) // > inlineResultLimit once wrapped as a result
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	id := "01234567-0123-0123-0123-0123456789cc"
	if err := peer.send(map[string]any{"id": id, "op": "file", "args": map[string]string{"op": "read", "cwd": dir, "path": "big.txt"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-inline:
		if got["id"] != id {
			t.Fatalf("expected socket fallback for %s, got %v", id, got["id"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("failed upload did not fall back to the WebSocket; server would time out while the link stays healthy")
	}
}
