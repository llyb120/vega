//go:build windows && !linux

// Windows tray: connection status, trusted-site permissions, client hints and Quit.
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
		trayState.Lock()
		trayState.ready = true
		applyTrayAppearance(trayState.connected)
		trayState.Unlock()
		mConfigure := systray.AddMenuItem("连接授权", "管理站点授权、补充内容和流量中继")
		mQuit := systray.AddMenuItem("退出", "Stop local agent")
		go func() {
			for {
				select {
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
}

func connectionTooltip(connected bool) string {
	if connected {
		return "牵牛星 · 已连接"
	}
	return "牵牛星 · 未连接"
}

func applyTrayAppearance(connected bool) {
	if connected {
		systray.SetIcon(iconConnectedData)
	} else {
		systray.SetIcon(iconData)
	}
	systray.SetTooltip(connectionTooltip(connected))
}

func setState(connected bool) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.connected = connected
	if trayState.ready {
		applyTrayAppearance(connected)
	}
}
