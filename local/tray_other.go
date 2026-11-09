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
func systrayRun(configure, onQuit func(), setOnline func(bool)) {
	fmt.Fprintln(os.Stderr, "vega-local: running (no tray on this platform), Ctrl+C to quit")
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	onQuit()
}

// no-op state hooks: tray menu and tooltip only exist on Windows.
var setState = func(bool) {}

var setSiteLabel = func(string) {}

var setTrayOffline = func(bool) {}
