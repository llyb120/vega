package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRelayRejectsUnexpectedAcknowledgementAndCancelsBlockedIO(t *testing.T) {
	for _, operation := range []string{"unexpected-ack", "cancel"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			remote, target := net.Pipe()
			defer remote.Close()
			defer target.Close()
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer ws.Close()
				ws.SetReadDeadline(time.Now().Add(3 * time.Second))
				if _, _, err = ws.ReadMessage(); err != nil {
					return
				}
				if operation == "cancel" {
					cancel()
				} else {
					_ = ws.WriteMessage(websocket.BinaryMessage, []byte{1})
				}
				_, _, _ = ws.ReadMessage()
			}))
			defer backend.Close()
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(backend.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close()
			done := make(chan struct{})
			go func() { pumpRelay(ctx, remote, ws); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("blocked relay did not close")
			}
		})
	}
}
