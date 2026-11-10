//go:build windows

package main

// 蝴蝶面板：点任务栏蝴蝶后出现的对话窗，里面是本地内置的助理界面（数据走本站点的客户端通道）。
// 对齐 Nova 的气泡：无边框圆角、置顶、不占任务栏、贴在蝴蝶上方、失焦自动收起，再点蝴蝶唤回。
// 进程在客户端启动时就拉起来预热：窗口建在屏幕外、页面先加载好，点开只是把它挪出来（没有白框闪现）。
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

	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

const (
	butterflyPanelTitle = "蝴蝶助理 · BOT 会话"
	// Nova taskbar-bubble 是 560px 宽的气泡；vega 助理同样贴蝴蝶上方、失焦收起。
	butterflyPanelWidth  = 640
	butterflyPanelHeight = 640
	// Nova 靠窗口自带的透明边距当间隙；我们没有透明边，就留真实间隙，别贴住任务栏。
	butterflyPanelMargin = 8
	butterflyPanelGap    = 10
)

var (
	panelUser32 = windows.NewLazySystemDLL("user32.dll")

	procPanelStyle      = panelUser32.NewProc("GetWindowLongPtrW")
	procPanelSetStyle   = panelUser32.NewProc("SetWindowLongPtrW")
	procPanelPlace      = panelUser32.NewProc("SetWindowPos")
	procPanelShow       = panelUser32.NewProc("ShowWindow")
	procPanelForefront  = panelUser32.NewProc("SetForegroundWindow")
	procPanelCursor     = panelUser32.NewProc("GetCursorPos")
	procPanelRegion     = panelUser32.NewProc("SetWindowRgn")
	procPanelMonitor    = panelUser32.NewProc("MonitorFromPoint")
	procPanelInfo       = panelUser32.NewProc("GetMonitorInfoW")
	procPanelFind       = panelUser32.NewProc("FindWindowW")
	procPanelFindChild  = panelUser32.NewProc("FindWindowExW")
	procPanelPost       = panelUser32.NewProc("PostMessageW")
	procPanelForeground = panelUser32.NewProc("GetForegroundWindow")
	procPanelAncestor   = panelUser32.NewProc("GetAncestor")
	procPanelDpi        = panelUser32.NewProc("GetDpiForWindow")
	procPanelVisible    = panelUser32.NewProc("IsWindowVisible")
	procPanelAttach     = panelUser32.NewProc("AttachThreadInput")
	procPanelFocus      = panelUser32.NewProc("SetFocus")
	procPanelThread     = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetCurrentThreadId")
	procPanelOwner      = panelUser32.NewProc("GetWindowThreadProcessId")
	procPanelQuit       = panelUser32.NewProc("PostQuitMessage")
	procPanelRgn        = windows.NewLazySystemDLL("gdi32.dll").NewProc("CreateRoundRectRgn")
	procPanelCorner     = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")
)

// 同一个面板只允许拉起一个：双击蝴蝶会连着触发两次，而 WebView2 起来之前还找不到窗口。
var butterflyPanelSpawn struct {
	sync.Mutex
	opened bool
}

// 面板此刻是否摆在屏幕上（决定失焦要不要收回去）。
var panelShowState struct {
	sync.Mutex
	at time.Time
}

// butterflyPanelWarm 客户端启动就把面板进程拉起来（窗口停在屏幕外，页面先加载好）。
func butterflyPanelWarm(url string) {
	if url == "" {
		return
	}
	butterflyPanelSpawn.Lock()
	defer butterflyPanelSpawn.Unlock()
	if panelWindow() != 0 || butterflyPanelSpawn.opened {
		return
	}
	butterflyPanelLaunch(url)
}

// butterflyPanelOpen 打开面板；已经开着就唤到前面。返回 false 时调用方退回系统浏览器。
func butterflyPanelOpen(url string) bool {
	if url == "" {
		return false
	}
	butterflyPanelSpawn.Lock()
	defer butterflyPanelSpawn.Unlock()
	if hwnd := panelWindow(); hwnd != 0 {
		_, _, _ = procPanelPost.Call(hwnd, panelShowMsg, 0, 0)
		return true
	}
	if butterflyPanelSpawn.opened {
		return true // 还在预热：窗口一出来就自己冒头（下面的轮询会补上这一下）
	}
	if !butterflyPanelLaunch(url) {
		return false
	}
	// 第一次点击时进程才刚起来：等它把窗口建好，再让它挪到蝴蝶上方。
	go func() {
		for i := 0; i < 240; i++ {
			if hwnd := panelWindow(); hwnd != 0 {
				_, _, _ = procPanelPost.Call(hwnd, panelShowMsg, 0, 0)
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()
	return true
}

// butterflyPanelLaunch 起面板进程（调用方持有 butterflyPanelSpawn 锁）。
func butterflyPanelLaunch(url string) bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	command := exec.Command(executable, "--butterfly-panel", url)
	// 千万别加 HideWindow：它给子进程塞 STARTF_USESHOWWINDOW+SW_HIDE，系统的第一次
	// ShowWindow（WebView2 库建窗时那次）会被替换成隐藏，合成器就建在隐藏窗口上，
	// 之后再显示也只有黑/白底，页面永远不上屏。GUI 子系统本来就没有黑窗要藏。
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
	if err := command.Start(); err != nil {
		return false
	}
	butterflyPanelSpawn.opened = true
	go func() {
		_ = command.Wait()
		butterflyPanelSpawn.Lock()
		butterflyPanelSpawn.opened = false
		butterflyPanelSpawn.Unlock()
	}()
	return true
}

// panelWindow 面板窗口（按标题找；窗口在预热期就已经存在，只是停在屏幕外）。
func panelWindow() uintptr {
	hwnd, _, _ := procPanelFind.Call(0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle))))
	return hwnd
}

