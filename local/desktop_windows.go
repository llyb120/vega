//go:build windows

package main

// 桌面窗口的 Windows 宿主：无系统标题栏的 WebView2 窗口，标题栏、最小化/最大化/关闭都由页面自己画。
// 单独在一条锁定线程上跑消息循环（WebView2 的 COM 组件要求），窗口关掉就退出循环，几何信息留着下次用。

import (
	"os"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

const desktopWindowClass = "VegaDesktopWindow"

var (
	desktopUser32 = windows.NewLazySystemDLL("user32.dll")
	desktopDwmapi = windows.NewLazySystemDLL("dwmapi.dll")
	desktopOle32  = windows.NewLazySystemDLL("ole32.dll")
	desktopKernel = windows.NewLazySystemDLL("kernel32.dll")

	procDesktopRegister = desktopUser32.NewProc("RegisterClassExW")
	procDesktopCreate   = desktopUser32.NewProc("CreateWindowExW")
	procDesktopDefProc  = desktopUser32.NewProc("DefWindowProcW")
	procDesktopGetMsg   = desktopUser32.NewProc("GetMessageW")
	procDesktopTrans    = desktopUser32.NewProc("TranslateMessage")
	procDesktopDispatch = desktopUser32.NewProc("DispatchMessageW")
	procDesktopSend     = desktopUser32.NewProc("SendMessageW")
	procDesktopPost     = desktopUser32.NewProc("PostMessageW")
	procDesktopShow     = desktopUser32.NewProc("ShowWindow")
	procDesktopRect     = desktopUser32.NewProc("GetWindowRect")
	procDesktopCapture  = desktopUser32.NewProc("ReleaseCapture")
	procDesktopVisible  = desktopUser32.NewProc("IsWindowVisible")
	procDesktopFore     = desktopUser32.NewProc("SetForegroundWindow")
	procDesktopDpi      = desktopUser32.NewProc("GetDpiForWindow")
	procDesktopParams   = desktopUser32.NewProc("SystemParametersInfoW")
	procDesktopDestroy  = desktopUser32.NewProc("DestroyWindow")
	procDesktopQuit     = desktopUser32.NewProc("PostQuitMessage")
	procDesktopZoom     = desktopUser32.NewProc("IsZoomed")
	procDesktopCursor   = desktopUser32.NewProc("LoadCursorW")
	procDesktopModule   = desktopKernel.NewProc("GetModuleHandleW")
	procDesktopCoInit   = desktopOle32.NewProc("CoInitializeEx")
	procDesktopCoUninit = desktopOle32.NewProc("CoUninitialize")
	procDesktopCorner   = desktopDwmapi.NewProc("DwmSetWindowAttribute")
)

var desktopWnd struct {
	sync.Mutex
	hwnd    windows.Handle
	browser *edge.Chromium
}

type desktopHostWindow struct{}

func desktopHandle() windows.Handle {
	desktopWnd.Lock()
	defer desktopWnd.Unlock()
	return desktopWnd.hwnd
}

func desktopBrowser() *edge.Chromium {
	desktopWnd.Lock()
	defer desktopWnd.Unlock()
	return desktopWnd.browser
}

func (desktopHostWindow) Show() {
	hwnd := desktopHandle()
	if hwnd == 0 {
		return
	}
	_, _, _ = procDesktopShow.Call(uintptr(hwnd), 9) // SW_RESTORE
	_, _, _ = procDesktopFore.Call(uintptr(hwnd))
	if browser := desktopBrowser(); browser != nil {
		browser.Focus()
	}
}

func (desktopHostWindow) Minimise() {
	if hwnd := desktopHandle(); hwnd != 0 {
		_, _, _ = procDesktopShow.Call(uintptr(hwnd), 6) // SW_MINIMIZE
	}
}

func (desktopHostWindow) ToggleMaximise() {
	hwnd := desktopHandle()
	if hwnd == 0 {
		return
	}
	if zoomed, _, _ := procDesktopZoom.Call(uintptr(hwnd)); zoomed != 0 {
		_, _, _ = procDesktopShow.Call(uintptr(hwnd), 9) // SW_RESTORE
		return
	}
	_, _, _ = procDesktopShow.Call(uintptr(hwnd), 3) // SW_MAXIMIZE
}

func (desktopHostWindow) Close() {
	if hwnd := desktopHandle(); hwnd != 0 {
		_, _, _ = procDesktopPost.Call(uintptr(hwnd), 0x0010, 0, 0) // WM_CLOSE
	}
}

// Drag 让无标题栏的窗口跟着鼠标走：松开捕获后由系统按标题栏拖动。
func (desktopHostWindow) Drag() {
	hwnd := desktopHandle()
	if hwnd == 0 {
		return
	}
	_, _, _ = procDesktopCapture.Call()
	_, _, _ = procDesktopSend.Call(uintptr(hwnd), 0x00A1, 2, 0) // WM_NCLBUTTONDOWN, HTCAPTION
}

func (desktopHostWindow) Visible() bool {
	hwnd := desktopHandle()
	if hwnd == 0 {
		return false
	}
	visible, _, _ := procDesktopVisible.Call(uintptr(hwnd))
	return visible != 0
}

// desktopRun 起窗口与 WebView2 并进入消息循环；返回 false 表示这台机器没有 WebView2，调用方退回系统浏览器。
func desktopRun(url string) bool {
	version, err := webviewloader.GetInstalledVersion()
	if err != nil || version == "" {
		return false
	}
	runtime.LockOSThread()
	if hr, _, _ := procDesktopCoInit.Call(0, 2); int32(hr) < 0 { // COINIT_APARTMENTTHREADED
		return false
	}
	defer func() { _, _, _ = procDesktopCoUninit.Call() }()
	instance, _, _ := procDesktopModule.Call(0)
	procedure := syscall.NewCallback(desktopProcedure)
	cursor, _, _ := procDesktopCursor.Call(0, 32512) // IDC_ARROW
	class := struct {
		Size       uint32
		Style      uint32
		Procedure  uintptr
		ClsExtra   int32
		WndExtra   int32
		Instance   windows.Handle
		Icon       windows.Handle
		Cursor     windows.Handle
		Background windows.Handle
		MenuName   *uint16
		ClassName  *uint16
		SmallIcon  windows.Handle
	}{Procedure: procedure, Instance: windows.Handle(instance), Cursor: windows.Handle(cursor), ClassName: windowsUTF16(desktopWindowClass)}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, _ := procDesktopRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return false
	}
	const (
		wsPopup     = 0x80000000
		wsThick     = 0x00040000
		wsMinBox    = 0x00020000
		wsMaxBox    = 0x00100000
		wsSysMenu   = 0x00080000
		wsClip      = 0x02000000
		wsVisible   = 0x10000000
		exAppWindow = 0x00040000
	)
	work := desktopWorkArea()
	dpi := desktopSystemDPI()
	scale := func(value int32) int32 { return value * dpi / 96 }
	var saved *desktopGeometry
	if runningAgent != nil {
		if geometry, ok := loadDesktopGeometry(runningAgent.dataDir); ok {
			saved = &geometry
		}
	}
	x, y, width, height := desktopFrame(work, saved, scale)
	hwnd, _, _ := procDesktopCreate.Call(
		exAppWindow,
		uintptr(unsafe.Pointer(windowsUTF16(desktopWindowClass))),
		uintptr(unsafe.Pointer(windowsUTF16("Vega"))),
		wsPopup|wsThick|wsMinBox|wsMaxBox|wsSysMenu|wsClip|wsVisible,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		0, 0, instance, 0)
	if hwnd == 0 {
		return false
	}
	desktopWnd.Lock()
	desktopWnd.hwnd = windows.Handle(hwnd)
	desktopWnd.Unlock()
	desktopWindow = desktopHostWindow{}
	desktopRoundCorners(windows.Handle(hwnd))
	chromium := edge.NewChromium()
	chromium.DataPath = desktopDataDir() + `\webview`
	if !chromium.Embed(hwnd) {
		_, _, _ = procDesktopDestroy.Call(hwnd)
		return false
	}
	desktopWnd.Lock()
	desktopWnd.browser = chromium
	desktopWnd.Unlock()
	chromium.Resize()
	chromium.Navigate(url)
	var message struct {
		Hwnd     windows.Handle
		Message  uint32
		WParam   uintptr
		LParam   uintptr
		Time     uint32
		Pt       desktopPoint
		LPrivate uint32
	}
	for {
		result, _, _ := procDesktopGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return true
		}
		_, _, _ = procDesktopTrans.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procDesktopDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

type desktopPoint struct{ X, Y int32 }

// desktopMinMaxInfo 是 MINMAXINFO 的布局：五个 POINT，只有 MinTrackSize 用得上。
type desktopMinMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize desktopPoint
}

