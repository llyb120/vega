//go:build windows

package main

// 面板落点对齐 Nova 的 bubble::frame：居中在蝴蝶上方、贴住工作区下沿留出间隙，
// 放不下就缩，任何时候都不许压到任务栏和托盘图标。

import (
	"testing"
)

func TestButterflyPanelFrameHugsTheChipAndKeepsOffTheTaskbar(t *testing.T) {
	// 2880x1800 @200%，任务栏 96px 高，蝴蝶在任务栏里（1808..2128）。
	work := appuseWinRect{Left: 0, Top: 0, Right: 2880, Bottom: 1704}
	chip := appuseWinRect{Left: 1808, Top: 1724, Right: 2128, Bottom: 1780}
	x, y, width, height := butterflyPanelFrame(chip, work, 192)
	if width != 1280 || height != 1280 {
		t.Fatalf("面板尺寸应是 640x640 逻辑像素：%dx%d", width, height)
	}
	if x+width/2 != (chip.Left+chip.Right)/2 {
		t.Fatalf("水平方向要居中在蝴蝶上：x=%d", x)
	}
	if y+height > work.Bottom-butterflyScale(butterflyPanelGap, 192) {
		t.Fatalf("面板不能压到任务栏：y+height=%d work=%d", y+height, work.Bottom)
	}
	if y < work.Top+butterflyScale(butterflyPanelMargin, 192) {
		t.Fatalf("面板不能顶出工作区：y=%d", y)
	}
}

func TestButterflyPanelFrameStaysInsideASmallWorkArea(t *testing.T) {
	// 1366x768 笔记本，蝴蝶贴着托盘（右边缘），面板得整体收进工作区。
	work := appuseWinRect{Left: 0, Top: 0, Right: 1366, Bottom: 728}
	chip := appuseWinRect{Left: 1250, Top: 732, Right: 1350, Bottom: 760}
	x, y, width, height := butterflyPanelFrame(chip, work, 96)
	margin := butterflyScale(butterflyPanelMargin, 96)
	gap := butterflyScale(butterflyPanelGap, 96)
	if x < work.Left+margin || x+width > work.Right-margin {
		t.Fatalf("面板要收进工作区：x=%d width=%d", x, width)
	}
	if y+height > work.Bottom-gap {
		t.Fatalf("面板不能压到任务栏：y+height=%d", y+height)
	}
}

func TestButterflyPanelFrameShrinksToAFittingHeight(t *testing.T) {
	// 工作区比面板矮：按可用高度缩，不能露出屏幕外，也不能掉到任务栏上。
	work := appuseWinRect{Left: 0, Top: 0, Right: 800, Bottom: 500}
	chip := appuseWinRect{Left: 320, Top: 504, Right: 480, Bottom: 532}
	x, y, width, height := butterflyPanelFrame(chip, work, 96)
	gap := butterflyScale(butterflyPanelGap, 96)
	if height > work.Bottom-work.Top {
		t.Fatalf("高度必须缩进工作区：%d", height)
	}
	if y < butterflyScale(butterflyPanelMargin, 96) || y+height > work.Bottom-gap {
		t.Fatalf("缩完之后仍要留出上下间隙：y=%d height=%d", y, height)
	}
	if width > work.Right-work.Left-2*butterflyScale(butterflyPanelMargin, 96) {
		t.Fatalf("宽度必须缩进工作区：%d", width)
	}
	if x+width/2 != (chip.Left+chip.Right)/2 {
		t.Fatalf("缩过宽度后还是居中在蝴蝶上：x=%d", x)
	}
}

func TestButterflyPanelFrameFallsBackToTheRightEdgeWithoutAChip(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 0, Right: 1440, Bottom: 900}
	x, y, width, _ := butterflyPanelFrame(appuseWinRect{}, work, 96)
	margin := butterflyScale(butterflyPanelMargin, 96)
	if x+width != work.Right-margin {
		t.Fatalf("找不到蝴蝶时贴右侧：x=%d width=%d", x, width)
	}
	if y < margin {
		t.Fatalf("找不到蝴蝶时也要留上边距：y=%d", y)
	}
}

func TestButterflyPanelFrameOpensBelowATopTaskbar(t *testing.T) {
	// 任务栏在屏幕上方时，面板应该在蝴蝶下面（工作区上沿）。
	work := appuseWinRect{Left: 0, Top: 48, Right: 1920, Bottom: 1080}
	chip := appuseWinRect{Left: 900, Top: 0, Right: 1060, Bottom: 48}
	_, y, _, height := butterflyPanelFrame(chip, work, 96)
	gap := butterflyScale(butterflyPanelGap, 96)
	if y != work.Top+gap {
		t.Fatalf("顶部任务栏时应贴工作区上沿：y=%d want %d", y, work.Top+gap)
	}
	if y+height > work.Bottom {
		t.Fatalf("面板超出工作区：y+height=%d", y+height)
	}
}
