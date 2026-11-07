//go:build windows

package main

// 蝴蝶面板：一个独立的小窗，里面就是网页里的 BOT 会话（WebView2）。
// 单独开进程：WebView2 是第三方 COM 组件，初始化失败也只会关掉这个小窗，不会带走托盘和正在跑的任务。

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

const (
	butterflyPanelTitle  = "蝴蝶助理 · BOT 会话"
	butterflyPanelWidth  = 400
	butterflyPanelHeight = 620
)

// butterflyPanelOpen 打开（或唤到前面）BOT 会话面板；返回 false 时由调用方退回系统浏览器。
func butterflyPanelOpen(url string) bool {
	if url == "" {
		return false
	}
	if hwnd, _, _ := procButterflyFind.Call(0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle)))); hwnd != 0 {
		_, _, _ = procShowWindow.Call(hwnd, 9) // SW_RESTORE
		_, _, _ = procSetForeground.Call(hwnd)
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
	if hwnd, _, _ := procButterflyFind.Call(0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyPanelTitle)))); hwnd != 0 {
		_, _, _ = procButterflyPost.Call(hwnd, 0x0010, 0, 0) // WM_CLOSE
	}
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
	if version, err := webviewloader.GetInstalledVersion(); err != nil || version == "" {
		return false // 没装 WebView2 运行时：交给系统浏览器，别让 COM 在这里崩掉
	}
	// 已经初始化过（同线程或库自己的 init）会返回 S_FALSE，也算成功。
	runtime.LockOSThread()
	if hr, _, _ := procButterflyCoInit.Call(0, 2); int32(hr) < 0 { // COINIT_APARTMENTTHREADED
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
		return false
	}
	hwnd := windows.Handle(uintptr(view.Window()))
	butterflyPanelState.Lock()
	butterflyPanelState.view, butterflyPanelState.hwnd = view, hwnd
	butterflyPanelState.Unlock()
	butterflyPanelPlace(hwnd)
	view.Navigate(url)
	view.Run() // 阻塞到窗口关闭；登录态留在自己的 WebView2 配置目录
	return true
}

// butterflyPanelPlace 摆到鼠标所在屏幕的右下角，大小按 DPI 放大。
func butterflyPanelPlace(hwnd windows.Handle) {
	dpi := butterflyDPI()
	width, height := butterflyScale(butterflyPanelWidth, dpi), butterflyScale(butterflyPanelHeight, dpi)
	var point appuseWinPoint
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	work := appuseWinRect{}
	if monitor, _, _ := procButterflyMonitorPt.Call(uintptr(unsafe.Pointer(&point)), 2); monitor != 0 {
		info := struct {
			Size    uint32
			Monitor appuseWinRect
			Work    appuseWinRect
			Flags   uint32
		}{}
		info.Size = uint32(unsafe.Sizeof(info))
		if ok, _, _ := procMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); ok != 0 {
			work = info.Work
		}
	}
	if work.Right == 0 && work.Bottom == 0 {
		_, _, _ = procButterflyParams.Call(0x0030, 0, uintptr(unsafe.Pointer(&work)), 0) // SPI_GETWORKAREA
	}
	gap := butterflyScale(18, dpi)
	x, y := work.Right-width-gap, work.Bottom-height-gap
	_, _, _ = procButterflyPlace.Call(uintptr(hwnd), ^uintptr(0), uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0x0010|0x0040)
}
