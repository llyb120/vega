//go:build windows

package main

// 面板是普通窗口：默认按 900x720 逻辑像素居中放在工作区，用户拖过就按记住的大小位置打开；
// 任何情况下都整体收进工作区，不压任务栏、不跑出屏幕。

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPanelWindowDefaultsToCenteredWindowSize(t *testing.T) {
	// 2880x1800 @200%，任务栏 96px 高，工作区到 1704。
	work := appuseWinRect{Left: 0, Top: 0, Right: 2880, Bottom: 1704}
	chip := appuseWinRect{Left: 1808, Top: 1724, Right: 2128, Bottom: 1780}
	x, y, width, height := butterflyPanelFrame(chip, work, nil, 192)
	if width != butterflyScale(butterflyPanelWidth, 192) || height != butterflyScale(butterflyPanelHeight, 192) {
		t.Fatalf("默认应是窗口尺寸而不是气泡尺寸：%dx%d", width, height)
	}
	if x != work.Left+(work.Right-work.Left-width)/2 || y != work.Top+(work.Bottom-work.Top-height)/2 {
		t.Fatalf("没有记住的位置时应居中：%d,%d", x, y)
	}
	if x < work.Left || y < work.Top || x+width > work.Right || y+height > work.Bottom {
		t.Fatalf("窗口超出工作区：%d,%d %dx%d", x, y, width, height)
	}
}

func TestPanelWindowShrinksIntoASmallWorkArea(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 0, Right: 800, Bottom: 500}
	x, y, width, height := butterflyPanelFrame(appuseWinRect{}, work, nil, 96)
	margin := butterflyScale(butterflyPanelMargin, 96)
	if width > work.Right-work.Left-2*margin || height > work.Bottom-work.Top-2*margin {
		t.Fatalf("工作区放不下时要缩：%dx%d", width, height)
	}
	if x < work.Left+margin || y < work.Top+margin || x+width > work.Right-margin || y+height > work.Bottom-margin {
		t.Fatalf("缩完仍要留出边距：%d,%d %dx%d", x, y, width, height)
	}
}

// 用户拖过窗口：下次按记住的大小位置打开，而不是又回到中间。
func TestPanelWindowReopensWhereTheUserLeftIt(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 0, Right: 1920, Bottom: 1040}
	saved := &panelGeometry{X: 120, Y: 90, Width: 1000, Height: 800}
	x, y, width, height := butterflyPanelFrame(appuseWinRect{}, work, saved, 96)
	if x != 120 || y != 90 || width != 1000 || height != 800 {
		t.Fatalf("没有沿用记住的窗口位置：%d,%d %dx%d", x, y, width, height)
	}
	// 换到更小的屏幕：记住的位置已经出界，回到居中，且仍然收在工作区里。
	small := appuseWinRect{Left: 0, Top: 0, Right: 1024, Bottom: 728}
	x, y, width, height = butterflyPanelFrame(appuseWinRect{}, small, saved, 96)
	if x < 0 || y < 0 || x+width > small.Right || y+height > small.Bottom {
		t.Fatalf("出界的旧位置必须回到工作区里：%d,%d %dx%d", x, y, width, height)
	}
}

func TestPanelGeometryRoundTripsAndRejectsTinyWindows(t *testing.T) {
	dir := t.TempDir()
	if _, ok := loadPanelGeometry(dir); ok {
		t.Fatal("没有文件时不应该有记住的窗口位置")
	}
	data := []byte(`{"X":40,"Y":60,"Width":1000,"Height":800}`)
	if err := os.WriteFile(filepath.Join(dir, butterflyPanelGeometryFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	saved, ok := loadPanelGeometry(dir)
	if !ok || saved.X != 40 || saved.Y != 60 || saved.Width != 1000 || saved.Height != 800 {
		t.Fatalf("记住的窗口位置没有读回来：%+v", saved)
	}
	// 缩成一条线的旧记录（或坏文件）不能直接拿来建窗口。
	tiny := []byte(`{"X":0,"Y":0,"Width":100,"Height":80}`)
	if err := os.WriteFile(filepath.Join(dir, butterflyPanelGeometryFile), tiny, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok = loadPanelGeometry(dir); ok {
		t.Fatal("过小的窗口记录应被丢弃")
	}
}
