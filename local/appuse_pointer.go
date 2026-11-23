package main

// Obsidian Cyber-Blade 剑形指针：与 Nova `jianlai::sword / paint_pointer` 同一套几何和 4×4 超采样绘制。
// 32 单位坐标系里剑尖即热点 (5.5, 5.5)，白描边 + 柔和投影 + 深玄黑剑身 + 电光青剑脊 + 剑尖青光晕。
// 系统指针（appuseCursorGlow=0.58）与反馈截图标记（appuseMarkerGlow=0.18）共用这份算法。

import "math"

const (
	appusePointerTip = 5.5
	appuseTipGlow    = 5.2
	appuseSwordScale = 0.88
	appuseCursorGlow = 0.58
	appuseMarkerGlow = 0.18
)

type appuseRGBA struct{ R, G, B, A float64 }

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

func appuseSword(x, y float64) (float64, appuseRGBA) {
	dx, dy := x-appusePointerTip, y-appusePointerTip
	k := (1 / math.Sqrt2) / appuseSwordScale
	s, w := (dx+dy)*k, (dx-dy)*k
	// 玄黑棱面双刃剑身 + 中心电光青剑脊。
	blade := appuseRGBA{15, 23, 42, 1}
	if math.Abs(w) < 0.48 {
		blade = appuseRGBA{56, 189, 248, 1}
		if s < 5.5 {
			blade = appuseRGBA{224, 242, 254, 1}
		}
	} else if w < 0 {
		blade = appuseRGBA{30, 41, 59, 1}
	}
	// 深靛缠绳剑柄。
	grip := appuseRGBA{15, 23, 42, 1}
	if math.Mod(math.Abs(s)*1.6, 1) < 0.5 {
		grip = appuseRGBA{30, 58, 138, 1}
	}
	parts := []struct {
		distance float64
		color    appuseRGBA
	}{
		{appusePolygonSD([][2]float64{{0, 0}, {5.2, -1.65}, {17.2, -1.95}, {17.2, 1.95}, {5.2, 1.65}}, s, w), blade},
		{appusePolygonSD([][2]float64{{16.8, -4.1}, {17.8, -5.0}, {19.0, -4.1}, {19.0, 4.1}, {17.8, 5.0}, {16.8, 4.1}}, s, w), appuseRGBA{14, 165, 233, 1}},
		{appusePolygonSD([][2]float64{{18.9, -1.2}, {24.2, -1.2}, {24.2, 1.2}, {18.9, 1.2}}, s, w), grip},
		{appusePolygonSD([][2]float64{{24.0, 0}, {25.4, -1.65}, {26.8, 0}, {25.4, 1.65}}, s, w), appuseRGBA{56, 189, 248, 1}},
	}
	best := parts[0]
	for _, part := range parts[1:] {
		if part.distance < best.distance {
			best = part
		}
	}
	return best.distance * appuseSwordScale, best.color
}

func appusePaintPointer(size int, shape func(float64, float64) (float64, appuseRGBA), rim appuseRGBA, glow appuseRGBA) []uint32 {
	const ss = 4
	unit := 32 / float64(size)
	pixels := make([]uint32, size*size)
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var acc [4]float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/ss) * unit
					y := (float64(py) + (float64(sy)+0.5)/ss) * unit
					d, color := shape(x, y)
					var r, g, b, a float64
					switch {
					case d <= 0:
						r, g, b, a = color.R, color.G, color.B, 1
					case d < 1.25:
						r, g, b, a = rim.R, rim.G, rim.B, 1
					default:
						// Soft drop shadow near blade + cyan ink glow at tip.
						shadowA := 0.0
						if d < 2.2 {
							shadowA = 0.28 * (1 - (d-1.25)/0.95)
						}
						r2 := (math.Pow(x-appusePointerTip, 2) + math.Pow(y-appusePointerTip, 2)) / (appuseTipGlow * appuseTipGlow)
						falloff := math.Max(0, 1-r2)
						glowA := glow.A * math.Pow(falloff, 1.5)
						if shadowA >= glowA && shadowA > 0 {
							r, g, b, a = 10, 15, 28, shadowA
						} else if glowA > 0 {
							r, g, b, a = glow.R, glow.G, glow.B, glowA
						}
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
				value := math.Round(v / acc[3])
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

func appusePointerPixels(size int, glow float64) []uint32 {
	return appusePaintPointer(size, appuseSword, appuseRGBA{255, 255, 255, 1}, appuseRGBA{56, 189, 248, glow})
}

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
