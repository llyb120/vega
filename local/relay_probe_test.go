package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The Node end-to-end probe runs this isolated client against temporary test services.
func TestRelayProbeClient(t *testing.T) {
	input := os.Getenv("VEGA_RELAY_PROBE")
	if input == "" {
		t.Skip("only used by the Node relay probe")
	}
	var args struct{ Origin, UserID, ClientID, Token, Rule, DNS string }
	if err := json.Unmarshal([]byte(input), &args); err != nil {
		t.Fatal(err)
	}
	if args.DNS != "" {
		net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "udp", args.DNS)
		}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	saved := ServerCredential{Origin: args.Origin, UserID: args.UserID, Relay: strings.Split(args.Rule, ",")}
	a := &Agent{context: ctx, config: Config{ClientID: args.ClientID, TrustedOrigins: []string{args.Origin}}, connections: make(map[*websocket.Conn]struct{})}
	if a.startConnection(saved, args.Token) == nil {
		t.Fatal("client did not start")
	}
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	<-ctx.Done()
}
