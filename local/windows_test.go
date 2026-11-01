//go:build windows

package main

import (
	"context"
	"os/exec"
	"testing"
)

func TestWindowsCommandsHideConsoleAndKeepCancellation(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "powershell.exe", "-NoProfile")
	configureCommand(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.Cancel == nil {
		t.Fatal("local commands must hide their console and retain process-tree cancellation")
	}
}

func TestTrayRetainsConnectionStateBeforeReady(t *testing.T) {
	for _, connected := range []bool{false, true, false} {
		setState(connected)
		trayState.Lock()
		got := trayState.connected
		trayState.Unlock()
		if got != connected {
			t.Fatalf("tray lost connection state before initialization: got %v, want %v", got, connected)
		}
		expected := "Vega 本地执行端 · 未连接"
		if connected {
			expected = "Vega 本地执行端 · 已连接"
		}
		if tooltip := connectionTooltip(got); tooltip != expected {
			t.Fatalf("tray tooltip = %q, want %q", tooltip, expected)
		}
	}
}
