//go:build !windows

package main

// 非 Windows 客户端没有托盘和气泡：提示只留在进程日志里，不假装已经通知到用户。
func butterflyTrayNotice(*butterflyNotice) {}

func butterflyShowNotice(*butterflyNotice) {}

func butterflyHideNotice() {}
