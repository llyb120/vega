//go:build windows

package main

// 蝴蝶面板：点任务栏蝴蝶后出现的对话窗，里面就是站点里的 BOT 会话（WebView2）。
// 对齐 Nova 的气泡：无边框圆角、置顶、不占任务栏、贴在蝴蝶上方、失焦自动收起，再点蝴蝶唤回。
// 单独开进程：WebView2 是第三方 COM 组件，初始化失败也只关掉这一个小窗，不带走托盘和正在跑的任务。

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

const (
	butterflyPanelTitle  = "蝴蝶助理 · BOT 会话"
	butterflyPanelWidth  = 420
	butterflyPanelHeight = 640
)

var (
	panelUser32 = windows.NewLazySystemDLL("user32.dll")

	procPanelStyle     = panelUser32.NewProc("GetWindowLongPtrW")
	procPanelSetStyle  = panelUser32.NewProc("SetWindowLongPtrW")
	procPanelPlace     = panelUser32.NewProc("SetWindowPos")
	procPanelShow      = panelUser32.NewProc("ShowWindow")
	procPanelForefront = panelUser32.NewProc("SetForegroundWindow")
	procPanelCursor    = panelUser32.NewProc("GetCursorPos")
	procPanelRegion    = panelUser32.NewProc("SetWindowRgn")
	procPanelMonitor   = panelUser32.NewProc("MonitorFromPoint")
	procPanelInfo      = panelUser32.NewProc("GetMonitorInfoW")
	procPanelFind      = panelUser32.NewProc("FindWindowW")
	procPanelFindChild = panelUser32.NewProc("FindWindowExW")
	procPanelPost      = panelUser32.NewProc("PostMessageW")
	procPanelRgn       = windows.NewLazySystemDLL("gdi32.dll").NewProc("CreateRoundRectRgn")
)

// butterflyPanelOpen 打开面板；已经开着就唤到前面。返回 false 时调用方退回系统浏览器。
func butterflyPanelOpen(url string) bool {
	if url == "" {
		return false
	}
	if hwnd, _, _ := procPanelFind.Call(0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle)))); hwnd != 0 {
		_, _, _ = procPanelShow.Call(hwnd, 9) // SW_RESTORE
		_, _, _ = procPanelForefront.Call(hwnd)
		return true
	}
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	command := exec.Command(executable, "--butterfly-panel", url)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008} // DETACHED_PROCESS
	if err := command.Start(); err != nil {
		return false
	}
	go command.Wait()
	return true
}

// butterflyPanelClose 关掉面板（客户端退出时不让它单独留在桌面上）。
func butterflyPanelClose() {
	if hwnd, _, _ := procPanelFind.Call(0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle)))); hwnd != 0 {
		_, _, _ = procPanelPost.Call(hwnd, 0x0010, 0, 0) // WM_CLOSE
	}
}

// panelLog 面板是独立进程，出问题时只能写主进程的 client.log（同站点数据目录）。
func panelLog(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "vega-local: 蝴蝶面板 "+format+"\n", args...)
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
	fmt.Fprintf(file, "%s 蝴蝶面板 %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

var butterflyPanelState struct {
	sync.Mutex
	view webview2.WebView
	hwnd windows.Handle
}

// butterflyPanelDataDir 与主进程用同一个站点数据目录（读自己旁边的 instance.json），登录态不会串。
func butterflyPanelDataDir() string {
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

// butterflyPanelRun 在独立进程里跑面板：占住线程初始化 COM，再起 WebView2 消息循环。
func butterflyPanelRun(url string) bool {
	version, versionErr := webviewloader.GetInstalledVersion()
	if versionErr != nil || version == "" {
		panelLog("WebView2 运行时不可用（%v），改开系统浏览器", versionErr)
		return false // 没装 WebView2 运行时：交给系统浏览器，别让 COM 在这里崩掉
	}
	// 已经初始化过（同线程或库自己的 init）会返回 S_FALSE，也算成功。
	runtime.LockOSThread()
	if hr, _, _ := procButterflyCoInit.Call(0, 2); int32(hr) < 0 { // COINIT_APARTMENTTHREADED
		panelLog("CoInitializeEx 失败 hr=0x%x", uint32(hr))
		return false
	}
	defer func() { _, _, _ = procButterflyCoUninit.Call() }()
	view := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(butterflyPanelDataDir(), "webview"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  butterflyPanelTitle,
			Width:  butterflyPanelWidth,
			Height: butterflyPanelHeight,
		},
	})
	if view == nil {
		panelLog("创建 WebView2 窗口失败（版本 %s）", version)
		return false
	}
	hwnd := windows.Handle(uintptr(view.Window()))
	butterflyPanelState.Lock()
	butterflyPanelState.view, butterflyPanelState.hwnd = view, hwnd
	butterflyPanelState.Unlock()
	butterflyPanelChrome(hwnd)
	butterflyPanelPlace(hwnd)
	panelLog("面板已开：%s", url)
	view.Navigate(url)
	view.Run() // 阻塞到窗口关闭；登录态留在自己的 WebView2 配置目录
	return true
}

