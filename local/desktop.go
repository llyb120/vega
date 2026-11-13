package main

// 桌面客户端窗口的跨平台部分：窗口本身在 desktop_windows.go 里（Go + WebView2），
// 这里只放两个平台都用得上的东西——用户拖过的窗口位置与大小。

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const desktopGeometryFile = "desktop-window.json"

// 窗口最小尺寸：比这还小就放不下左栏 + 会话区（也和 geometry 的有效性一起用来判断旧文件）。
const (
	desktopMinWidth  = 720
	desktopMinHeight = 520
)

type desktopGeometry struct {
	X, Y, Width, Height int32
}

func desktopGeometryPath(dir string) string {
	return filepath.Join(dir, desktopGeometryFile)
}

// loadDesktopGeometry 上次关窗时的大小；比最小尺寸还小（或读不出来）就当没有。
func loadDesktopGeometry(dir string, minWidth, minHeight int32) (desktopGeometry, bool) {
	data, err := os.ReadFile(desktopGeometryPath(dir))
	if err != nil {
		return desktopGeometry{}, false
	}
	var geometry desktopGeometry
	if json.Unmarshal(data, &geometry) != nil || geometry.Width < minWidth || geometry.Height < minHeight {
		return desktopGeometry{}, false
	}
	return geometry, true
}

func saveDesktopGeometry(dir string, geometry desktopGeometry) {
	data, err := json.Marshal(geometry)
	if err != nil {
		return
	}
	_ = os.WriteFile(desktopGeometryPath(dir), data, 0o600)
}
