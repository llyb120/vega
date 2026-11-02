//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// Non-Windows has no system tray here: run headless and log to stderr.
// Quit with Ctrl+C / SIGTERM.
func systrayRun(configure, supplement, onQuit func()) {
	fmt.Fprintln(os.Stderr, "vega-local: running (no tray on this platform), Ctrl+C to quit")
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	onQuit()
}

// no-op state hook: tooltip updates only exist on Windows.
var setState = func(bool) {}

func promptSupplement(string) (string, bool, error) {
	return "", false, fmt.Errorf("补充内容的系统输入框目前仅支持 Windows 托盘")
}

func reportSupplementError(err error) {
	fmt.Fprintln(os.Stderr, "vega-local:", err)
}
