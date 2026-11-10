//go:build windows

package main

// 气泡浮在任务栏蝴蝶上方（对齐 Nova 的 ask 小气泡）：居中、贴工作区下沿、不压任务栏。

import "testing"

func TestButterflyBubbleSitsAboveTheChip(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 0, Right: 2880, Bottom: 1704}
	chip := appuseWinRect{Left: 1808, Top: 1724, Right: 2128, Bottom: 1780}
	gap, margin := butterflyScale(8, 192), butterflyScale(8, 192)
	x, y := butterflyBubbleFrame(chip, work, 688, 200, gap, margin)
	if x+688/2 != (chip.Left+chip.Right)/2 {
		t.Fatalf("水平要居中在蝴蝶上：x=%d", x)
	}
	if y+200 != work.Bottom-gap {
		t.Fatalf("气泡应贴在工作区下沿上方：y+height=%d want %d", y+200, work.Bottom-gap)
	}
}

func TestButterflyBubbleFallsBackToTheRightEdgeWithoutAChip(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 0, Right: 1440, Bottom: 900}
	margin, gap := butterflyScale(8, 96), butterflyScale(8, 96)
	x, y := butterflyBubbleFrame(appuseWinRect{}, work, 344, 120, gap, margin)
	if x+344 != work.Right-margin || y+120 != work.Bottom-gap {
		t.Fatalf("找不到蝴蝶时要贴右下角：x=%d y=%d", x, y)
	}
}

func TestButterflyBubbleOpensBelowATopTaskbar(t *testing.T) {
	work := appuseWinRect{Left: 0, Top: 48, Right: 1920, Bottom: 1080}
	chip := appuseWinRect{Left: 900, Top: 0, Right: 1060, Bottom: 48}
	gap := butterflyScale(8, 96)
	_, y := butterflyBubbleFrame(chip, work, 344, 120, gap, butterflyScale(8, 96))
	if y != work.Top+gap {
		t.Fatalf("顶部任务栏时应贴工作区上沿：y=%d want %d", y, work.Top+gap)
	}
}
