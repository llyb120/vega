package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"math"
)

const (
	appuseImageMaxEdge   = 1568
	appuseImageMaxPixels = 1_150_000
	appuseJPEGQuality    = 85
)

// appuseVisionScale 对齐 Nova 的 vision_scale / TS browser-annotate.ts，限制长边 <= 1568 且总像素 <= 1.15M。
func appuseVisionScale(w, h int) float64 {
	longEdge := w
	if h > longEdge {
		longEdge = h
	}
	if longEdge < 1 {
		longEdge = 1
	}
	area := w * h
	if area < 1 {
		area = 1
	}
	scale := math.Min(
		float64(appuseImageMaxEdge)/float64(longEdge),
		math.Sqrt(float64(appuseImageMaxPixels)/float64(area)),
	)
	if scale > 1 {
		scale = 1
	}
	return scale
}

type appuseSomBox struct {
	ID int
	X  int
	Y  int
	W  int
	H  int
}

const (
	appuseSomGlyphW = 6
	appuseSomGlyphH = 9
)

var appuseSomDigits = [10][appuseSomGlyphH]uint8{
	{0b011110, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110}, // 0
	{0b001100, 0b011100, 0b111100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b111111}, // 1
	{0b011110, 0b110011, 0b000011, 0b000110, 0b001100, 0b011000, 0b110000, 0b110011, 0b111111}, // 2
	{0b011110, 0b110011, 0b000011, 0b001110, 0b000011, 0b000011, 0b000011, 0b110011, 0b011110}, // 3
	{0b000110, 0b001110, 0b011110, 0b110110, 0b110110, 0b111111, 0b000110, 0b000110, 0b000110}, // 4
	{0b111111, 0b110000, 0b110000, 0b111110, 0b000011, 0b000011, 0b000011, 0b110011, 0b011110}, // 5
	{0b011110, 0b110011, 0b110000, 0b111110, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110}, // 6
	{0b111111, 0b110011, 0b000011, 0b000110, 0b001100, 0b001100, 0b011000, 0b011000, 0b011000}, // 7
	{0b011110, 0b110011, 0b110011, 0b011110, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110}, // 8
	{0b011110, 0b110011, 0b110011, 0b110011, 0b011111, 0b000011, 0b000011, 0b110011, 0b011110}, // 9
}

func appuseBlendPx(img *image.RGBA, x, y int, r, g, b, a uint8) {
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if x < 0 || y < 0 || x >= w || y >= h || a == 0 {
		return
	}
	off := img.PixOffset(bounds.Min.X+x, bounds.Min.Y+y)
	if a == 255 {
		img.Pix[off], img.Pix[off+1], img.Pix[off+2], img.Pix[off+3] = r, g, b, 255
		return
	}
	alpha := uint32(a)
	inv := 255 - alpha
	img.Pix[off] = uint8((uint32(r)*alpha + uint32(img.Pix[off])*inv) / 255)
	img.Pix[off+1] = uint8((uint32(g)*alpha + uint32(img.Pix[off+1])*inv) / 255)
	img.Pix[off+2] = uint8((uint32(b)*alpha + uint32(img.Pix[off+2])*inv) / 255)
	img.Pix[off+3] = 255
}

type appuseSomColor struct{ R, G, B, A uint8 }

var appuseSomPalette = [4][2]appuseSomColor{
	{{49, 46, 129, 236}, {79, 70, 229, 108}},   // deep indigo
	{{6, 78, 59, 236}, {16, 185, 129, 108}},   // deep emerald
	{{136, 19, 55, 236}, {225, 29, 72, 108}},  // deep rose
	{{12, 74, 110, 236}, {14, 165, 233, 108}}, // deep slate-cyan
}

func appuseSomSignature(boxes []appuseSomBox, w, h int) uint64 {
	const (
		offset64 uint64 = 14695981039346656037
		prime64  uint64 = 1099511628211
	)
	mix := func(h uint64, v uint64) uint64 {
		for i := 0; i < 8; i++ {
			h ^= (v >> (i * 8)) & 0xff
			h *= prime64
		}
		return h
	}
	hash := offset64
	hash = mix(hash, uint64(w))
	hash = mix(hash, uint64(h))
	for _, box := range boxes {
		if box.W <= 1 || box.H <= 1 {
			continue
		}
		hash = mix(hash, uint64(box.ID))
		hash = mix(hash, uint64(box.X))
		hash = mix(hash, uint64(box.Y))
		hash = mix(hash, uint64(box.W))
		hash = mix(hash, uint64(box.H))
	}
	return hash
}

func appuseDrawRectOutline(img *image.RGBA, x0, y0, x1, y1 int, color appuseSomColor) {
	for x := x0; x <= x1; x++ {
		appuseBlendPx(img, x, y0, color.R, color.G, color.B, color.A)
		appuseBlendPx(img, x, y1, color.R, color.G, color.B, color.A)
	}
	for y := y0 + 1; y < y1; y++ {
		appuseBlendPx(img, x0, y, color.R, color.G, color.B, color.A)
		appuseBlendPx(img, x1, y, color.R, color.G, color.B, color.A)
	}
}

