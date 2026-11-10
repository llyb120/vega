package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNativeReconnectKeepsRunningJobsAndResendsOnlyUnacknowledgedResults(t *testing.T) {
	clientID, token := strings.Repeat("c", 32), strings.Repeat("t", 43)
	type resumedPeer struct {
		*backendPeer
		instance string
	}
	accepted := make(chan resumedPeer, 8)
	results := make(chan map[string]any, 8)
	var mu sync.Mutex
	wanted := []string{}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", 401)
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello struct {
			Type, ClientID, Instance string
			Resume                   bool
		}
		if conn.ReadJSON(&hello) != nil || hello.Type != "hello" || hello.ClientID != clientID || !hello.Resume {
			return
		}
		peer := &backendPeer{conn: conn}
		mu.Lock()
		pending := append([]string{}, wanted...)
		mu.Unlock()
		_ = peer.send(map[string]any{"type": "ready", "userId": "alice", "clientId": clientID, "resume": true, "pending": pending})
		accepted <- resumedPeer{peer, hello.Instance}
		for {
			var value map[string]any
			if conn.ReadJSON(&value) != nil {
				return
			}
			if value["type"] == "ping" {
				_ = peer.send(map[string]string{"type": "pong"})
			} else {
				results <- value
			}
		}
	}))
	defer backend.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent := &Agent{pinnedOrigin: backend.URL, config: Config{ClientID: clientID, TrustedOrigins: []string{backend.URL}}, connections: make(map[*websocket.Conn]struct{}), context: ctx}
	connection := agent.startConnection(ServerCredential{Origin: backend.URL, UserID: "alice"}, token)
	if connection == nil {
		t.Fatal("connection did not start")
	}
	first := receive(t, accepted)
	dir := t.TempDir()
	id := "01234567-0123-0123-0123-012345678901"
	command := "printf 'run\n' >> once.txt; touch started; while [ ! -f release ]; do sleep 0.02; done; printf done"
	if runtime.GOOS == "windows" {
		command = "Add-Content once.txt run; Set-Content started ready; while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; 'done'"
	}
	mu.Lock()
	wanted = []string{id}
	mu.Unlock()
	if err := first.send(map[string]any{"id": id, "op": "exec", "args": map[string]any{"cwd": dir, "command": command, "timeout": 20}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = first.conn.Close()
	second := receive(t, accepted)
	if first.instance != second.instance {
		t.Fatal("transport reconnect changed the execution instance")
	}
	if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	completed := receive(t, results)
	if completed["id"] != id || completed["result"].(map[string]any)["exitCode"] != float64(0) {
		data, _ := json.Marshal(completed)
		t.Fatalf("in-flight work did not survive disconnect: %s", data)
	}
	// Drop the result acknowledgement, as if the response was lost in the network.
	_ = second.conn.Close()
	third := receive(t, accepted)
	if third.instance != first.instance {
		t.Fatal("unacknowledged result lost its original instance")
	}
	if resent := receive(t, results); !reflect.DeepEqual(resent, completed) {
		t.Fatalf("expected only the cached result, got %v", resent)
	}
	data, err := os.ReadFile(filepath.Join(dir, "once.txt"))
	if err != nil || strings.Count(string(data), "run") != 1 {
		t.Fatalf("an operation was replayed: %q %v", data, err)
	}
	if err = third.send(map[string]string{"type": "ack", "id": id}); err != nil {
		t.Fatal(err)
	}
	probeID := "11234567-0123-0123-0123-012345678901"
	if err = third.send(map[string]any{"id": probeID, "op": "file", "args": map[string]string{"op": "read", "cwd": dir, "path": "once.txt"}}); err != nil {
		t.Fatal(err)
	}
	if receive(t, results)["id"] != probeID {
		t.Fatal("work did not continue after recovery")
	}
	connection.jobs.mu.Lock()
	_, retained := connection.jobs.tasks[id]
	connection.jobs.mu.Unlock()
	if retained {
		t.Fatal("acknowledged result was not released")
	}

	cancelledCtx, stop := context.WithCancel(ctx)
	cancelledID := "21234567-0123-0123-0123-012345678901"
	connection.jobs.mu.Lock()
	connection.jobs.tasks[cancelledID] = &localJob{cancel: stop}
	connection.jobs.mu.Unlock()
	mu.Lock()
	wanted = []string{}
	mu.Unlock()
	_ = third.conn.Close()
	_ = receive(t, accepted)
	select {
	case <-cancelledCtx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("reconnect did not cancel jobs removed while offline")
	}
}

func TestReconnectExpiryCancelsJobsAndReleasesBrowserLease(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner := newJobRunner(ctx, true)
	defer runner.close()
	taskCtx, stop := context.WithCancel(ctx)
	runner.tasks["pending"] = &localJob{cancel: stop}
	localChrome.mu.Lock()
	localChrome.connection, localChrome.session = ctx, "fixture"
	localChrome.mu.Unlock()
	runner.suspend(nil)
	runner.mu.Lock()
	runner.recovery.Reset(0)
	runner.mu.Unlock()
	select {
	case <-taskCtx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("expired recovery did not cancel native work")
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	localChrome.mu.Lock()
	defer localChrome.mu.Unlock()
	if localChrome.connection != nil || localChrome.session != "" {
		t.Fatal("expired recovery kept the local browser occupied")
	}
}