// butterflyPanelChrome 去掉标题栏、置顶、不进任务栏，圆角与气泡一致。
func butterflyPanelChrome(hwnd windows.Handle) {
	gwlStyle, gwlExStyle := ^uintptr(15), ^uintptr(19) // GWL_STYLE = -16, GWL_EXSTYLE = -20
	const (
		wsPopup      = 0x80000000
		wsVisible    = 0x10000000
		wsThickFrame = 0x00040000
		wsCaption    = 0x00C00000
		exTopmost    = 0x00000008
		exToolWindow = 0x00000080
		exAppWindow  = 0x00040000
	)
	style, _, _ := procPanelStyle.Call(uintptr(hwnd), gwlStyle)
	_, _, _ = procPanelSetStyle.Call(uintptr(hwnd), gwlStyle, (style&^(wsCaption|wsThickFrame))|wsPopup|wsVisible)
	ex, _, _ := procPanelStyle.Call(uintptr(hwnd), gwlExStyle)
	_, _, _ = procPanelSetStyle.Call(uintptr(hwnd), gwlExStyle, (ex|exTopmost|exToolWindow)&^exAppWindow)
	// 圆角：和气泡一样，避免方形直角贴在工作区边上。
	dpi := butterflyDPI()
	round := butterflyScale(12, dpi)
	region, _, _ := procPanelRgn.Call(0, 0, uintptr(butterflyPanelWidth*int(dpi)/96), uintptr(butterflyPanelHeight*int(dpi)/96), uintptr(round*2), uintptr(round*2))
	if region != 0 {
		_, _, _ = procPanelRegion.Call(uintptr(hwnd), region, 1)
	}
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), 0, 0, 0, 0, 0, 0x0020|0x0002|0x0001|0x0004) // FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER
}

// butterflyPanelPlace 贴在任务栏蝴蝶上方：找不到蝴蝶就退到鼠标所在屏幕的右下角。
func butterflyPanelPlace(hwnd windows.Handle) {
	dpi := butterflyDPI()
	width, height := butterflyScale(butterflyPanelWidth, dpi), butterflyScale(butterflyPanelHeight, dpi)
	anchor := appuseWinRect{}
	// 任务栏蝴蝶是 Shell_TrayWnd 的子窗口，FindWindowW 找顶层窗口，得用 FindWindowExW。
	if taskbar, _, _ := procPanelFind.Call(uintptr(unsafe.Pointer(butterflyUTF16("Shell_TrayWnd"))), 0); taskbar != 0 {
		if chip, _, _ := procPanelFindChild.Call(taskbar, 0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyChipClass))), 0); chip != 0 {
			_, _, _ = procWindowRect.Call(chip, uintptr(unsafe.Pointer(&anchor)))
		}
	}
	var point appuseWinPoint
	_, _, _ = procPanelCursor.Call(uintptr(unsafe.Pointer(&point)))
	if anchor.Right > anchor.Left {
		point = appuseWinPoint{X: (anchor.Left + anchor.Right) / 2, Y: anchor.Top}
	}
	work := appuseWinRect{}
	// MonitorFromPoint 的 POINT 是按值传的：x64 下两个 int32 拼进一个寄存器，传指针会拿到错的显示器。
	packed := uintptr(uint32(point.X)) | uintptr(uint32(point.Y))<<32
	if monitor, _, _ := procPanelMonitor.Call(packed, 2); monitor != 0 { // MONITOR_DEFAULTTONEAREST
		info := struct {
			Size    uint32
			Monitor appuseWinRect
			Work    appuseWinRect
			Flags   uint32
		}{}
		info.Size = uint32(unsafe.Sizeof(info))
		if ok, _, _ := procPanelInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); ok != 0 {
			work = info.Work
		}
	}
	if work.Right == 0 && work.Bottom == 0 {
		_, _, _ = procButterflyParams.Call(0x0030, uintptr(unsafe.Pointer(&work)), 0, 0) // SPI_GETWORKAREA
	}
	margin := butterflyScale(8, dpi)
	gap := butterflyScale(10, dpi)
	x := work.Right - width - margin
	y := work.Bottom - height - gap
	if anchor.Right > anchor.Left {
		// 居中在蝴蝶上方；太靠边就贴住工作区。
		x = (anchor.Left+anchor.Right)/2 - width/2
		if x+width > work.Right-margin {
			x = work.Right - width - margin
		}
		if x < work.Left+margin {
			x = work.Left + margin
		}
		if anchor.Top-height-gap >= work.Top {
			y = anchor.Top - height - gap
		}
	}
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), ^uintptr(0), uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0x0010|0x0040) // NOACTIVATE|SHOWWINDOW
}