func desktopProcedure(hwnd windows.Handle, message uint32, wparam uintptr, lparam *desktopMinMaxInfo) uintptr {
	switch message {
	case 0x0005: // WM_SIZE
		if browser := desktopBrowser(); browser != nil {
			browser.Resize()
		}
		return 0
	case 0x0003: // WM_MOVE
		if browser := desktopBrowser(); browser != nil {
			_ = browser.NotifyParentWindowPositionChanged()
		}
		return 0
	case 0x0232: // WM_EXITSIZEMOVE
		desktopRememberGeometry(hwnd)
		return 0
	case 0x0024: // WM_GETMINMAXINFO
		if lparam != nil {
			dpi := desktopWindowDPI(hwnd)
			lparam.MinTrackSize = desktopPoint{X: desktopMinWidth * dpi / 96, Y: desktopMinHeight * dpi / 96}
		}
		return 0
	case 0x0010: // WM_CLOSE
		_, _, _ = procDesktopDestroy.Call(uintptr(hwnd))
		return 0
	case 0x0002: // WM_DESTROY
		desktopWnd.Lock()
		if desktopWnd.hwnd == hwnd {
			desktopWnd.hwnd = 0
			desktopWnd.browser = nil
			desktopWindow = nil
		}
		desktopWnd.Unlock()
		_, _, _ = procDesktopQuit.Call(0)
		return 0
	}
	result, _, _ := procDesktopDefProc.Call(uintptr(hwnd), uintptr(message), wparam, uintptr(unsafe.Pointer(lparam)))
	return result
}

