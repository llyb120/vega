//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestWindowsCommandsHideConsoleAndKeepCancellation(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "powershell.exe", "-NoProfile")
	configureCommand(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&createNoWindow == 0 || cmd.Cancel == nil {
		t.Fatal("local commands must not create a console and must retain process-tree cancellation")
	}
}

func TestWindowsConsoleDetach(t *testing.T) {
	window := syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleWindow")
	if os.Getenv("VEGA_TEST_DETACH_CONSOLE") == "1" {
		if handle, _, _ := window.Call(); handle == 0 {
			t.Fatal("test subprocess must start attached to its own console")
		}
		detachConsole()
		if handle, _, _ := window.Call(); handle != 0 {
			t.Fatal("client remained attached to its console")
		}
		return
	}
	before, _, _ := window.Call()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsConsoleDetach$")
	child.Env = append(os.Environ(), "VEGA_TEST_DETACH_CONSOLE=1")
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000010} // CREATE_NEW_CONSOLE
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("console detachment failed: %v\n%s", err, output)
	}
	if after, _, _ := window.Call(); after != before {
		t.Fatal("detaching the client changed the parent terminal")
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
