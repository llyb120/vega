package main

// 观察质量与可见层的守门测试：指针像素、稳定采样、变化块、租约与叫停。

import (
	"image"
	"testing"
	"time"
)

func solid(width, height int, r, g, b uint8) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			at := img.PixOffset(x, y)
			img.Pix[at], img.Pix[at+1], img.Pix[at+2], img.Pix[at+3] = r, g, b, 255
		}
	}
	return img
}

func TestPointerIsASwordWithAnInkDotAtTheTip(t *testing.T) {
	for _, size := range []int{32, 48, 64} {
		pixels := appusePointerPixels(size, appuseCursorGlow)
		if len(pixels) != size*size {
			t.Fatalf("%dpx 应有 size² 个像素", size)
		}
		at := func(x, y float64) uint32 {
			return pixels[(int(y*float64(size)/32))*size+int(x*float64(size)/32)]
		}
		// 四角必须透明：指针不能被一个方框罩住。
		for _, corner := range [][2]float64{{0.5, 0.5}, {31, 0.5}, {0.5, 31}, {31, 31}} {
			if alpha := at(corner[0], corner[1]) >> 24; alpha != 0 {
				t.Fatalf("%dpx 角 (%v,%v) 应透明，得到 alpha=%d", size, corner[0], corner[1], alpha)
			}
		}
		// 沿对角线是剑身：不透明且偏浅蓝白。
		blade := at(15.5, 15.5)
		if blade>>24 != 255 {
			t.Fatalf("%dpx 对角线上应是剑身：%08x", size, blade)
		}
		if blade&0xff <= 200 {
			t.Fatalf("%dpx 剑身是浅蓝白：%08x", size, blade)
		}
		// 剑尖周围是天蓝墨点：由浓到淡，始终半透明以免糊住落点。
		near := at(7, 9) >> 24
		far := at(4, 10) >> 24
		if !(near > far && far > 0 && near < 255) {
			t.Fatalf("%dpx 光晕应由浓到淡：%d -> %d", size, near, far)
		}
		if at(4, 10)&0xff <= 200 {
			t.Fatalf("%dpx 光晕是天蓝色", size)
		}
	}
}

func TestScreenshotMarkerGlowIsFainterThanTheCursor(t *testing.T) {
	alpha := func(p []uint32, x, y int) uint32 { return p[y*32+x] >> 24 }
	cursor := appusePointerPixels(32, appuseCursorGlow)
	marker := appusePointerPixels(32, appuseMarkerGlow)
	// 只有光晕、没有剑身也没有描边的一点。
	if !(alpha(marker, 6, 10)*2 < alpha(cursor, 6, 10) && alpha(marker, 6, 10) < 64) {
		t.Fatalf("反馈图里的光晕应明显更淡：%d vs %d", alpha(marker, 6, 10), alpha(cursor, 6, 10))
	}
	// 剑身本身仍然实心可辨。
	if alpha(marker, 16, 16) != 255 {
		t.Fatal("剑身必须实心")
	}
}

func TestMarkCursorMapsIntoRegionAndBlendsTheSword(t *testing.T) {
	surface := appuseSurface{ID: 0, X: 0, Y: 0, W: 1920, H: 1080}
	page := solid(400, 200, 255, 255, 255)
	crop := appuseRegion{X: 100, Y: 50, Width: 200, Height: 100}
	point := appuseMarkCursor(page, surface, appusePoint{X: 1920, Y: 1080}, crop, appusePoint{X: 200, Y: 100})
	if point == nil {
		t.Fatal("区域内的指针应标出来")
	}
	// 与 Nova 一致：映射到桌面像素中心，所以落在区域内的偏移后一格。
	if point.X != 201 || point.Y != 101 {
		t.Fatalf("映射错了：%+v", point)
	}
	// 标过之后至少有一个像素被染色（白底上出现天蓝墨点）。
	changed := false
	for index := 0; index < len(page.Pix) && !changed; index += 4 {
		changed = page.Pix[index] < 255 && page.Pix[index+1] < 255
	}
	if !changed {
		t.Fatal("指针没有画到图上")
	}
	// 区域本身之外不应被画到。
	if page.Pix[page.PixOffset(399, 199)] != 255 {
		t.Fatal("区域外不应有标记")
	}
	// 区域外的指针位置返回 nil，不猜。
	if appuseMarkCursor(solid(40, 20, 255, 255, 255), surface, appusePoint{X: 1920, Y: 1080}, crop, appusePoint{X: 5, Y: 5}) != nil {
		t.Fatal("指针不在区域内时不能给坐标")
	}
}

