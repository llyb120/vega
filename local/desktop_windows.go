//go:build windows

package main

// 桌面客户端窗口：整窗一个 WebView2，页面是本机内置的助理界面（数据走客户端的 API 通道）。
// 外观是自绘标题栏 + 左侧会话栏（照参考截图），所以窗口去掉系统标题栏：WM_NCCALCSIZE 返回 0
// 让客户区铺满，拖动/最小化/最大化/关闭由页面用 chrome.webview.postMessage 发回来做。
// 单独开进程：WebView2 是第三方 COM 组件，初始化失败也只关掉这个窗口，不带走托盘和正在跑的任务。

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

const (
	desktopWindowTitle = "Vega"
	desktopWindowClass = "VegaDesktopWindow"

	desktopWidth  = 1040
	desktopHeight = 760

	desktopShowMsg = 0x8000 + 21 // WM_APP+21：显示（已经开着就拿到前台）
	desktopParkMsg = 0x8000 + 22 // WM_APP+22：收起（挪到屏幕外，页面留着、下次秒开）

	// 预热时把窗口停在屏幕外：它一直是“可见”的，WebView2 合成器才不会停摆。
	desktopParkX = -20000
	desktopParkY = -20000
)

var (
	desktopUser32 = windows.NewLazySystemDLL("user32.dll")

	procDesktopRelease = desktopUser32.NewProc("ReleaseCapture")
	procDesktopSend    = desktopUser32.NewProc("SendMessageW")
	procDesktopZoomed  = desktopUser32.NewProc("IsZoomed")
	procDesktopMonitor = desktopUser32.NewProc("MonitorFromWindow")
)

var desktopHost struct {
	sync.Mutex
	hwnd    windows.Handle
	browser *edge.Chromium
	pending bool // 预热还没好就被点了：等 WebView2 就绪再摆出来
}

// desktopSpawn 同一个窗口只拉起一个进程。
var desktopSpawn struct {
	sync.Mutex
	opened bool
}

func desktopHostWindow() windows.Handle {
	desktopHost.Lock()
	defer desktopHost.Unlock()
	return desktopHost.hwnd
}

func desktopHostBrowser() *edge.Chromium {
	desktopHost.Lock()
	defer desktopHost.Unlock()
	return desktopHost.browser
}

// desktopWarm 客户端启动就把窗口进程拉起来（停在屏幕外，页面先加载好）。
func desktopWarm(url string) {
	if url == "" {
		return
	}
	desktopSpawn.Lock()
	defer desktopSpawn.Unlock()
	if desktopFindWindow() != 0 || desktopSpawn.opened {
		return
	}
	desktopLaunch(url)
}

