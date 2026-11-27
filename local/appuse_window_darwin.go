//go:build darwin && cgo

package main

// macOS 窗口自身像素通道：通过 ScreenCaptureKit 单独截取指定 windowId 的图像（被遮挡也能取对），
// 失败时安全回退整屏截图。

import "image"

func appuseGrab(monitor appuseSurface, window *appuseWindow) (*image.RGBA, error) {
	if window == nil {
		return appuseCaptureMonitor(monitor)
	}
	if grab, err := captureWindowImage(*window); err == nil {
		return grab, nil
	}
	return appuseCaptureMonitor(monitor)
}

// dxgiGrab supplies the primary ScreenCaptureKit frame for --grab-preview verification.
func dxgiGrab(surface appuseSurface) (*image.RGBA, error) {
	return appuseCaptureMonitor(surface)
}
