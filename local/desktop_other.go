//go:build !windows

package main

// 其它平台没有 WebView2 窗口宿主：desktopShow 退回系统浏览器打开同一套页面。
func desktopRun(url string) bool { return false }
