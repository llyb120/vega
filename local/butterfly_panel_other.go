//go:build !windows

package main

// 非 Windows 客户端没有 WebView2 面板：调用方退回系统浏览器打开 BOT 会话。
func butterflyPanelOpen(string) bool { return false }

func butterflyPanelWarm(string) {}

func butterflyPanelRun(string) bool { return false }

func butterflyPanelPark() {}

func butterflyPanelClose() {}