// butterflyPanelPark 把面板收回屏幕外（页面上的 × 用它：WebView2 留着，下次点开还是热的）。
func butterflyPanelPark() {
	if hwnd := panelWindow(); hwnd != 0 {
		_, _, _ = procPanelPost.Call(hwnd, panelParkMsg, 0, 0)
	}
}

// butterflyPanelClose 关掉面板（客户端退出时不让它单独留在桌面上）。
func butterflyPanelClose() {
	if hwnd := panelWindow(); hwnd != 0 {
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

// butterflyPanelDataDir 与主进程用同一个站点数据目录（读自己旁边的 instance.json），WebView2 配置也放这里。
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

// butterflyPanelRun 在独立进程里跑面板：占住线程初始化 COM，再把窗口和 WebView2 交给宿主。
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
	return panelHostStart(url) // 阻塞到窗口销毁
}

// butterflyPanelBlurWatch 失焦收起（Nova bubble 的 blur()）：已经摆出来的面板一旦不是前台
// （也不是它弹出的文件框/子窗口），就收回屏幕外，下次点蝴蝶秒开。
func butterflyPanelBlurWatch(hwnd windows.Handle) {
	ticker := time.NewTicker(180 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		panelShowState.Lock()
		at := panelShowState.at
		panelShowState.Unlock()
		if at.IsZero() || time.Since(at) < 500*time.Millisecond {
			continue
		}
		fg, _, _ := procPanelForeground.Call()
		if fg == 0 {
			continue
		}
		// GA_ROOTOWNER=3：前台是面板的文件选择器/弹窗时不算失焦。
		root, _, _ := procPanelAncestor.Call(fg, 3)
		if fg == uintptr(hwnd) || root == uintptr(hwnd) {
			continue
		}
		_, _, _ = procPanelPost.Call(uintptr(hwnd), panelParkMsg, 0, 0)
	}
}

// butterflyPanelChrome 去掉标题栏、置顶、不进任务栏，圆角交给系统。
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
	// Win11 让 DWM 画圆角（有抗锯齿还有阴影）；只有 Win10 才用 SetWindowRgn 硬裁剪——
	// 那条路径没有抗锯齿，白底页面的圆角四边会留白边。
	if !butterflyPanelRounded(hwnd) {
		dpi := butterflyDPI()
		round := butterflyScale(12, dpi)
		region, _, _ := procPanelRgn.Call(0, 0, uintptr(butterflyScale(butterflyPanelWidth, dpi)), uintptr(butterflyScale(butterflyPanelHeight, dpi)), uintptr(round*2), uintptr(round*2))
		if region != 0 {
			_, _, _ = procPanelRegion.Call(uintptr(hwnd), region, 1)
		}
	}
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), 0, 0, 0, 0, 0, 0x0020|0x0002|0x0001|0x0004) // FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER
}

// butterflyPanelRounded 让 DWM 给整个窗口画圆角（Win11 22000+）。返回 false 表示系统没这个能力。
func butterflyPanelRounded(hwnd windows.Handle) bool {
	if chipBuild() < 22000 {
		return false
	}
	const (
		dwmwCornerPreference = 33 // DWMWA_WINDOW_CORNER_PREFERENCE
		dwmwBorderColor      = 34 // DWMWA_BORDER_COLOR
		dwmwColorNone        = 0xFFFFFFFE
	)
	preference := int32(2) // DWMWCP_ROUND
	hr, _, _ := procPanelCorner.Call(uintptr(hwnd), dwmwCornerPreference, uintptr(unsafe.Pointer(&preference)), unsafe.Sizeof(preference))
	if hr != 0 {
		return false
	}
	// 圆角自带的 1px 描边也去掉：那圈线沿着四边和圆角绕一圈，就是“白边”。
	none := uint32(dwmwColorNone)
	_, _, _ = procPanelCorner.Call(uintptr(hwnd), dwmwBorderColor, uintptr(unsafe.Pointer(&none)), unsafe.Sizeof(none))
	return true
}

