package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRelayRejectsUnexpectedAcknowledgementAndCancelsBlockedIO(t *testing.T) {
	for _, operation := range []string{"unexpected-ack", "cancel"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			remote, target := net.Pipe()
			defer remote.Close()
			defer target.Close()
			backend := httptest.NewServer(newChannelServer(func(peer *channelPeer, r *http.Request) {
				if _, ok := peer.poll(); !ok {
					return
				}
				if operation == "cancel" {
					cancel()
					return
				}
				_ = peer.sendFrame([]byte{1})
				_, _ = peer.poll()
			}))
			defer backend.Close()
			ws, _, err := Dial("http"+strings.TrimPrefix(backend.URL, "http"), nil)
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