func TestChangedTilesDetectOnlyTouchedBlocks(t *testing.T) {
	before := solid(64, 64, 20, 20, 20)
	after := solid(64, 64, 20, 20, 20)
	if tiles := appuseChangedTiles(before, after); tiles != nil {
		t.Fatal("完全相同的两帧不应报变化")
	}
	// 只在第二块里点一个像素（块大小 16，从 x=16 开始）。
	at := after.PixOffset(17, 3)
	after.Pix[at], after.Pix[at+1], after.Pix[at+2] = 255, 255, 255
	tiles := appuseChangedTiles(before, after)
	if tiles == nil {
		t.Fatal("改了像素必须报变化")
	}
	if count := countTrue(tiles); count != 1 {
		t.Fatalf("只应有一个块变化，得到 %d", count)
	}
	if !tiles[1] {
		t.Fatal("变的是第 2 块（x=16..31）")
	}
	// 尺寸不同无法比较，明确返回 nil 而不是猜。
	if appuseChangedTiles(before, solid(32, 32, 0, 0, 0)) != nil {
		t.Fatal("尺寸不一致不能比较")
	}
}

func countTrue(values []bool) int {
	count := 0
	for _, value := range values {
		if value {
			count++
		}
	}
	return count
}

func TestEqualPixelsToleratesABlinkingCaret(t *testing.T) {
	base := solid(200, 100, 240, 240, 240)
	same := solid(200, 100, 240, 240, 240)
	if !appuseEqualPixels(base, same, 0.002) {
		t.Fatal("同一个画面应判为相同")
	}
	// 一小块光标闪烁：面积远低于容差。
	cursor := solid(200, 100, 240, 240, 240)
	for y := 10; y < 22; y++ {
		for x := 40; x < 42; x++ {
			at := cursor.PixOffset(x, y)
			cursor.Pix[at], cursor.Pix[at+1], cursor.Pix[at+2] = 0, 0, 0
		}
	}
	if !appuseEqualPixels(base, cursor, 0.002) {
		t.Fatal("小块光标变化不应判成整屏变了")
	}
	// 半个屏幕变了就必须判为不同。
	half := solid(200, 100, 240, 240, 240)
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			at := half.PixOffset(x, y)
			half.Pix[at], half.Pix[at+1], half.Pix[at+2] = 0, 0, 0
		}
	}
	if appuseEqualPixels(base, half, 0.002) {
		t.Fatal("大面积变化必须判为不同")
	}
}

func TestRegionUnchangedIsLocalToTheGuardedArea(t *testing.T) {
	before := solid(200, 200, 30, 30, 30)
	after := solid(200, 200, 30, 30, 30)
	region := appuseRegion{X: 10, Y: 10, Width: 40, Height: 40}
	if !appuseRegionUnchanged(before, after, region, 0.06) {
		t.Fatal("没变就是没变")
	}
	// 守卫区外变了：照样认为目标还在。
	outside := solid(200, 200, 30, 30, 30)
	for y := 100; y < 120; y++ {
		for x := 100; x < 120; x++ {
			at := outside.PixOffset(x, y)
			outside.Pix[at], outside.Pix[at+1], outside.Pix[at+2] = 200, 200, 200
		}
	}
	if !appuseRegionUnchanged(before, outside, region, 0.06) {
		t.Fatal("守卫区外变化不该拦下这一步")
	}
	// 守卫区里被盖住：必须拦下。
	covered := solid(200, 200, 30, 30, 30)
	for y := 10; y < 50; y++ {
		for x := 10; x < 50; x++ {
			at := covered.PixOffset(x, y)
			covered.Pix[at], covered.Pix[at+1], covered.Pix[at+2] = 250, 250, 250
		}
	}
	if appuseRegionUnchanged(before, covered, region, 0.06) {
		t.Fatal("目标被盖住必须拦下")
	}
	// 越界的区域不下结论（返回 false，让调用方保守处理）。
	if appuseRegionUnchanged(before, after, appuseRegion{X: 190, Y: 190, Width: 40, Height: 40}, 0.06) {
		t.Fatal("越界区域不能当作没变")
	}
}

