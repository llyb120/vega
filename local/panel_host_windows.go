//go:build windows

package main

// 面板自己的 WebView2 宿主：窗口由我们建，一创建就在屏幕外、无标题栏、尺寸到位，再把
// go-webview2 的 edge.Chromium 嵌进去。
// 不用库自带的建窗：它是先把窗口摆到屏幕正中（或 CW_USEDEFAULT）显示，再阻塞式初始化
// WebView2——那一下就是“启动时有个小窗口一闪而过”。自己建窗还顺带躲开 StartupInfo 的
// SW_HIDE 把首次 ShowWindow 吞掉、合成器建在隐藏窗口上永不上屏那个坑。

import (
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

const (
	butterflyPanelClass = "VegaButterflyPanel"
	// 预热时把窗口停在工作区外：它一直是“可见”的，WebView2 合成器才不会停摆。
	panelParkX = -20000
	panelParkY = -20000

	panelShowMsg = 0x8000 + 1 // WM_APP+1：客户端点了蝴蝶，挪到任务栏上方并拿到前台
	panelParkMsg = 0x8000 + 2 // WM_APP+2：失焦，收回屏幕外
)

var panelHost struct {
	sync.Mutex
	hwnd    windows.Handle
	browser *edge.Chromium
	pending bool // 预热还没好就被点了：等 WebView2 就绪再摆出来
}

func panelHostWindow() windows.Handle {
	panelHost.Lock()
	defer panelHost.Unlock()
	return panelHost.hwnd
}

func panelHostBrowser() *edge.Chromium {
	panelHost.Lock()
	defer panelHost.Unlock()
	return panelHost.browser
}

// panelHostWndProc 面板窗口的消息：尺寸变了把 WebView2 的 bounds 同步过去，
// 显示/收起由客户端的信号触发，关窗走正常的销毁流程。
func panelHostWndProc(hwnd windows.Handle, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case 0x0005: // WM_SIZE
		if browser := panelHostBrowser(); browser != nil {
			browser.Resize()
		}
		return 0
	case 0x0014: // WM_ERASEBKGND：别用系统背景刷，省得闪白
		return 1
	case panelShowMsg:
		browser := panelHostBrowser()
		if browser == nil {
			panelHost.Lock()
			panelHost.pending = true
			panelHost.Unlock()
			return 0
		}
		_ = browser.NotifyParentWindowPositionChanged()
		butterflyPanelPlace(hwnd)
		return 0
	case panelParkMsg:
		panelPark(hwnd)
		panelShowState.Lock()
		panelShowState.at = time.Time{}
		panelShowState.Unlock()
		return 0
	case 0x0010: // WM_CLOSE
		_, _, _ = procChipDestroy.Call(uintptr(hwnd))
		return 0
	case 0x0002: // WM_DESTROY
		_, _, _ = procPanelQuit.Call(0)
		return 0
	}
	result, _, _ := procChipDefProc.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
	return result
}

// panelPark 把窗口收回屏幕外（不激活、不改尺寸），页面和 WebView2 都留着——下次点开是热的。
func panelPark(hwnd windows.Handle) {
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), 0, ^uintptr(-panelParkX-1), ^uintptr(-panelParkY-1), 0, 0, 0x0010|0x0004|0x0001|0x0200) // NOACTIVATE|NOZORDER|NOSIZE|NOOWNERZORDER
}

// panelHostStart 建窗 + 嵌 WebView2 + 载入页面，然后进入消息循环（阻塞到窗口销毁）。
func panelHostStart(url string) bool {
	runtime.LockOSThread()
	instance, _, _ := procButterflyModule.Call(0)
	procedure := syscall.NewCallback(panelHostWndProc)
	class := chipWindowClass{
		Procedure: procedure,
		Instance:  windows.Handle(instance),
		ClassName: butterflyUTF16(butterflyPanelClass),
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, last := procChipRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		panelLog("注册面板窗口类失败：%v", last)
		return false
	}
	dpi := butterflyDPI()
	width := butterflyScale(butterflyPanelWidth, dpi)
	height := butterflyScale(butterflyPanelHeight, dpi)
	parkX, parkY := int32(panelParkX), int32(panelParkY)
	const (
		wsPopup    = 0x80000000
		wsVisible  = 0x10000000
		exTopmost  = 0x00000008
		exTool     = 0x00000080
		exNoRedraw = 0x00200000
	)
	hwnd, _, last := procChipCreate.Call(
		exTopmost|exTool|exNoRedraw,
		uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelClass))),
		uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle))),
		wsPopup|wsVisible,
		uintptr(parkX)&0xFFFFFFFF, uintptr(parkY)&0xFFFFFFFF,
		uintptr(width), uintptr(height),
		0, 0, uintptr(instance), 0)
	if hwnd == 0 {
		panelLog("建面板窗口失败：%v", last)
		return false
	}
	panelHost.Lock()
	panelHost.hwnd = windows.Handle(hwnd)
	panelHost.Unlock()
	butterflyPanelChrome(windows.Handle(hwnd))
	// 先给个占位：让 DWM 立刻有圆角表面，避免第一次显示时先直角再收圆。
	butterflyPanelRounded(windows.Handle(hwnd))

	// 停在工作区外的窗口会被系统判成“被遮挡”，WebView2 会停画；关掉这类节流。
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding")
	chromium := edge.NewChromium()
	chromium.DataPath = butterflyPanelDataDir() + `\webview`
	chromium.MessageCallback = func(text string) { panelLog("面板页面：%s", text) }
	chromium.SetPermission(edge.CoreWebView2PermissionKindClipboardRead, edge.CoreWebView2PermissionStateAllow)
	if !chromium.Embed(hwnd) {
		panelLog("WebView2 初始化失败")
		_, _, _ = procChipDestroy.Call(hwnd)
		return false
	}
	panelHost.Lock()
	panelHost.browser = chromium
	panelHost.Unlock()
	chromium.Resize()
	chromium.Navigate(url)
	go butterflyPanelBlurWatch(windows.Handle(hwnd))
	panelLog("面板预热完成：%s", url)
	panelHost.Lock()
	pending := panelHost.pending
	panelHost.pending = false
	panelHost.Unlock()
	if pending {
		butterflyPanelPlace(windows.Handle(hwnd))
	}
	var message chipMsg
	for {
		result, _, _ := procChipGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return true
		}
		_, _, _ = procChipTranslate.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procChipDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}