// desktopShow 打开客户端窗口；已经开着就唤到前面。返回 false 时调用方退回系统浏览器。
func desktopShow(url string) bool {
	if url == "" {
		return false
	}
	desktopSpawn.Lock()
	defer desktopSpawn.Unlock()
	if hwnd := desktopFindWindow(); hwnd != 0 {
		_, _, _ = procPanelPost.Call(hwnd, desktopShowMsg, 0, 0)
		return true
	}
	if desktopSpawn.opened {
		return true // 还在预热：窗口一出来就自己冒头
	}
	if !desktopLaunch(url) {
		return false
	}
	go func() {
		for i := 0; i < 240; i++ {
			if hwnd := desktopFindWindow(); hwnd != 0 {
				_, _, _ = procPanelPost.Call(hwnd, desktopShowMsg, 0, 0)
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()
	return true
}

// desktopLaunch 起窗口进程（调用方持有 desktopSpawn 锁）。
func desktopLaunch(url string) bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	command := exec.Command(executable, "--desktop", url)
	// 千万别加 HideWindow：STARTF_USESHOWWINDOW+SW_HIDE 会把第一次 ShowWindow 吞掉，
	// 合成器建在隐藏窗口上，之后再显示也只有黑/白底。
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
	if err := command.Start(); err != nil {
		return false
	}
	desktopSpawn.opened = true
	go func() {
		_ = command.Wait()
		desktopSpawn.Lock()
		desktopSpawn.opened = false
		desktopSpawn.Unlock()
	}()
	return true
}

// desktopFindWindow 按标题找窗口（预热期它就已经存在，只是停在屏幕外）。
func desktopFindWindow() uintptr {
	hwnd, _, _ := procPanelFind.Call(0, uintptr(unsafe.Pointer(butterflyUTF16(desktopWindowTitle))))
	return hwnd
}

// desktopClose 关掉窗口（客户端退出时不让它单独留在桌面上）。
func desktopClose() {
	if hwnd := desktopFindWindow(); hwnd != 0 {
		_, _, _ = procPanelPost.Call(hwnd, 0x0010, 0, 0) // WM_CLOSE
	}
}

// desktopDataDir 与主进程用同一个站点数据目录，WebView2 配置与窗口几何都放这里。
func desktopDataDir() string {
	if executable, err := os.Executable(); err == nil {
		if pin, err := readInstancePin(filepath.Dir(executable)); err == nil {
			if dir, err := siteDataDir(pin.Origin); err == nil {
				return dir
			}
		}
	}
	if base, err := os.UserConfigDir(); err == nil {
		return filepath.Join(base, "vega-local")
	}
	return os.TempDir()
}

// desktopLog 窗口是独立进程，出问题时只能写主进程的 client.log（同站点数据目录）。
func desktopLog(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "vega-local: 客户端窗口 "+format+"\n", args...)
	executable, err := os.Executable()
	if err != nil {
		return
	}
	pin, err := readInstancePin(filepath.Dir(executable))
	if err != nil {
		return
	}
	dir, err := siteDataDir(pin.Origin)
	if err != nil {
		return
	}
	file, err := os.OpenFile(filepath.Join(dir, "client.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s 客户端窗口 %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// desktopRun 在独立进程里跑窗口：占住线程初始化 COM，再把窗口和 WebView2 交给宿主。
func desktopRun(url string) bool {
	version, versionErr := webviewloader.GetInstalledVersion()
	if versionErr != nil || version == "" {
		desktopLog("WebView2 运行时不可用（%v），改开系统浏览器", versionErr)
		return false // 没装 WebView2 运行时：交给系统浏览器，别让 COM 在这里崩掉
	}
	runtime.LockOSThread()
	if hr, _, _ := procButterflyCoInit.Call(0, 2); int32(hr) < 0 { // COINIT_APARTMENTTHREADED
		desktopLog("CoInitializeEx 失败 hr=0x%x", uint32(hr))
		return false
	}
	defer func() { _, _, _ = procButterflyCoUninit.Call() }()
	return desktopHostStart(url) // 阻塞到窗口销毁
}

// desktopHostStart 建窗 + 嵌 WebView2 + 载入页面，然后进入消息循环（阻塞到窗口销毁）。
func desktopHostStart(url string) bool {
	instance, _, _ := procButterflyModule.Call(0)
	procedure := syscall.NewCallback(desktopWndProc)
	class := chipWindowClass{
		Procedure: procedure,
		Instance:  windows.Handle(instance),
		ClassName: butterflyUTF16(desktopWindowClass),
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, last := procChipRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		desktopLog("注册窗口类失败：%v", last)
		return false
	}
	dpi := butterflyDPI()
	width := butterflyScale(desktopWidth, dpi)
	height := butterflyScale(desktopHeight, dpi)
	const (
		exAppWindow  = 0x00040000 // WS_EX_APPWINDOW：客户端窗口要出现在任务栏
		exNoRedraw   = 0x00200000
		wsPopup      = 0x80000000
		wsCaption    = 0x00C00000 // 有 WS_CAPTION 系统才给 DWM 阴影/圆角；客户区在 WM_NCCALCSIZE 里全部让出来
		wsSysMenu    = 0x00080000
		wsThickFrame = 0x00040000
		wsMinBox     = 0x00020000
		wsMaxBox     = 0x00010000
		wsClip       = 0x02000000
		wsVisible    = 0x10000000
	)
	parkX, parkY := int32(desktopParkX), int32(desktopParkY)
	hwnd, _, last := procChipCreate.Call(
		exAppWindow|exNoRedraw,
		uintptr(unsafe.Pointer(butterflyUTF16(desktopWindowClass))),
		uintptr(unsafe.Pointer(butterflyUTF16(desktopWindowTitle))),
		wsPopup|wsCaption|wsSysMenu|wsThickFrame|wsMinBox|wsMaxBox|wsClip|wsVisible,
		uintptr(uint32(parkX)), uintptr(uint32(parkY)),
		uintptr(width), uintptr(height),
		0, 0, uintptr(instance), 0)
	if hwnd == 0 {
		desktopLog("建窗口失败：%v", last)
		return false
	}
	desktopHost.Lock()
	desktopHost.hwnd = windows.Handle(hwnd)
	desktopHost.Unlock()

	// 停在工作区外的窗口会被系统判成“被遮挡”，WebView2 会停画；关掉这类节流。
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding")
	chromium := edge.NewChromium()
	chromium.DataPath = desktopDataDir() + `\webview`
	chromium.MessageCallback = func(text string) { desktopHandleMessage(windows.Handle(hwnd), text) }
	chromium.SetPermission(edge.CoreWebView2PermissionKindClipboardRead, edge.CoreWebView2PermissionStateAllow)
	if !chromium.Embed(hwnd) {
		desktopLog("WebView2 初始化失败")
		_, _, _ = procChipDestroy.Call(hwnd)
		return false
	}
	desktopHost.Lock()
	desktopHost.browser = chromium
	desktopHost.Unlock()
	// 页面自己铺满整个客户区，不留“透明边”。
	if c := chromium.GetController(); c != nil {
		if c2 := c.GetICoreWebView2Controller2(); c2 != nil {
			_ = c2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{A: 255, R: 252, G: 252, B: 252})
		}
	}
	chromium.Resize()
	chromium.Navigate(url)
	desktopLog("客户端窗口预热完成：%s", url)
	desktopHost.Lock()
	pending := desktopHost.pending
	desktopHost.pending = false
	desktopHost.Unlock()
	if pending {
		desktopPlace(windows.Handle(hwnd))
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

// desktopWndProc 客户端窗口的消息：去掉系统标题栏、尺寸变化把 WebView2 跟过去、显示/收起由页面或托盘触发。
func desktopWndProc(hwnd windows.Handle, message uint32, wparam uintptr, lparam *desktopMinMaxInfo) uintptr {
	switch message {
	case 0x0083: // WM_NCCALCSIZE：wparam≠0 时把整圈边框让成客户区（系统标题栏不画）
		if wparam != 0 {
			return 0
		}
	case 0x0005: // WM_SIZE
		if browser := desktopHostBrowser(); browser != nil {
			browser.Resize()
		}
		return 0
	case 0x0014: // WM_ERASEBKGND：别用系统背景刷，省得闪白
		return 1
	case 0x0024: // WM_GETMINMAXINFO：别缩成一条线；最大化不盖住任务栏
		if lparam != nil {
			info := lparam
			dpi := butterflyDPI()
			info.MinTrackSize = appuseWinPoint{X: butterflyScale(desktopMinWidth, dpi), Y: butterflyScale(desktopMinHeight, dpi)}
			if monitor, _, _ := procDesktopMonitor.Call(uintptr(hwnd), 2); monitor != 0 { // MONITOR_DEFAULTTONEAREST
				area := struct {
					Size    uint32
					Monitor appuseWinRect
					Work    appuseWinRect
					Flags   uint32
				}{}
				area.Size = uint32(unsafe.Sizeof(area))
				if ok, _, _ := procPanelInfo.Call(monitor, uintptr(unsafe.Pointer(&area))); ok != 0 && area.Work.Right > area.Work.Left {
					info.MaxPosition = appuseWinPoint{X: area.Work.Left, Y: area.Work.Top}
					info.MaxSize = appuseWinPoint{X: area.Work.Right - area.Work.Left, Y: area.Work.Bottom - area.Work.Top}
				}
			}
		}
		return 0
	case 0x0232: // WM_EXITSIZEMOVE：用户拖完/缩放完，把大小位置记下来
		desktopRememberGeometry(hwnd)
		return 0
	case desktopShowMsg:
		if browser := desktopHostBrowser(); browser == nil {
			desktopHost.Lock()
			desktopHost.pending = true
			desktopHost.Unlock()
			return 0
		}
		desktopPlace(hwnd)
		return 0
	case desktopParkMsg:
		desktopParkWindow(hwnd)
		return 0
	case 0x0010: // WM_CLOSE：主进程退出时真正关掉窗口（页面上的 × 只是收起，走 desktopParkMsg）
		_, _, _ = procChipDestroy.Call(uintptr(hwnd))
		return 0
	case 0x0002: // WM_DESTROY
		_, _, _ = procPanelQuit.Call(0)
		return 0
	}
	result, _, _ := procChipDefProc.Call(uintptr(hwnd), uintptr(message), wparam, uintptr(unsafe.Pointer(lparam)))
	return result
}

// desktopMinMaxInfo 是 MINMAXINFO 的布局：五个 POINT，只有 MinTrackSize/MaxSize/MaxPosition 用得上。
type desktopMinMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize appuseWinPoint
}

// desktopHandleMessage 页面发回来的窗口动作（chrome.webview.postMessage 的 JSON）。
func desktopHandleMessage(hwnd windows.Handle, text string) {
	var message struct {
		Drag int    `json:"drag"`
		Win  string `json:"win"`
	}
	if json.Unmarshal([]byte(text), &message) != nil {
		return
	}
	switch {
	case message.Drag != 0:
		// 页面里的标题栏按下了：交回系统做原生拖动。
		_, _, _ = procDesktopRelease.Call()
		_, _, _ = procDesktopSend.Call(uintptr(hwnd), 0x00A1, 2, 0) // WM_NCLBUTTONDOWN + HTCAPTION
	case message.Win == "min":
		_, _, _ = procPanelShow.Call(uintptr(hwnd), 6) // SW_MINIMIZE
	case message.Win == "max":
		if zoomed, _, _ := procDesktopZoomed.Call(uintptr(hwnd)); zoomed != 0 {
			_, _, _ = procPanelShow.Call(uintptr(hwnd), 9) // SW_RESTORE
		} else {
			_, _, _ = procPanelShow.Call(uintptr(hwnd), 3) // SW_MAXIMIZE
		}
	case message.Win == "close":
		desktopParkWindow(hwnd) // 和面板一样：收起而不是退出，托盘还在、任务照跑
	}
}

// desktopPlace 按上次的大小/位置摆出来（第一次就居中在工作区），并拿到前台。
func desktopPlace(hwnd windows.Handle) {
	dpi := butterflyDPI()
	width, height := butterflyScale(desktopWidth, dpi), butterflyScale(desktopHeight, dpi)
	x, y := int32(0), int32(0)
	if saved, ok := loadDesktopGeometry(desktopDataDir(), desktopMinWidth, desktopMinHeight); ok {
		x, y, width, height = saved.X, saved.Y, saved.Width, saved.Height
	} else if work := desktopWorkArea(hwnd); work.Right > work.Left {
		if width > work.Right-work.Left {
			width = work.Right - work.Left
		}
		if height > work.Bottom-work.Top {
			height = work.Bottom - work.Top
		}
		x = work.Left + (work.Right-work.Left-width)/2
		y = work.Top + (work.Bottom-work.Top-height)/2
	}
	_, _, _ = procPanelShow.Call(uintptr(hwnd), 9)                                                                                                          // SW_RESTORE：最小化过就先还原
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), 0, uintptr(uint32(x)), uintptr(uint32(y)), uintptr(uint32(width)), uintptr(uint32(height)), 0x0004|0x0040) // NOZORDER|SHOWWINDOW
	_, _, _ = procPanelForefront.Call(uintptr(hwnd))
}

// desktopParkWindow 把窗口收回屏幕外（不激活、不改尺寸），页面和 WebView2 都留着。
func desktopParkWindow(hwnd windows.Handle) {
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), 0, ^uintptr(-desktopParkX-1), ^uintptr(-desktopParkY-1), 0, 0, 0x0010|0x0004|0x0001|0x0200) // NOACTIVATE|NOZORDER|NOSIZE|NOOWNERZORDER
}