// butterflyPanelFrame 面板落点，对齐 Nova 的 bubble::frame：居中在蝴蝶上方、贴住工作区下沿，
// 四周留 margin；高度放不下就缩，永远不会压到任务栏和托盘图标。
func butterflyPanelFrame(anchor, work appuseWinRect, dpi uint32) (x, y, width, height int32) {
	margin := butterflyScale(butterflyPanelMargin, dpi)
	gap := butterflyScale(butterflyPanelGap, dpi)
	width = butterflyScale(butterflyPanelWidth, dpi)
	height = butterflyScale(butterflyPanelHeight, dpi)
	if limit := work.Right - work.Left - 2*margin; limit > 0 && width > limit {
		width = limit
	}
	if limit := work.Bottom - work.Top - 2*margin - gap; limit > 0 && height > limit {
		height = limit
	}
	center := work.Right - margin - width/2 // 找不到蝴蝶就贴屏幕右侧
	if anchor.Right > anchor.Left {
		center = (anchor.Left + anchor.Right) / 2
	}
	x = center - width/2
	if x < work.Left+margin {
		x = work.Left + margin
	}
	if x+width > work.Right-margin {
		x = work.Right - margin - width
	}
	// 任务栏在上边时面板贴工作区上沿，否则贴下沿上方；gap 就是和任务栏之间的空隙。
	y = work.Bottom - height - gap
	if anchor.Right > anchor.Left {
		if above := anchor.Top - height - gap; above >= work.Top+margin && above < y {
			y = above
		}
		if anchor.Top+anchor.Bottom < work.Top+work.Bottom {
			y = work.Top + gap
		}
	}
	if y < work.Top+margin {
		y = work.Top + margin
	}
	if y+height > work.Bottom-gap {
		y = work.Bottom - gap - height
	}
	return x, y, width, height
}

// butterflyPanelPlace 贴在任务栏蝴蝶上方：找不到蝴蝶就退到鼠标所在屏幕的右下角。
// 顺手把前台抢过来——面板是新进程，没有输入记录，得借当前前台的输入状态才抢得到。
func butterflyPanelPlace(hwnd windows.Handle) {
	anchor, chip := butterflyAnchor()
	var point appuseWinPoint
	_, _, _ = procPanelCursor.Call(uintptr(unsafe.Pointer(&point)))
	dpi := butterflyDPI()
	if anchor.Right > anchor.Left {
		point = appuseWinPoint{X: (anchor.Left + anchor.Right) / 2, Y: anchor.Top}
		// 蝴蝶在哪块屏、什么缩放，面板就跟到哪，不跨屏幕串缩放。
		if scaled, _, _ := procPanelDpi.Call(chip); scaled >= 96 {
			dpi = uint32(scaled)
		}
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
		_, _, _ = procButterflyParams.Call(0x0030, 0, uintptr(unsafe.Pointer(&work)), 0) // SPI_GETWORKAREA
	}
	x, y, width, height := butterflyPanelFrame(anchor, work, dpi)
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), ^uintptr(0), uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0x0040|0x0020|0x0004) // SHOWWINDOW|FRAMECHANGED|NOZORDER（尺寸变了要重建 DWM 表面）
	panelClaimForeground(hwnd)
	panelShowState.Lock()
	panelShowState.at = time.Now()
	panelShowState.Unlock()
	// 面板是独立进程，落点只能靠这行日志回查（“位置不对”时先看 client.log）。
	panelLog("面板落点 %d,%d %dx%d dpi=%d 蝴蝶=%d,%d-%d,%d 工作区=%d,%d-%d,%d", x, y, width, height, dpi,
		anchor.Left, anchor.Top, anchor.Right, anchor.Bottom, work.Left, work.Top, work.Right, work.Bottom)
}

// panelClaimForeground 借当前前台的输入状态把面板拿到前台（新进程自己抢会被系统拒）。
func panelClaimForeground(hwnd windows.Handle) {
	fg, _, _ := procPanelForeground.Call()
	self, _, _ := procPanelThread.Call()
	target := uintptr(0)
	if fg != 0 {
		target, _, _ = procPanelOwner.Call(fg, 0)
	}
	attached := false
	if target != 0 && target != self {
		if ok, _, _ := procPanelAttach.Call(self, target, 1); ok != 0 {
			attached = true
		}
	}
	_, _, _ = procPanelForefront.Call(uintptr(hwnd))
	_, _, _ = procPanelFocus.Call(uintptr(hwnd))
	if browser := panelHostBrowser(); browser != nil {
		browser.Focus()
	}
	if attached {
		_, _, _ = procPanelAttach.Call(self, target, 0)
	}
	panelShowState.Lock()
	if panelShowState.at.IsZero() {
		panelShowState.at = time.Now()
	}
	panelShowState.Unlock()
}
