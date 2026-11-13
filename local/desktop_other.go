//go:build !windows

package main

// 客户端窗口是 Go + WebView2，只有 Windows 有；其它平台调用方退回系统浏览器。

func desktopWarm(string) {}

func desktopShow(string) bool { return false }

func desktopClose() {}

func desktopRun(string) bool { return false }
