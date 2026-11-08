//go:build !windows

package main

// 系统指针替换只有 Windows 有；其它平台如实跳过，不假装换过指针。
func appuseBrandCursor() {}

func appuseRestoreCursor() {}

func appuseResetCursorOnStart() {}