func appuseDrawPillBadge(img *image.RGBA, x, y, pw, ph int, label string, fill appuseSomColor) {
	for dy := 0; dy < ph; dy++ {
		for dx := 0; dx < pw; dx++ {
			if (dx == 0 || dx == pw-1) && (dy == 0 || dy == ph-1) {
				continue
			}
			isBorder := dx == 0 || dx == pw-1 || dy == 0 || dy == ph-1 ||
				((dx == 1 || dx == pw-2) && (dy == 1 || dy == ph-2))
			if isBorder {
				appuseBlendPx(img, x+dx, y+dy, 255, 255, 255, 245)
			} else {
				appuseBlendPx(img, x+dx, y+dy, fill.R, fill.G, fill.B, fill.A)
			}
		}
	}
	cursorX := x + 3
	cursorY := y + 2
	for i := 0; i < len(label); i++ {
		d := int(label[i] - '0')
		if d < 0 || d > 9 {
			continue
		}
		glyph := appuseSomDigits[d]
		for row := 0; row < appuseSomGlyphH; row++ {
			bits := glyph[row]
			for col := 0; col < appuseSomGlyphW; col++ {
				if (bits>>(appuseSomGlyphW-1-col))&1 != 0 {
					appuseBlendPx(img, cursorX+col, cursorY+row, 255, 255, 255, 255)
				}
			}
		}
		cursorX += appuseSomGlyphW + 1
	}
}

// appuseDrawSomRaw 在模型副本图上绘制无碰撞的 4 色 [1][2] 编号角标与淡轮廓；绝不修改原始 GuardFrames。
func appuseDrawSomRaw(img *image.RGBA, boxes []appuseSomBox) {
	if img == nil || len(boxes) == 0 {
		return
	}
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if w < 16 || h < 16 {
		return
	}
	type placedRect struct{ x0, y0, x1, y1 int }
	type mappedBox struct {
		id, x0, y0, x1, y1 int
		fill               appuseSomColor
	}
	type smallCenter struct{ id, cx, cy int }

	clamp := func(v, lo, hi int) int {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}

	mapped := make([]mappedBox, 0, len(boxes))
	for _, box := range boxes {
		if box.W <= 1 || box.H <= 1 {
			continue
		}
		x0 := clamp(box.X, 0, w-1)
		y0 := clamp(box.Y, 0, h-1)
		x1 := clamp(box.X+box.W, 0, w-1)
		y1 := clamp(box.Y+box.H, 0, h-1)
		if x1 <= x0+2 || y1 <= y0+2 {
			continue
		}
		pair := appuseSomPalette[absInt(box.ID)%len(appuseSomPalette)]
		appuseDrawRectOutline(img, x0, y0, x1, y1, pair[1])
		mapped = append(mapped, mappedBox{box.ID, x0, y0, x1, y1, pair[0]})
	}

	small := make([]smallCenter, 0, len(mapped))
	for _, m := range mapped {
		if m.x1-m.x0 <= 56 && m.y1-m.y0 <= 28 {
			small = append(small, smallCenter{m.id, (m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2})
		}
	}

	placed := make([]placedRect, 0, len(mapped))
	overlaps := func(x, y, bw, bh int) bool {
		x1, y1 := x+bw, y+bh
		for _, r := range placed {
			if x < r.x1 && x1 > r.x0 && y < r.y1 && y1 > r.y0 {
				return true
			}
		}
		return false
	}

	for _, m := range mapped {
		label := intToStr(m.id)
		pw := len(label)*appuseSomGlyphW + maxInt(0, len(label)-1) + 6
		ph := appuseSomGlyphH + 4
		if pw > w || ph > h {
			continue
		}
		candidates := [][2]int{
			{m.x0 - 1, m.y0 - ph + 1},
			{m.x0, m.y0},
			{m.x1 - pw + 1, m.y0 - ph + 1},
			{m.x0 - 1, m.y1},
			{m.x1 - pw, m.y0},
			{m.x0 - pw, m.y0},
			{m.x1, m.y0},
			{m.x1 - pw + 1, m.y1},
		}
		bestPenalty := 2
		var chosen [2]int
		found := false
		for _, c := range candidates {
			cx := clamp(c[0], 0, w-pw)
			cy := clamp(c[1], 0, h-ph)
			if overlaps(cx, cy, pw, ph) {
				continue
			}
			penalty := 0
			for _, s := range small {
				if s.id != m.id && s.cx >= cx && s.cx < cx+pw && s.cy >= cy && s.cy < cy+ph {
					penalty = 1
					break
				}
			}
			if !found || penalty < bestPenalty {
				chosen = [2]int{cx, cy}
				bestPenalty = penalty
				found = true
				if penalty == 0 {
					break
				}
			}
		}
		if found {
			placed = append(placed, placedRect{chosen[0], chosen[1], chosen[0] + pw, chosen[1] + ph})
			appuseDrawPillBadge(img, chosen[0], chosen[1], pw, ph, label, m.fill)
		}
	}
}

func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// appuseEncodeJPEG 把 RGBA 转成 JPEG (quality=82) 写文件并返回 base64，体积约为 PNG 的 1/5。
func appuseEncodeJPEG(img *image.RGBA) ([]byte, string, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: appuseJPEGQuality}); err != nil {
		return nil, "", err
	}
	raw := buf.Bytes()
	return raw, base64Encode(raw), nil
}
