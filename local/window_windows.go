//go:build windows

package main

// appuse / 光效 / 桌面窗口共用的 Win32 小工具：UTF-16 与窗口类结构。

import "golang.org/x/sys/windows"

func windowsUTF16(text string) *uint16 {
	pointer, err := windows.UTF16PtrFromString(text)
	if err != nil {
		pointer, _ = windows.UTF16PtrFromString("")
	}
	return pointer
}

// windowClassEx 是 WNDCLASSEXW 的布局。
type windowClassEx struct {
	Size       uint32
	Style      uint32
	Procedure  uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	SmallIcon  windows.Handle
}
