package main

// 剑形指针：与 Nova 的 jianlai::sword / paint_pointer 同一套几何和像素算法。
// 32 单位指针坐标系里剑尖朝左上且剑尖即热点，沿对角线依次是剑身、护手、剑柄、剑首；
// 每个像素 4×4 超采样，带描边和剑尖天蓝墨点光晕。系统指针与截图里的落点标记共用这份绘制，
// 只是光晕浓度不同（CURSOR_GLOW 浓、MARKER_GLOW 淡）。

import "math"

const (
	// appusePointerTip 是剑尖（热点）在 32 单位指针坐标里的位置。
	appusePointerTip = 10.0
	// appuseTipGlow 是以剑尖为圆心的墨点光晕半径。
	appuseTipGlow = 9.5
	// appuseSwordScale 让剑与剑尖光晕同时放得下。
	appuseSwordScale = 0.82
	// appuseCursorGlow 是真实系统指针上的光晕浓度：一滴天蓝墨点，用户平时就能找到指针。
	appuseCursorGlow = 0.72
	// appuseMarkerGlow 是反馈截图里的光晕浓度：只做淡提示，不遮挡模型要读的内容。
	appuseMarkerGlow = 0.2
)

type appuseRGBA struct{ R, G, B, A float64 }

// appusePolygonSD 是有符号距离场：多边形内部为负，外部为到最近边的距离。
func appusePolygonSD(poly [][2]float64, x, y float64) float64 {
	inside := false
	distance := math.MaxFloat64
	for index := 0; index < len(poly); index++ {
		a, b := poly[index], poly[(index+1)%len(poly)]
		if (a[1] > y) != (b[1] > y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0] {
			inside = !inside
		}
		ex, ey := b[0]-a[0], b[1]-a[1]
		t := ((x-a[0])*ex + (y-a[1])*ey) / (ex*ex + ey*ey)
		if t < 0 {
			t = 0
		} else if t > 1 {
			t = 1
		}
		distance = math.Min(distance, math.Hypot(x-a[0]-t*ex, y-a[1]-t*ey))
	}
	if inside {
		return -distance
	}
	return distance
}

// appuseSword 给出某点的有符号距离与部位颜色（剑身/护手/剑柄/剑首）。
func appuseSword(x, y float64) (float64, appuseRGBA) {
	dx, dy := x-appusePointerTip, y-appusePointerTip
	k := (1 / math.Sqrt2) / appuseSwordScale
	s, w := (dx+dy)*k, (dx-dy)*k
	// 细长的双刃剑身：剑脊一线高光，两侧一亮一暗。
	blade := appuseRGBA{147, 197, 253, 1}
	if math.Abs(w) < 0.3 {
		blade = appuseRGBA{255, 255, 255, 1}
	} else if w < 0 {
		blade = appuseRGBA{224, 242, 254, 1}
	}
	// 剑柄缠绳。
	grip := appuseRGBA{23, 37, 84, 1}
	if math.Mod(s*1.6, 1) < 0.5 {
		grip = appuseRGBA{30, 64, 175, 1}
	}
	parts := []struct {
		distance float64
		color    appuseRGBA
	}{
		{appusePolygonSD([][2]float64{{0, 0}, {5.5, -1.5}, {17, -1.85}, {17, 1.85}, {5.5, 1.5}}, s, w), blade},
		{appusePolygonSD([][2]float64{{16.8, -3.9}, {17.8, -4.9}, {18.9, -3.9}, {18.9, 3.9}, {17.8, 4.9}, {16.8, 3.9}}, s, w), appuseRGBA{2, 132, 199, 1}},
		{appusePolygonSD([][2]float64{{18.9, -1.15}, {24, -1.15}, {24, 1.15}, {18.9, 1.15}}, s, w), grip},
		{appusePolygonSD([][2]float64{{23.8, 0}, {25.2, -1.6}, {26.6, 0}, {25.2, 1.6}}, s, w), appuseRGBA{14, 165, 233, 1}},
	}
	best := parts[0]
	for _, part := range parts[1:] {
		if part.distance < best.distance {
			best = part
		}
	}
	return best.distance * appuseSwordScale, best.color
}

// appusePaintPointer 把 shape 画成 size×size 的直通 alpha 0xAARRGGBB 像素表（与 Nova 同一次序）。
func appusePaintPointer(size int, shape func(float64, float64) (float64, appuseRGBA), outline appuseRGBA, glow appuseRGBA) []uint32 {
	const ss = 4
	unit := 32 / float64(size)
	pixels := make([]uint32, size*size)
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var acc [4]float64 // 预乘 r,g,b,a
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/ss) * unit
					y := (float64(py) + (float64(sy)+0.5)/ss) * unit
					d, color := shape(x, y)
					var r, g, b, a float64
					switch {
					case d <= 0:
						r, g, b, a = color.R, color.G, color.B, 1
					case d < 0.6:
						r, g, b, a = outline.R, outline.G, outline.B, 1
					default:
						// 以尖端为圆心的墨点，中心浓、向外平滑淡出。
						r2 := (math.Pow(x-appusePointerTip, 2) + math.Pow(y-appusePointerTip, 2)) / (appuseTipGlow * appuseTipGlow)
						falloff := math.Max(0, 1-r2)
						r, g, b, a = glow.R, glow.G, glow.B, glow.A*math.Pow(falloff, 1.5)
					}
					acc[0] += r * a
					acc[1] += g * a
					acc[2] += b * a
					acc[3] += a
				}
			}
			a := acc[3] / (ss * ss)
			if a <= 0 {
				continue
			}
			channel := func(v float64) uint32 {
				value := math.Round(v/acc[3]) * 1
				if value < 0 {
					value = 0
				} else if value > 255 {
					value = 255
				}
				return uint32(value)
			}
			pixels[py*size+px] = uint32(math.Round(a*255))<<24 | channel(acc[0])<<16 | channel(acc[1])<<8 | channel(acc[2])
		}
	}
	return pixels
}

// appusePointerPixels 是剑形指针（系统指针用浓光晕，截图标记用淡光晕）。
func appusePointerPixels(size int, glow float64) []uint32 {
	return appusePaintPointer(size, appuseSword, appuseRGBA{12, 30, 64, 1}, appuseRGBA{56, 189, 248, glow})
}

// appuseBlendPointer 把指针像贴到图上：热点落在 (x,y)，超出画布的部分直接丢弃。
func appuseBlendPointer(img *appuseImage, size, hotspot int, pixels []uint32, x, y int) {
	for index, c := range pixels {
		a := float64(c>>24) / 255
		if a == 0 {
			continue
		}
		px, py := x+index%size-hotspot, y+index/size-hotspot
		if px < 0 || py < 0 || px >= img.W || py >= img.H {
			continue
		}
		at := (py*img.W + px) * 4
		for k, shift := range []uint{16, 8, 0} {
			source := float64((c >> shift) & 255)
			img.Pix[at+k] = uint8(math.Round(source*a + float64(img.Pix[at+k])*(1-a)))
		}
		img.Pix[at+3] = 255
	}
}
