//go:build windows

package main

// 窗口自身像素：与 Nova 的 xcap Window::capture_image 对齐（PrintWindow + PW_RENDERFULLCONTENT）。
// 指定 windowId 时取窗口自己的内容，被别的窗口遮住也能截对；取不到就退回整屏并在结果里说明，
// 绝不把“整屏里那块”冒充成窗口内容。

import (
	"fmt"
	"image"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	grabUser32 = windows.NewLazySystemDLL("user32.dll")
	grabGDI32  = windows.NewLazySystemDLL("gdi32.dll")

	procGrabDC         = grabUser32.NewProc("GetWindowDC")
	procGrabRelease    = grabUser32.NewProc("ReleaseDC")
	procGrabPrint      = grabUser32.NewProc("PrintWindow")
	procGrabRect       = grabUser32.NewProc("GetWindowRect")
	procGrabCreateDC   = grabGDI32.NewProc("CreateCompatibleDC")
	procGrabCreateBmp  = grabGDI32.NewProc("CreateCompatibleBitmap")
	procGrabSelect     = grabGDI32.NewProc("SelectObject")
	procGrabDelete     = grabGDI32.NewProc("DeleteObject")
	procGrabDeleteDC   = grabGDI32.NewProc("DeleteDC")
	procGrabBits       = grabGDI32.NewProc("GetDIBits")
	procGrabStretchBlt = grabGDI32.NewProc("StretchBlt")
)

const (
	pwRenderFullContent = 0x00000002
	dibRGBColors        = 0
)

// appuseGrab 取一屏像素：有窗口就优先截窗口自身，否则截显示器。
// window 为 nil 时就是普通整屏截图（与改动前完全一致）。
func appuseGrab(monitor appuseSurface, window *appuseWindow) (*image.RGBA, error) {
	if window == nil {
		return appuseCaptureMonitor(monitor)
	}
	grab, err := appuseWindowPixels(*window)
	if err == nil {
		return grab, nil
	}
	// 取不到窗口像素（受保护的窗口/老应用/远程会话）：整屏回退，绝不谎称是窗口内容。
	if fallback, fallbackErr := appuseCaptureMonitor(monitor); fallbackErr == nil {
		return fallback, nil
	}
	return nil, err
}

// appuseWindowPixels 用 PrintWindow 取窗口内容；窗口尺寸取不到或打印失败都返回错误。
func appuseWindowPixels(window appuseWindow) (*image.RGBA, error) {
	hwnd := uintptr(window.ID)
	width, height := int32(window.W), int32(window.H)
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("窗口尺寸不可用")
	}
	screen, _, _ := procGrabDC.Call(hwnd)
	if screen == 0 {
		return nil, fmt.Errorf("无法获取窗口设备上下文")
	}
	defer func() { _, _, _ = procGrabRelease.Call(hwnd, screen) }()
	buffer, _, _ := procGrabCreateDC.Call(screen)
	if buffer == 0 {
		return nil, fmt.Errorf("无法创建兼容设备上下文")
	}
	defer func() { _, _, _ = procGrabDeleteDC.Call(buffer) }()
	bitmap, _, _ := procGrabCreateBmp.Call(screen, uintptr(width), uintptr(height))
	if bitmap == 0 {
		return nil, fmt.Errorf("无法创建窗口位图")
	}
	defer func() { _, _, _ = procGrabDelete.Call(bitmap) }()
	previous, _, _ := procGrabSelect.Call(buffer, bitmap)
	defer func() { _, _, _ = procGrabSelect.Call(buffer, previous) }()
	// PW_RENDERFULLCONTENT 让 DWM 合成的内容（浏览器、Electron、WinUI）也能被画出来。
	if ok, _, _ := procGrabPrint.Call(hwnd, buffer, pwRenderFullContent); ok == 0 {
		return nil, fmt.Errorf("窗口拒绝提供自身像素（可能受保护或不支持组合渲染）")
	}
	return appuseReadBitmap(uintptr(buffer), bitmap, width, height)
}

// appuseReadBitmap 把 DIB 内容读成 RGBA（32 位、自上而下）。
func appuseReadBitmap(dc uintptr, bitmap uintptr, width, height int32) (*image.RGBA, error) {
	header := appuseBitmapInfo{Header: appuseBitmapInfoHeader{
		Width: width, Height: -height, Planes: 1, BitCount: 32, Compression: 0, // BI_RGB，负高度=自上而下
	}}
	header.Header.Size = uint32(unsafe.Sizeof(header.Header))
	img := image.NewRGBA(image.Rect(0, 0, int(width), int(height)))
	if ok, _, _ := procGrabBits.Call(dc, bitmap, 0, uintptr(height), uintptr(unsafe.Pointer(&img.Pix[0])), uintptr(unsafe.Pointer(&header)), dibRGBColors); ok == 0 {
		return nil, fmt.Errorf("无法读取窗口位图")
	}
	for index := 0; index < len(img.Pix); index += 4 {
		img.Pix[index+3] = 255
	}
	return img, nil
}
