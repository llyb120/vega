//go:build windows && !linux

// Windows tray: connection status, the butterfly entry, trusted-site permissions, client hints and Quit.
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

func systrayRun(configure, onQuit func()) {
	systray.Run(func() {
		systray.SetTitle("牵牛星")
		// 蝴蝶：打开网页里的 BOT 会话；有提示时标题会跟着变。
		mAssistant := systray.AddMenuItem("蝴蝶助理", "在蝴蝶面板里打开 BOT 会话")
		mConfigure := systray.AddMenuItem("连接授权", "管理站点授权、补充内容和流量中继")
		mQuit := systray.AddMenuItem("退出", "Stop local agent")
		trayState.Lock()
		trayState.ready = true
		trayState.assistant = mAssistant
		applyTrayAppearance(trayState.connected)
		trayState.Unlock()
		go func() {
			for {
				select {
				case <-mAssistant.ClickedCh:
					butterflyOpen()
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
	assistant *systray.MenuItem
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
	if trayState.assistant != nil {
		if trayState.notice == "needs_review" {
			trayState.assistant.SetTitle("蝴蝶助理 · 待你核对")
		} else {
			trayState.assistant.SetTitle("蝴蝶助理")
		}
	}
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
