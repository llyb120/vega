//go:build windows

package main

// 启动失败时用户看不到 stderr（客户端不带控制台），用系统弹框把原因说出来。

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procMessageBox = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")

func alertUser(message string) {
	title, err := windows.UTF16PtrFromString("牵牛星客户端")
	if err != nil {
		return
	}
	text, err := windows.UTF16PtrFromString(message)
	if err != nil {
		return
	}
	const mbIconError, mbSetForeground = 0x00000010, 0x00010000
	_, _, _ = procMessageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), mbIconError|mbSetForeground)
}
