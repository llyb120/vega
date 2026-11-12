//go:build windows && !linux

// Windows tray: the desktop window, settings and Quit.
package main

import (
	_ "embed"
	"os"
	"sync"

	"github.com/getlantern/systray"
)

//go:embed icon.ico
var iconData []byte

//go:embed icon-connected.ico
var iconConnectedData []byte

func systrayRun(open, configure, onQuit func()) {
	systray.Run(func() {
		systray.SetTitle("牵牛星")
		mWindow := systray.AddMenuItem("打开窗口", "牛马对话窗口")
		mConfigure := systray.AddMenuItem("设置", "管理站点授权、按牛马配置主从和补充内容")
		mQuit := systray.AddMenuItem("退出", "Stop local agent")
		trayState.Lock()
		trayState.ready = true
		applyTrayAppearance(trayState.connected)
		trayState.Unlock()
		go func() {
			for {
				select {
				case <-mWindow.ClickedCh:
					open()
				case <-mConfigure.ClickedCh:
					configure()
				case <-mQuit.ClickedCh:
					onQuit()
					return
				}
			}
		}()
	}, func() { os.Exit(0) })
}

var trayState struct {
	sync.Mutex
	ready     bool
	connected bool
	site      string
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

// trayTooltip 把窗口里的操作提示叠在连接状态上，鼠标停在托盘图标上就能看到。
func trayTooltip(connected bool) string {
	if notice := windowNoticeSnapshot(); notice != nil {
		switch notice.Kind {
		case "needs_review":
			return "牵牛星 · 需要你核对：" + truncateRunes(notice.Text, 80)
		case "running":
			return "牵牛星 · 正在操作这台电脑"
		}
	}
	return connectionTooltip(connected)
}

func applyTrayAppearance(connected bool) {
	if connected {
		systray.SetIcon(iconConnectedData)
	} else {
		systray.SetIcon(iconData)
	}
	systray.SetTooltip(trayTooltip(connected))
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
