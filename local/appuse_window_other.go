//go:build !windows

package main

import "image"

// 非 Windows 没有窗口自身像素通道：只截显示器，与 Nova 的普通模式一致。
func appuseGrab(monitor appuseSurface, _ *appuseWindow) (*image.RGBA, error) {
	return appuseCaptureMonitor(monitor)
}
