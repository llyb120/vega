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
	pending bool   // 预热还没好就被点了：等 WebView2 就绪再摆出来
	want    string // 预热还没好时要翻到的页面
}

// panelCurrentURL WebView2 当前加载的页面（翻页前比对，避免每次点开都重载）。
var panelCurrentURL string

// panelMinMaxInfo 是 MINMAXINFO 的布局：五个 POINT，只有 MinTrackSize 用得上。
type panelMinMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize appuseWinPoint
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
// lparam 按结构体指针接（和键盘钩子一样）：我们处理的几条消息里它要么是 MINMAXINFO，要么不用，
// 不用时只原样转给 DefWindowProc，不当作整数解引用。
func panelHostWndProc(hwnd windows.Handle, message uint32, wparam uintptr, lparam *panelMinMaxInfo) uintptr {
	switch message {
	case 0x0005: // WM_SIZE
		if browser := panelHostBrowser(); browser != nil {
			browser.Resize()
		}
		return 0
	case 0x0014: // WM_ERASEBKGND：别用系统背景刷，省得闪白
		return 1
	case 0x0232: // WM_EXITSIZEMOVE：用户拖完/缩放完，把大小位置记下来
		savePanelGeometry(butterflyPanelDataDir(), hwnd)
		return 0
	case 0x0024: // WM_GETMINMAXINFO：别把窗口缩成一条线（尺寸按 DPI 缩放）
		if lparam != nil {
			dpi := butterflyDPI()
			lparam.MinTrackSize = appuseWinPoint{X: butterflyScale(butterflyPanelMinWidth, dpi), Y: butterflyScale(butterflyPanelMinHeight, dpi)}
		}
		return 0
	case panelShowMsg:
		browser := panelHostBrowser()
		if browser == nil {
			panelHost.Lock()
			panelHost.pending = true
			panelHost.Unlock()
			return 0
		}
		panelNavigate(hwnd)
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
	result, _, _ := procChipDefProc.Call(uintptr(hwnd), uintptr(message), wparam, uintptr(unsafe.Pointer(lparam)))
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
		wsOverlapped = 0x00CF0000 // WS_OVERLAPPEDWINDOW
		wsClip       = 0x02000000 // WS_CLIPCHILDREN
		wsVisible    = 0x10000000
		exTool       = 0x00000080
		exNoRedraw   = 0x00200000
	)
	hwnd, _, last := procChipCreate.Call(
		exTool|exNoRedraw, // 不进任务栏：入口是任务栏蝴蝶和托盘
		uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelClass))),
		uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle))),
		wsOverlapped|wsClip|wsVisible,
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
	// 普通窗口：系统标题栏、可缩放、不置顶，不再做无边框气泡那套。
	butterflyPanelChrome(windows.Handle(hwnd))

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
	// 透明背景：页面根是 background:transparent，让卡片之外透出桌面——这是 Nova 气泡的半透明感。
	// 只是设 WebView2 的默认背景，不动窗口样式；WebView2 直绘，透明像素直接合成到桌面。
	if c := chromium.GetController(); c != nil {
		if c2 := c.GetICoreWebView2Controller2(); c2 != nil {
			_ = c2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{A: 0, R: 0, G: 0, B: 0})
		}
	}
	chromium.Resize()
	chromium.Navigate(url)
	panelCurrentURL = url
	panelLog("面板预热完成：%s", url)
	panelHost.Lock()
	pending, want := panelHost.pending, panelHost.want
	panelHost.pending, panelHost.want = false, ""
	panelHost.Unlock()
	if pending {
		if want != "" && want != panelCurrentURL {
			panelCurrentURL = want
			chromium.Navigate(want)
		}
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
