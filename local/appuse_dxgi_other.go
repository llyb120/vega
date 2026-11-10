//go:build !windows

package main

import "image"

// 非 Windows 没有 DXGI：抓屏就是平台自己的通道，自检以它为参照。
func gdiGrab(surface appuseSurface) (*image.RGBA, error) {
	return appuseCaptureMonitor(surface)
}
