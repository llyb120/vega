package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Opt-in: evaluates a constant in an existing, explicitly selected tab, without navigation or input.
func TestBrowserBridgeInstalledExtension(t *testing.T) {
	tag := os.Getenv("VEGA_CHROME_TEST_TAB")
	if tag == "" {
		t.Skip("set VEGA_CHROME_TEST_TAB to an authorized existing tabTag for the live extension check")
	}
	b := newBrowserBridge()
	server, err := b.start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		b.mu.Lock()
		connected := b.status()["connected"] == true
		b.mu.Unlock()
		if connected {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("installed extension did not discover the Go loopback bridge")
		}
	}
	if value := b.execute(ctx, ctx, browserJob("acquire", browserSession)); value["error"] != nil {
		t.Fatal(value)
	}
	defer b.execute(ctx, ctx, browserJob("release", browserSession))
	args, err := json.Marshal(map[string]any{"session": browserSession, "operation": "cdp", "args": map[string]any{"tabTag": tag, "method": "Runtime.evaluate", "params": map[string]any{"expression": "6 * 7", "returnByValue": true}}})
	if err != nil {
		t.Fatal(err)
	}
	value := b.execute(ctx, ctx, job{ID: "live-cdp-check", Op: "browser", Args: args})
	if value["error"] != nil {
		t.Fatal(value)
	}
	data, _ := json.Marshal(value["result"])
	var cdp struct {
		Result struct {
			Type  string `json:"type"`
			Value int    `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &cdp); err != nil || cdp.Result.Type != "number" || cdp.Result.Value != 42 {
		t.Fatalf("unexpected CDP result: %s (%v)", data, err)
	}
	t.Logf("installed extension discovered Go bridge on port %d and returned CDP value 42", b.port)
}
