//go:build darwin && cgo

package main

// macOS 菜单栏状态芯片：接收本地提示与服务端五档推送，并同步到 NSStatusItem。

import (
	"sync"
	"time"
)

type chipKind int

const (
	chipIdle chipKind = iota
	chipRunning
	chipWaiting
	chipDone
	chipError
)

var chipEpoch = time.Now()

var chipState struct {
	sync.Mutex
	started  bool
	kind     chipKind
	text     string
	trailing string
	detail   string
	thread   string
}

func butterflyChipStart() {
	chipState.Lock()
	chipState.started = true
	chipState.Unlock()
}

func butterflyChipState(kind string) {
	butterflyChipApply(kind, "", "", "", "")
}

func butterflyChipHide() {
	chipState.Lock()
	chipState.kind = chipIdle
	chipState.text, chipState.trailing, chipState.detail, chipState.thread = "", "", "", ""
	chipState.Unlock()
	traySetChipLabel("")
}

// butterflyChipStatus 接收服务端算好的五档（对齐 Windows / Nova taskbar_status）：本地 appuse 优先级更高。
func butterflyChipStatus(kind, text, trailing, detail, thread string) {
	if local := butterflySnapshot(); local != nil {
		switch local.Kind {
		case "running":
			return
		case "needs_review":
			if kind == "waiting" || kind == "needs_review" {
				return
			}
			butterflyClearIfKind("needs_review")
		}
	}
	butterflyChipApply(kind, text, trailing, detail, thread)
}

func butterflyChipApply(kind, text, trailing, detail, thread string) {
	next := chipIdle
	switch kind {
	case "running":
		next = chipRunning
	case "needs_review", "waiting":
		next = chipWaiting
	case "done":
		next = chipDone
	case "error":
		next = chipError
	}
	chipState.Lock()
	changed := chipState.kind != next || chipState.text != text || chipState.trailing != trailing || chipState.thread != thread
	chipState.kind = next
	chipState.text, chipState.trailing, chipState.detail, chipState.thread = text, trailing, detail, thread
	chipState.Unlock()

	if changed && next == chipWaiting && detail != "" {
		butterflyNotify("needs_review", detail)
	}
	if !changed {
		return
	}
	if butterflyDisabled() {
		traySetChipLabel("")
		return
	}
	traySetChipLabel(formatDarwinChipLabel(next, text, trailing))
}

func formatDarwinChipLabel(kind chipKind, text, trailing string) string {
	var dot string
	switch kind {
	case chipRunning:
		dot = "●"
	case chipWaiting:
		dot = "◐"
	case chipDone:
		dot = "✓"
	case chipError:
		dot = "!"
	default:
		return ""
	}
	label := dot
	if text != "" {
		label += " " + truncateRunes(text, 24)
	}
	if trailing != "" {
		label += " · " + truncateRunes(trailing, 16)
	}
	return label
}

func (k chipKind) KindString() string {
	switch k {
	case chipRunning:
		return "running"
	case chipWaiting:
		return "waiting"
	case chipDone:
		return "done"
	case chipError:
		return "error"
	}
	return "idle"
}