// desktopRememberGeometry 记下窗口位置与大小，下次还按它打开。
func desktopRememberGeometry(hwnd windows.Handle) {
	if runningAgent == nil {
		return
	}
	var rect desktopRect
	if ok, _, _ := procDesktopRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rect))); ok == 0 {
		return
	}
	saveDesktopGeometry(runningAgent.dataDir, desktopGeometry{X: rect.Left, Y: rect.Top, Width: rect.Right - rect.Left, Height: rect.Bottom - rect.Top})
}

// desktopRoundCorners 让无边框窗口在 Windows 11 上也有圆角（旧系统忽略即可）。
func desktopRoundCorners(hwnd windows.Handle) {
	preference := uint32(2) // DWMWCP_ROUND
	_, _, _ = procDesktopCorner.Call(uintptr(hwnd), 33, uintptr(unsafe.Pointer(&preference)), 4)
}

func desktopSystemDPI() int32 {
	if dpi, _, _ := procDesktopDpi.Call(0); int32(dpi) >= 96 {
		return int32(dpi)
	}
	return 96
}

func desktopWindowDPI(hwnd windows.Handle) int32 {
	if dpi, _, _ := procDesktopDpi.Call(uintptr(hwnd)); int32(dpi) >= 96 {
		return int32(dpi)
	}
	return 96
}

// desktopWorkArea 是主显示器工作区：没有记住位置时窗口居中放在这里。
func desktopWorkArea() desktopRect {
	work := desktopRect{}
	_, _, _ = procDesktopParams.Call(0x0030, 0, uintptr(unsafe.Pointer(&work)), 0) // SPI_GETWORKAREA
	return work
}

// desktopDataDir 与主进程用同一个站点数据目录（WebView2 配置也放这里）。
func desktopDataDir() string {
	if runningAgent != nil && runningAgent.dataDir != "" {
		return runningAgent.dataDir
	}
	if base, err := os.UserConfigDir(); err == nil {
		return base + string(os.PathSeparator) + "vega-local"
	}
	return os.TempDir()
}