// desktopRememberGeometry 记住窗口当前位置与大小（收起到屏幕外时不记）。
func desktopRememberGeometry(hwnd windows.Handle) {
	var rect appuseWinRect
	_, _, _ = procPanelRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rect)))
	if rect.Right-rect.Left < desktopMinWidth || rect.Bottom-rect.Top < desktopMinHeight {
		return
	}
	saveDesktopGeometry(desktopDataDir(), desktopGeometry{X: rect.Left, Y: rect.Top, Width: rect.Right - rect.Left, Height: rect.Bottom - rect.Top})
}

// desktopWorkArea 窗口所在显示器的工作区。
func desktopWorkArea(hwnd windows.Handle) appuseWinRect {
	monitor, _, _ := procDesktopMonitor.Call(uintptr(hwnd), 2) // MONITOR_DEFAULTTONEAREST
	area := struct {
		Size    uint32
		Monitor appuseWinRect
		Work    appuseWinRect
		Flags   uint32
	}{}
	area.Size = uint32(unsafe.Sizeof(area))
	if monitor != 0 {
		if ok, _, _ := procPanelInfo.Call(monitor, uintptr(unsafe.Pointer(&area))); ok != 0 {
			return area.Work
		}
	}
	var fallback appuseWinRect
	_, _, _ = procButterflyParams.Call(0x0030, 0, uintptr(unsafe.Pointer(&fallback)), 0) // SPI_GETWORKAREA
	return fallback
}
