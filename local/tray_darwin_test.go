//go:build darwin && cgo

package main

import (
	"testing"
	"time"
)

func TestTrayStateAndTooltipDarwin(t *testing.T) {
	trayState.Lock()
	oldReady, oldConn, oldSite := trayState.ready, trayState.connected, trayState.site
	oldNotice, oldNoticeText, oldChip := trayState.notice, trayState.noticeText, trayState.chipLabel
	trayState.ready = false
	trayState.site = ""
	trayState.notice, trayState.noticeText = "", ""
	trayState.Unlock()
	t.Cleanup(func() {
		trayState.Lock()
		trayState.ready, trayState.connected, trayState.site = oldReady, oldConn, oldSite
		trayState.notice, trayState.noticeText, trayState.chipLabel = oldNotice, oldNoticeText, oldChip
		trayState.Unlock()
	})

	for _, connected := range []bool{false, true, false} {
		setState(connected)
		trayState.Lock()
		got := trayState.connected
		trayState.Unlock()
		if got != connected {
			t.Fatalf("tray lost connection state: got %v, want %v", got, connected)
		}
		want := "牵牛星 · 未连接"
		if connected {
			want = "牵牛星 · 已连接"
		}
		if tip := connectionTooltip(got); tip != want {
			t.Fatalf("connectionTooltip(%v) = %q, want %q", got, tip, want)
		}
	}

	setSiteLabel("vega.example/team")
	if tip := connectionTooltip(true); tip != "牵牛星 · vega.example/team · 已连接" {
		t.Fatalf("unexpected site tooltip: %q", tip)
	}

	butterflyTrayNotice(&butterflyNotice{Kind: "running", Text: "op"})
	if tip := trayTooltip(true, trayState.notice, trayState.noticeText); tip != "牵牛星 · 正在操作这台电脑" {
		t.Fatalf("unexpected running tooltip: %q", tip)
	}

	butterflyTrayNotice(&butterflyNotice{Kind: "needs_review", Text: "请确认输入"})
	if tip := trayTooltip(true, trayState.notice, trayState.noticeText); tip != "牵牛星 · 需要你核对：请确认输入" {
		t.Fatalf("unexpected needs_review tooltip: %q", tip)
	}

	// Test five-tier chip state mapping and local-active precedence.
	defer func() {
		chipState.Lock()
		chipState.kind, chipState.text, chipState.trailing, chipState.detail, chipState.thread = chipIdle, "", "", "", ""
		chipState.Unlock()
		butterflyState.Lock()
		butterflyState.notice = nil
		butterflyState.Unlock()
	}()

	for _, c := range []struct {
		kind string
		want chipKind
	}{
		{"running", chipRunning},
		{"waiting", chipWaiting},
		{"needs_review", chipWaiting},
		{"done", chipDone},
		{"error", chipError},
		{"idle", chipIdle},
		{"unknown", chipIdle},
	} {
		butterflyChipApply(c.kind, "t", "r", "", "th")
		chipState.Lock()
		got := chipState.kind
		chipState.Unlock()
		if got != c.want {
			t.Fatalf("butterflyChipApply(%q): got %v, want %v", c.kind, got, c.want)
		}
	}

	butterflyState.Lock()
	butterflyState.notice = &butterflyNotice{Kind: "running", Text: "本地操作", At: time.Now()}
	butterflyState.Unlock()
	butterflyChipApply("running", "local", "", "", "")
	butterflyChipStatus("idle", "srv", "", "", "")
	chipState.Lock()
	gotKind := chipState.kind
	chipState.Unlock()
	if gotKind != chipRunning {
		t.Fatalf("local running notice must win over server idle: got %v", gotKind)
	}
}

func TestButterflyBubbleFrameDarwin(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 25, Right: 1440, Bottom: 900}
	x, y := butterflyBubbleFrame(appuseWinRect{}, work, 360, 140, 8, 8)
	if x+360 != work.Right-8 || y+140 != work.Bottom-8 {
		t.Fatalf("fallback right-edge frame wrong: x=%d y=%d", x, y)
	}

	topChip := appuseWinRect{Left: 900, Top: 0, Right: 1060, Bottom: 25}
	_, y = butterflyBubbleFrame(topChip, work, 360, 140, 8, 8)
	if y != work.Top+8 {
		t.Fatalf("below top bar y=%d, want %d", y, work.Top+8)
	}
}
