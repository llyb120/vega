//go:build windows

package main

// 剑形系统指针：与 Nova 的 agent_glow::brand_cursor 同一套做法——
// 用同一份 pixel 算法生成位图，做成图标后接管系统指针（普通/文本/手型），
// 回合结束或进程启动时从注册表重新加载用户自己的指针方案，而不是猜默认值。

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	pointerUser32 = windows.NewLazySystemDLL("user32.dll")
	pointerGDI32  = windows.NewLazySystemDLL("gdi32.dll")

	procPointerMetrics   = pointerUser32.NewProc("GetSystemMetrics")
	procPointerSetCursor = pointerUser32.NewProc("SetSystemCursor")
	procPointerCopyIcon  = pointerUser32.NewProc("CopyIcon")
	procPointerDestroy   = pointerUser32.NewProc("DestroyIcon")
	procPointerIconInfo  = pointerUser32.NewProc("CreateIconIndirect")
	procPointerParams    = pointerUser32.NewProc("SystemParametersInfoW")

	procPointerDIB    = pointerGDI32.NewProc("CreateDIBSection")
	procPointerBitmap = pointerGDI32.NewProc("CreateBitmap")
	procPointerDelete = pointerGDI32.NewProc("DeleteObject")
)

// 系统指针的种类编号（OCR_*）。
const (
	appuseOcrNormal = 32512
	appuseOcrIBeam  = 32513
	appuseOcrHand   = 32649
)

var appusePointerState struct {
	sync.Mutex
	busy   bool
	holder int
}

// appuseBrandCursor 把系统指针换成剑形；重复调用只刷新一次。
func appuseBrandCursor() {
	appusePointerState.Lock()
	if appusePointerState.busy {
		appusePointerState.holder++
		appusePointerState.Unlock()
		return
	}
	appusePointerState.busy = true
	appusePointerState.holder = 1
	appusePointerState.Unlock()
	appuseApplySwordCursor()
}

// appuseRestoreCursor 交还用户自己的指针方案（从注册表重载，不猜默认值）。
func appuseRestoreCursor() {
	appusePointerState.Lock()
	appusePointerState.holder--
	if appusePointerState.holder > 0 {
		appusePointerState.Unlock()
		return
	}
	appusePointerState.busy = false
	appusePointerState.holder = 0
	appusePointerState.Unlock()
	// SPI_SETCURSORS = 0x0057：从注册表的指针方案重新加载。
	_, _, _ = procPointerParams.Call(0x0057, 0, 0, 0)
}

// appuseResetCursorOnStart 是启动时的无条件还原：进程被强杀时品牌指针会留到下次登录。
func appuseResetCursorOnStart() { appuseRestoreCursorAll() }

func appuseRestoreCursorAll() {
	appusePointerState.Lock()
	appusePointerState.busy = false
	appusePointerState.holder = 0
	appusePointerState.Unlock()
	_, _, _ = procPointerParams.Call(0x0057, 0, 0, 0)
}

type appuseIconInfo struct {
	Icon      int32
	XHotspot  uint32
	YHotspot  uint32
	Mask      windows.Handle
	Color     windows.Handle
}

type appuseBitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type appuseBitmapInfo struct {
	Header appuseBitmapInfoHeader
	Colors [3]uint32
}

// appuseApplySwordCursor 生成剑形指针并接管普通/文本/手型三种系统指针。
func appuseApplySwordCursor() {
	size := 32
	if value, _, _ := procPointerMetrics.Call(13); int32(value) >= 32 { // SM_CXCURSOR = 13
		size = int(int32(value))
	}
	if size > 256 {
		size = 256
	}
	pixels := appusePointerPixels(size, appuseCursorGlow)
	info := appuseBitmapInfo{Header: appuseBitmapInfoHeader{
		Width: int32(size), Height: -int32(size), Planes: 1, BitCount: 32, Compression: 0, // BI_RGB
	}}
	info.Header.Size = uint32(unsafe.Sizeof(info.Header))
	var bits unsafe.Pointer
	color, _, _ := procPointerDIB.Call(0, uintptr(unsafe.Pointer(&info)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if color == 0 || bits == nil {
		return
	}
	defer func() { _, _, _ = procPointerDelete.Call(color) }()
	// 直通 alpha：AARRGGBB 逐像素写进 DIB。
	target := unsafe.Slice((*uint32)(bits), size*size)
	copy(target, pixels)
	// 全 0 的 AND 掩码：像素完全由带 alpha 的彩色位图决定。
	maskBits := make([]byte, ((size+15)/16*2)*size)
	mask, _, _ := procPointerBitmap.Call(uintptr(size), uintptr(size), 1, 1, uintptr(unsafe.Pointer(&maskBits[0])))
	if mask == 0 {
		return
	}
	defer func() { _, _, _ = procPointerDelete.Call(mask) }()
	hotspot := uint32(appusePointerTip * float64(size) / 32)
	icon, _, _ := procPointerIconInfo.Call(uintptr(unsafe.Pointer(&appuseIconInfo{
		XHotspot: hotspot, YHotspot: hotspot,
		Mask: windows.Handle(mask), Color: windows.Handle(color),
	})))
	if icon == 0 {
		return
	}
	defer func() { _, _, _ = procPointerDestroy.Call(icon) }()
	// SetSystemCursor 接管并销毁传入句柄，每个系统指针各给一份副本。
	for _, id := range []uintptr{appuseOcrNormal, appuseOcrIBeam, appuseOcrHand} {
		copyHandle, _, _ := procPointerCopyIcon.Call(icon)
		if copyHandle == 0 {
			continue
		}
		if ok, _, _ := procPointerSetCursor.Call(copyHandle, id); ok == 0 {
			_, _, _ = procPointerDestroy.Call(copyHandle)
		}
	}
}
