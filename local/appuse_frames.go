package main

// 上一帧缓存：同一会话同一显示器上一次交付的原始像素与图片信息。
// 用途只有两个——判断这次画面有没有变（不变就复用旧图，不重传），
// 以及视觉守卫比较“截图那一刻”和“现在”是否还是同一个画面。

import (
	"image"
	"sync"
	"time"
)

// appuseFrame 记住一次交付：原始像素用于比较，entry 用于 unchanged 复用。
type appuseFrame struct {
	Image    *image.RGBA
	SourceW  uint32
	SourceH  uint32
	Monitor  uint32
	Payload  map[string]any
	Captured time.Time
}

var appuseFrames struct {
	sync.Mutex
	byOwner map[string]map[uint32]*appuseFrame
}

func appuseFrameMu() {
	if appuseFrames.byOwner == nil {
		appuseFrames.byOwner = make(map[string]map[uint32]*appuseFrame)
	}
}

// appusePreviousFrame 返回该会话上次各显示器的交付（没有就是空表）。
func appusePreviousFrame(owner string) map[uint32]*appuseFrame {
	appuseFrames.Lock()
	defer appuseFrames.Unlock()
	appuseFrameMu()
	frames := appuseFrames.byOwner[owner]
	if frames == nil {
		return map[uint32]*appuseFrame{}
	}
	return frames
}

// appuseRememberFrame 记下一次交付的原始像素；entry 里去掉 data（base64 只在本次结果里）。
func appuseRememberFrame(owner string, monitor uint32, grab *image.RGBA, entry map[string]any) {
	payload := make(map[string]any, len(entry))
	for key, value := range entry {
		if key == "data" {
			continue
		}
		payload[key] = value
	}
	appuseFrames.Lock()
	defer appuseFrames.Unlock()
	appuseFrameMu()
	frames := appuseFrames.byOwner[owner]
	if frames == nil {
		frames = make(map[uint32]*appuseFrame)
		appuseFrames.byOwner[owner] = frames
	}
	frames[monitor] = &appuseFrame{
		Image: grab, SourceW: uint32(grab.Bounds().Dx()), SourceH: uint32(grab.Bounds().Dy()),
		Monitor: monitor, Payload: payload, Captured: time.Now(),
	}
}

// appuseDropFrames 在会话结束或输入改变了画面后清掉缓存：不要把旧像素当现状用。
func appuseDropFrames(owner string) {
	appuseFrames.Lock()
	defer appuseFrames.Unlock()
	delete(appuseFrames.byOwner, owner)
}

// Entry 返回可直接放进结果的图片描述（不含本次的 base64）。
func (f *appuseFrame) Entry() map[string]any {
	out := make(map[string]any, len(f.Payload)+2)
	for key, value := range f.Payload {
		out[key] = value
	}
	return out
}

// appuseEntryGeometryMatches 确认这次还是同一块桌面：显示器尺寸没变才允许复用旧图。
func appuseEntryGeometryMatches(entry map[string]any, monitor appuseSurface, width, height uint32) bool {
	originalW, okW := entry["originalWidth"].(uint32)
	originalH, okH := entry["originalHeight"].(uint32)
	if !okW || !okH {
		return false
	}
	region, hasRegion := entry["region"]
	if hasRegion && region != nil {
		return false
	}
	return originalW == width && originalH == height && monitor.W == width && monitor.H == height
}

// appuseFrameFresh 表示缓存足够新，能当作“截图那一刻”的比较基准。
func appuseFrameFresh(frame *appuseFrame, ttl time.Duration) bool {
	return frame != nil && !frame.Captured.IsZero() && time.Since(frame.Captured) <= ttl
}

// AppuseFrameForTest 只给测试用：取当前缓存的原始像素。
func AppuseFrameForTest(owner string, monitor uint32) *image.RGBA {
	frame := appusePreviousFrame(owner)[monitor]
	if frame == nil {
		return nil
	}
	return frame.Image
}
