package main

// 观察质量：稳定采样、画面是否变化的去重、以及遮挡/过期目标的视觉守卫。
// 与 Nova 的 visual_guard / jianlai::sample_image 对齐，但只做像素级判断，不做 OCR 或物体识别。

import (
	"bytes"
	"image"
	"time"
)

// appuseStability 采样一次观察的画面是否还在变化。它只报告状态，从不阻塞等待“稳定”：
// 动图/视频不该让截图一直卡住，模型自己决定要不要再等一次。
type appuseStability struct {
	Samples int    `json:"samples"`
	Status  string `json:"status"` // stable / animated / not_checked
	Elapsed int64  `json:"elapsedMs"`
}

// appuseSample 连拍两帧做限时比较：两帧几乎一样算 stable，明显不同算 animated。
// 只在调用方明确要看“是否还在动”时使用；普通截图仍只采一帧。
func appuseSample(grab func() (*image.RGBA, error)) (*image.RGBA, appuseStability) {
	started := time.Now()
	first, err := grab()
	if err != nil || first == nil {
		return first, appuseStability{Samples: 1, Status: "not_checked"}
	}
	second, err := grab()
	if err != nil || second == nil {
		return first, appuseStability{Samples: 1, Status: "not_checked", Elapsed: time.Since(started).Milliseconds()}
	}
	status := "animated"
	if appuseEqualPixels(first, second, 0.002) {
		status = "stable"
	}
	return second, appuseStability{Samples: 2, Status: status, Elapsed: time.Since(started).Milliseconds()}
}

// appuseEqualPixels 抽样比较两张图：允许 tolerance 比例的像素不同（光标闪烁、时钟秒数）。
func appuseEqualPixels(a, b *image.RGBA, tolerance float64) bool {
	bounds := a.Bounds()
	if b.Bounds() != bounds {
		return false
	}
	width, height := bounds.Dx(), bounds.Dy()
	if width == 0 || height == 0 {
		return true
	}
	// 等比抽样，最多看 2 万个点：比较是启发式的，不需要逐像素。
	step := 1
	for (width/step)*(height/step) > 20000 {
		step++
	}
	total, different := 0, 0
	for y := 0; y < height; y += step {
		for x := 0; x < width; x += step {
			total++
			at := a.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			other := b.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			for channel := 0; channel < 3; channel++ {
				if absUint8(a.Pix[at+channel], b.Pix[other+channel]) > 12 {
					different++
					break
				}
			}
		}
	}
	if total == 0 {
		return true
	}
	return float64(different)/float64(total) <= tolerance
}

func absUint8(a, b uint8) int {
	if a > b {
		return int(a) - int(b)
	}
	return int(b) - int(a)
}

// appuseChangedTiles 把两张图按 16×16 分块，返回哪些块变了。空切片表示没有变化。
// 与 Nova 的 changed_tiles 用途一致：去重、增量与遮挡判断共用一套网格。
func appuseChangedTiles(before, after *image.RGBA) []bool {
	bounds := before.Bounds()
	if after.Bounds() != bounds {
		return nil
	}
	const tile = 16
	cols := (bounds.Dx() + tile - 1) / tile
	rows := (bounds.Dy() + tile - 1) / tile
	changed := make([]bool, cols*rows)
	any := false
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			at := before.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			other := after.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			for channel := 0; channel < 3; channel++ {
				if absUint8(before.Pix[at+channel], after.Pix[other+channel]) > 6 {
					changed[(y/tile)*cols+x/tile] = true
					any = true
					break
				}
			}
		}
	}
	if !any {
		return nil
	}
	return changed
}

// appuseRegionUnchanged 判断某个矩形区域在两张图之间是否几乎没变（视觉守卫用）。
func appuseRegionUnchanged(before, after *image.RGBA, region appuseRegion, tolerance float64) bool {
	bounds := before.Bounds()
	if after.Bounds() != bounds {
		return false
	}
	x0, y0 := int(region.X), int(region.Y)
	x1, y1 := x0+int(region.Width), y0+int(region.Height)
	if x0 < 0 || y0 < 0 || x1 > bounds.Dx() || y1 > bounds.Dy() {
		return false
	}
	total, different := 0, 0
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			total++
			at := before.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			other := after.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
			for channel := 0; channel < 3; channel++ {
				if absUint8(before.Pix[at+channel], after.Pix[other+channel]) > 12 {
					different++
					break
				}
			}
		}
	}
	if total == 0 {
		return true
	}
	return float64(different)/float64(total) <= tolerance
}

// appusePNGFingerprint 是给“这张图是否与上次同一个画面”用的廉价指纹（长度 + 抽样字节）。
func appusePNGFingerprint(data []byte) [8]uint8 {
	var out [8]uint8
	if len(data) == 0 {
		return out
	}
	for index := 0; index < 8 && index*len(data)/8 < len(data); index++ {
		out[index] = data[index*len(data)/8]
	}
	return out
}

// appuseSameContent 表示两次编码的 PNG 内容一致（复用上一张，不再重传）。
func appuseSameContent(a, b []byte) bool {
	return len(a) == len(b) && len(a) > 0 && bytes.Equal(a, b)
}
