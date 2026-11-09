//go:build !windows

package main

// 非 Windows 客户端没有托盘和气泡：提示只留在进程日志里，不假装已经通知到用户。
func butterflyTrayNotice(*butterflyNotice) {}

func butterflyShowNotice(*butterflyNotice) {}

func butterflyHideNotice() {}

// 没有可点的确认卡：appuse 按「不拒绝默认视为同意」直接开始（与 Windows 上蝴蝶关掉时一致）。
func butterflyConfirm() bool { return false }
