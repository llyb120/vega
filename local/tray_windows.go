//go:build windows && !linux

// Windows tray: connection status, trusted-site permissions and Quit.
package main

import (
	_ "embed"
	"os"

	"github.com/getlantern/systray"
)

//go:embed icon.ico
var iconData []byte

func systrayRun(configure, onQuit func()) {
	systray.Run(func() {
		systray.SetIcon(iconData)
		systray.SetTitle("Vega Local")
		systray.SetTooltip("Vega 本地执行端")
		mConfigure := systray.AddMenuItem("连接授权", "查看或撤销已信任的 Vega 站点")
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
		// Show connection state in tooltip.
		setState = func(v bool) {
			if v {
				systray.SetTooltip("Vega 本地执行端 · 已连接")
			} else {
				systray.SetTooltip("Vega 本地执行端 · 未连接")
			}
		}
	}, func() { os.Exit(0) })
}

var setState = func(bool) {}