func TestLeaseSerializesInputAndRestoresWhenReleased(t *testing.T) {
	appuseInput.Lock()
	appuseInput.holder, appuseInput.owner = "", ""
	appuseInput.Unlock()
	first, err := appuseAcquireInput("s1", "act")
	if err != nil {
		t.Fatalf("第一次应能拿到租约：%v", err)
	}
	if busy, _ := appuseInputActive(); !busy {
		t.Fatal("持有期间应报告占用")
	}
	if owner := appuseDesktopOwner(); owner != "s1" {
		t.Fatalf("归属应是 s1，得到 %q", owner)
	}
	// 同一时刻第二路拿不到，而且会等待/超时拒绝，不会交错。
	done := make(chan error, 1)
	go func() {
		lease, err := appuseAcquireInput("s2", "act")
		if lease != nil {
			lease.release()
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("另一路不该立刻拿到租约：%v", err)
	case <-time.After(120 * time.Millisecond):
	}
	first.release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("释放后另一路应拿到租约：%v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("释放后另一路仍拿不到租约")
	}
	if busy, _ := appuseInputActive(); busy {
		t.Fatal("全部释放后不应再报告占用")
	}
	// release 幂等：重复调用不能把后来者的租约清掉。
	first.release()
	appuseInput.Lock()
	holder := appuseInput.holder
	appuseInput.Unlock()
	if holder != "" {
		t.Fatalf("空闲时应没有持有者：%q", holder)
	}
}

func TestEscapeStopIsScopedToTheMomentTheUserPressedIt(t *testing.T) {
	appuseInput.Lock()
	appuseInput.escapedAt = time.Time{}
	appuseInput.Unlock()
	start := time.Now()
	if appuseEscapedSince(start) {
		t.Fatal("没按过 Esc")
	}
	appuseMarkEscaped()
	if !appuseEscapedSince(start) {
		t.Fatal("按过之后应报告叫停")
	}
	// 更早的批次不受影响：Esc 只对之后的操作生效。
	if appuseEscapedSince(time.Now().Add(time.Hour)) {
		t.Fatal("后续新批次不该被上一次 Esc 影响")
	}
	appuseInput.Lock()
	appuseInput.escapedAt = time.Time{}
	appuseInput.Unlock()
}

func TestRememberedFramesEnableUnchangedReuse(t *testing.T) {
	appuseDropFrames("owner-frames")
	monitor := appuseSurface{ID: 0, X: 0, Y: 0, W: 100, H: 50}
	grab := solid(100, 50, 10, 20, 30)
	entry := map[string]any{
		"imageId": "monitor-0", "width": 100, "height": 50,
		"originalWidth": uint32(100), "originalHeight": uint32(50),
		"monitorId": uint32(0), "path": "C:\\shots\\a.png", "data": "base64-should-be-dropped",
	}
	appuseRememberFrame("owner-frames", 0, grab, entry)
	frame := appusePreviousFrame("owner-frames")[0]
	if frame == nil || frame.Image == nil {
		t.Fatal("应记住这次交付")
	}
	if !appuseFrameFresh(frame, appuseSnapshotTTL) {
		t.Fatal("刚记下的帧应是新鲜的")
	}
	// data 不该留在缓存里（下次复用旧的 base64 会把过期图片当新图）。
	if _, has := frame.Payload["data"]; has {
		t.Fatal("缓存不应保留本次的 base64")
	}
	if !appuseEntryGeometryMatches(frame.Entry(), monitor, 100, 50) {
		t.Fatal("几何一致时应允许复用旧图")
	}
	if appuseEntryGeometryMatches(frame.Entry(), monitor, 120, 50) {
		t.Fatal("显示器尺寸变了就不能复用")
	}
	withRegion := frame.Entry()
	withRegion["region"] = appuseRegion{X: 0, Y: 0, Width: 10, Height: 10}
	if appuseEntryGeometryMatches(withRegion, monitor, 100, 50) {
		t.Fatal("局部截图不是整屏，不能当成可复用的整屏")
	}
	appuseDropFrames("owner-frames")
	if len(appusePreviousFrame("owner-frames")) != 0 {
		t.Fatal("清掉之后不该还有缓存")
	}
}

func TestScreenshotMarkerClaimsOnlyReachablePixels(t *testing.T) {
	// 指针在最上沿：上半截剑被裁掉，但热点坐标仍要报出来（模型要按它取点）。
	img := solid(64, 64, 255, 255, 255)
	surface := appuseSurface{ID: 0, X: 0, Y: 0, W: 64, H: 64}
	point := appuseMarkCursor(img, surface, appusePoint{X: 64, Y: 64}, appuseRegion{X: 0, Y: 0, Width: 64, Height: 64}, appusePoint{X: 0, Y: 0})
	if point == nil || point.X != 0 || point.Y != 0 {
		t.Fatalf("边角处的指针也应给出热点：%+v", point)
	}
}
