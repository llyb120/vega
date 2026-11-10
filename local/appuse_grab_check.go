package main

// 抓屏自检（--grab-preview）：DXGI 与 GDI 各抓一帧同一块屏幕，逐像素比对。
// DXGI 走的是手写 COM vtable，槽位写错不会编译失败，只会在运行时拿错函数；
// 所以必须有一个“真实抓一帧并和已知正确的 GDI 比”的自检，而不是只信编译通过。

import (
	"fmt"
	"image"
	"math"
)

// grabPreview 打印每块屏幕的两条路径结果以及差异比例。差异过大即视为 DXGI 槽位有问题。
func grabPreview() error {
	monitors, err := appuseMonitors()
	if err != nil {
		return err
	}
	if len(monitors) == 0 {
		return fmt.Errorf("没有可截图的显示器")
	}
	failed := false
	for _, monitor := range monitors {
		dxgi, dxgiErr := dxgiGrab(monitor)
		gdi, gdiErr := gdiGrab(monitor)
		switch {
		case dxgiErr != nil:
			fmt.Printf("monitor-%d: DXGI 不可用（%v）→ 走 GDI 回退\n", monitor.ID, dxgiErr)
			failed = true
			continue
		case gdiErr != nil:
			fmt.Printf("monitor-%d: GDI 失败（%v），DXGI 已可用\n", monitor.ID, gdiErr)
			continue
		}
		if dxgi.Bounds() != gdi.Bounds() {
			fmt.Printf("monitor-%d: 尺寸不一致 DXGI=%v GDI=%v\n", monitor.ID, dxgi.Bounds(), gdi.Bounds())
			failed = true
			continue
		}
		difference := pixelDifference(dxgi, gdi)
		status := "OK"
		if difference > 0.02 {
			status = "MISMATCH"
			failed = true
		}
		fmt.Printf("monitor-%d: %dx%d DXGI vs GDI 差异 %.2f%% → %s\n",
			monitor.ID, dxgi.Bounds().Dx(), dxgi.Bounds().Dy(), difference*100, status)
	}
	if failed {
		return fmt.Errorf("抓屏自检未通过：DXGI 未生效或与 GDI 不一致")
	}
	return nil
}

// pixelDifference 返回两张同尺寸图中“明显不同”的像素比例。
func pixelDifference(a, b *image.RGBA) float64 {
	bounds := a.Bounds()
	if b.Bounds() != bounds {
		return 1
	}
	width, height := bounds.Dx(), bounds.Dy()
	if width == 0 || height == 0 {
		return 1
	}
	total, different := 0, 0
	// 抽样比较就够发现槽位错位（会整屏花掉），不必逐像素。
	step := 1
	for (width/step)*(height/step) > 60000 {
		step++
	}
	for y := 0; y < height; y += step {
		for x := 0; x < width; x += step {
			total++
			at := a.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			other := b.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			// DXGI 与 GDI 的取色时机不同：只把明显差异算作不同（>32/255）。
			if math.Abs(float64(a.Pix[at])-float64(b.Pix[other])) > 32 ||
				math.Abs(float64(a.Pix[at+1])-float64(b.Pix[other+1])) > 32 ||
				math.Abs(float64(a.Pix[at+2])-float64(b.Pix[other+2])) > 32 {
				different++
			}
		}
	}
	if total == 0 {
		return 1
	}
	return float64(different) / float64(total)
}
