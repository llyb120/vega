//go:build windows && !linux

// Windows build: real system tray icon via getlantern/systray. The icon is a
// small bundled .ico; the menu only offers Quit and the tooltip reports
// whether the agent is currently registered with the local Vega server.
package main

import (
	_ "embed"
	"os"

	"github.com/getlantern/systray"
)

//go:embed icon.ico
var iconData []byte

func systrayRun(onQuit func()) {
	systray.Run(func() {
		systray.SetIcon(iconData)
		systray.SetTitle("Vega Local")
		systray.SetTooltip("Vega 本地执行端")
		mQuit := systray.AddMenuItem("退出", "Stop local agent")
		go func() {
			<-mQuit.ClickedCh
			onQuit()
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
