package main

import (
	"strings"
	"testing"
)

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
