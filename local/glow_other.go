//go:build !windows

package main

// 非 Windows 没有覆盖层与系统指针：与 Nova 一致（agent_glow 只在 Windows 编译）。
func glowStart() {}

func glowHold() {}

func glowRelease() {}

func glowHide() {}
