//go:build !windows

package main

// 任务栏蝴蝶只在 Windows 上有；其它平台只保留托盘/气泡的提示（那边也是 no-op）。
func butterflyChipStart() {}

func butterflyChipState(string) {}
