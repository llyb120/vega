//go:build windows && !linux

// Windows tray: connection status, online/offline, settings and Quit.
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

func systrayRun(configure, onQuit func(), setOnline func(bool)) {
	systray.Run(func() {
		systray.SetTitle("牵牛星")
		// 上线/下线：下线是软交接，交接完由服务端接着做；本机这期间不接任务。
		mOnline := systray.AddMenuItem("下线", "暂停接单：先把变动与登录态交接给服务端")
		mConfigure := systray.AddMenuItem("设置", "管理站点授权、补充内容和流量中继")
		mQuit := systray.AddMenuItem("退出", "Stop local agent")
		trayState.Lock()
		trayState.ready = true
		trayState.online = mOnline
		applyTrayAppearance(trayState.connected)
		trayState.Unlock()
		go func() {
			for {
				select {
				case <-mOnline.ClickedCh:
					trayState.Lock()
					online := trayState.offline // 已下线就是点上线
					trayState.Unlock()
					go setOnline(online)
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
	offline   bool
	site      string
	online    *systray.MenuItem
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
	if trayState.offline {
		return base + " · 已下线"
	}
	if connected {
		return base + " · 已连接"
	}
	return base + " · 未连接"
}

// setTrayOffline 让托盘菜单显示「下线/上线」的当前状态；设置页和托盘菜单共用它。
func setTrayOffline(offline bool) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.offline = offline
	if trayState.ready {
		applyTrayAppearance(trayState.connected)
	}
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
	if trayState.online != nil {
		if trayState.offline {
			trayState.online.SetTitle("上线")
			trayState.online.SetTooltip("恢复接单：重新连接站点并接新任务")
		} else {
			trayState.online.SetTitle("下线")
			trayState.online.SetTooltip("暂停接单：先把变动与登录态交接给服务端")
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
