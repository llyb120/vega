//go:build windows && !linux

// Windows tray: connection status, settings and Quit.
package main

import (
	_ "embed"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"github.com/getlantern/systray"
)

//go:embed icon.ico
var iconData []byte

//go:embed icon-connected.ico
var iconConnectedData []byte

// The pinned systray dependency opens its menu on both buttons and has no click callback.
// Subclass only its own window so the left button can restore the app and right-click still uses its menu.
func installTrayOpen() {
	const wndProcIndex = ^uintptr(3) // GWLP_WNDPROC (-4)
	const notifyMessage = 0x0401     // systray v1.2.2: WM_USER + 1
	class := butterflyUTF16("SystrayClass")
	callWindowProc := panelUser32.NewProc("CallWindowProcW")
	for after := uintptr(0); ; {
		hwnd, _, _ := procPanelFindChild.Call(0, after, uintptr(unsafe.Pointer(class)), 0)
		if hwnd == 0 {
			return
		}
		after = hwnd
		var pid uint32
		_, _, _ = procPanelOwner.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid != uint32(os.Getpid()) {
			continue
		}
		previous, _, _ := procPanelStyle.Call(hwnd, wndProcIndex)
		if previous == 0 {
			return
		}
		callback := syscall.NewCallback(func(wnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
			if message == notifyMessage {
				switch uint16(lparam) {
				case 0x0202, 0x0203: // WM_LBUTTONUP / WM_LBUTTONDBLCLK
					go butterflyOpen()
					return 0
				}
			}
			result, _, _ := callWindowProc.Call(previous, wnd, uintptr(message), wparam, lparam)
			return result
		})
		_, _, _ = procPanelSetStyle.Call(hwnd, wndProcIndex, callback)
		return
	}
}

func previewMain(fn func()) { fn() }

func systrayRun(configure, onQuit func()) {
	systray.Run(func() {
		systray.SetTitle("牵牛星")
		mButterfly := systray.AddMenuItem("打开牵牛星", "打开对话窗口")
		mConfigure := systray.AddMenuItem("设置", "管理站点授权、浏览器和补充内容")
		mQuit := systray.AddMenuItem("退出", "Stop local agent")
		trayState.Lock()
		trayState.ready = true
		applyTrayAppearance(trayState.connected)
		trayState.Unlock()
		installTrayOpen()
		go butterflyOpen()
		go func() {
			for {
				select {
				case <-mButterfly.ClickedCh:
					butterflyOpen()
				case <-mConfigure.ClickedCh:
					configure()
				case <-mQuit.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()
	}, onQuit)
}

var trayState struct {
	sync.Mutex
	ready     bool
	connected bool
	site      string
	// 蝴蝶提示："" 无、running 正在操作电脑、needs_review 待用户核对。
	notice     string
	noticeText string
}

// setSiteLabel 让托盘标题带上站点，多个站点的客户端一眼能分。
func setSiteLabel(site string) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.site = site
	if trayState.ready {
		applyTrayAppearance(trayState.connected)
	}
}

func connectionTooltip(connected bool) string {
	base := "牵牛星"
	if trayState.site != "" {
		base += " · " + trayState.site
	}
	if connected {
		return base + " · 已连接"
	}
	return base + " · 未连接"
}

// trayTooltip 把蝴蝶提示叠在连接状态上，鼠标停在托盘图标上就能看到。
func trayTooltip(connected bool, notice, text string) string {
	switch notice {
	case "needs_review":
		return "牵牛星 · 需要你核对：" + truncateRunes(text, 80)
	case "running":
		return "牵牛星 · 正在操作这台电脑"
	}
	return connectionTooltip(connected)
}

func applyTrayAppearance(connected bool) {
	if connected {
		systray.SetIcon(iconConnectedData)
	} else {
		systray.SetIcon(iconData)
	}
	systray.SetTooltip(trayTooltip(connected, trayState.notice, trayState.noticeText))
}

func butterflyTrayNotice(notice *butterflyNotice) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.notice, trayState.noticeText = "", ""
	if notice != nil {
		trayState.notice, trayState.noticeText = notice.Kind, notice.Text
	}
	if trayState.ready {
		applyTrayAppearance(trayState.connected)
	}
}

func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

func setState(connected bool) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.connected = connected
	if trayState.ready {
		applyTrayAppearance(connected)
	}
}
