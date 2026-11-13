package main

import (
	"fmt"
	"image"
	"math"
	"time"
)

type appuseControlRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

func (r appuseControlRect) contains(x, y int) bool {
	return x >= r.X && y >= r.Y && int64(x) < int64(r.X)+int64(r.Width) && int64(y) < int64(r.Y)+int64(r.Height)
}
func (r appuseControlRect) value() map[string]any {
	return map[string]any{"x": r.X, "y": r.Y, "width": r.Width, "height": r.Height,
		"center": map[string]int{"x": r.X + r.Width/2, "y": r.Y + r.Height/2}}
}

type appuseControl struct {
	Name         string
	Role         string
	AutomationID string
	ClassName    string
	ControlType  int32
	Enabled      bool
	Rect         appuseControlRect
}
type appuseControlTree struct {
	Elements    []appuseControl
	Visited     int
	Truncated   bool
	TruncatedBy string
}
type appuseElementObservation struct {
	Owner    string
	Window   appuseWindow
	Controls []appuseControl
	Snapshot *appuseSnapshot
}

// Only the latest tree may authorize screen-coordinate input; never borrow another session's observation.
var appuseElementsLast *appuseElementObservation

func appuseElementsOperation(request *appuseRequest) map[string]any {
	if (request.X == nil) != (request.Y == nil) || (request.X != nil && request.WindowID != nil) {
		return failure("elements 的 x/y 必须成对，且与 windowId 二选一")
	}
	depth, limit := request.Depth, request.MaxItems
	if depth == 0 {
		depth = 3
	}
	if limit == 0 {
		limit = 40
	}
	if depth < 1 || depth > 20 || limit < 1 || limit > 200 || len([]rune(request.Filter)) > 200 {
		return failure("elements 的 depth 允许 1–20，maxItems 允许 1–200，filter 最多 200 字")
	}
	snapshot := appuseCurrent(request.Owner, request.SnapshotID)
	if request.SnapshotID != "" && (snapshot == nil || snapshot.Invalidated != "") {
		return failure("elements 的图片依据已失效；移除图片 ID 只读窗口，或先重新截图")
	}
	var shot *appuseShot
	if snapshot != nil && snapshot.Invalidated == "" {
		shot = appuseFindShot(snapshot, request.ImageID)
	}
	if request.ImageID != "" && shot == nil {
		return failure("elements 的 imageId 不属于最新可用截图")
	}
	windowID := request.WindowID
	if request.X != nil {
		point := appusePoint{X: int32(*request.X), Y: int32(*request.Y)}
		if int(point.X) != *request.X || int(point.Y) != *request.Y {
			return failure("elements 坐标超出物理像素范围")
		}
		if snapshot != nil {
			if shot != nil && shot.WindowID != nil {
				return failure("窗口自身截图缺少可靠的屏幕原点；请用 windowId 读取控件的 screen 坐标")
			}
			if shot == nil {
				return failure("多图观察需要明确 imageId")
			}
			var err error
			point, err = appusePointOf(shot, request.X, request.Y)
			if err != nil {
				return failure(err.Error())
			}
		}
		id, err := appuseWindowAtPoint(point)
		if err != nil {
			return failure(err.Error())
		}
		windowID = &id
	}
	if windowID == nil {
		windowID = appuseForegroundWindow()
	}
	if windowID == nil {
		return failure("没有可查询的窗口；请指定 windowId")
	}
	window, err := appuseWindowInfo(*windowID)
	if err != nil {
		return failure(err.Error())
	}
	appuseElementsLast = nil
	tree, err := appuseQueryElements(*windowID, depth, limit, request.Filter)
	if err != nil {
		return failure("读取控件树失败：" + err.Error())
	}
	// shortcut: window-only captures lack a reliable physical origin; use screen rectangles until shot geometry records it.
	if shot != nil && shot.WindowID != nil {
		shot = nil
	}
	items := make([]map[string]any, 0, len(tree.Elements))
	for _, control := range tree.Elements {
		row := map[string]any{"name": control.Name, "role": control.Role, "automationId": control.AutomationID,
			"className": control.ClassName, "enabled": control.Enabled, "screen": control.Rect.value()}
		rect := control.Rect
		if mapped, ok := appuseControlImageRect(rect, shot); ok {
			rect = mapped
			row["imageId"] = shot.ImageID
		} else if shot != nil {
			row["outsideImage"] = true
			items = append(items, row)
			continue
		}
		for key, value := range rect.value() {
			row[key] = value
		}
		items = append(items, row)
	}
	result := map[string]any{"windowId": *windowID, "app": window.App, "title": window.Title, "elements": items,
		"coordinateSpace": "screen-pixels", "visited": tree.Visited, "truncated": tree.Truncated,
		"focused": appuseSameForeground(windowID), "screenInputReady": false}
	if tree.Truncated {
		result["truncatedBy"] = tree.TruncatedBy
	}
	if shot != nil {
		result["coordinateSpace"] = "image-pixels"
		result["imageId"] = shot.ImageID
		result["snapshotId"] = snapshot.ID
	}
	// Keep an in-memory visual baseline, not a new image/snapshot sent to the model. Screen input must not bypass the pixel guard.
	monitors, err := appuseMonitors()
	if err != nil || len(monitors) == 0 || len(monitors) > 16 {
		result["screenInputError"] = "无法保留 1–16 屏的视觉基线"
		return result
	}
	baseline := &appuseSnapshot{Owner: request.Owner, Taken: time.Now(), GuardFrames: map[uint32]*image.RGBA{}}
	for _, monitor := range monitors {
		if !appuseSurfaceIntersectsWindow(monitor, window) {
			continue
		}
		pixels, err := appuseCaptureMonitor(monitor)
		if err != nil {
			result["screenInputError"] = err.Error()
			return result
		}
		baseline.GuardFrames[monitor.ID] = pixels
		baseline.Shots = append(baseline.Shots, appuseShot{Surface: monitor, Monitor: monitor.ID, Screen: true,
			PixelsW: monitor.W, PixelsH: monitor.H, SourceW: monitor.W, SourceH: monitor.H, WindowID: windowID})
	}
	if len(baseline.Shots) > 0 && len(tree.Elements) > 0 {
		appuseElementsLast = &appuseElementObservation{Owner: request.Owner, Window: window, Controls: tree.Elements, Snapshot: baseline}
		result["screenInputReady"] = true
	}
	return result
}
func appuseSurfaceIntersectsWindow(s appuseSurface, w appuseWindow) bool {
	return int64(s.X) < int64(w.X)+int64(w.W) && int64(w.X) < int64(s.X)+int64(s.W) &&
		int64(s.Y) < int64(w.Y)+int64(w.H) && int64(w.Y) < int64(s.Y)+int64(s.H)
}
func appuseControlImageRect(r appuseControlRect, shot *appuseShot) (appuseControlRect, bool) {
	if shot == nil || shot.WindowID != nil || shot.Surface.W == 0 || shot.Surface.H == 0 || shot.SourceW == 0 || shot.SourceH == 0 {
		return r, false
	}
	crop := appuseRegion{Width: shot.SourceW, Height: shot.SourceH}
	if shot.Region != nil {
		crop = *shot.Region
	}
	if crop.Width == 0 || crop.Height == 0 {
		return r, false
	}
	mapX := func(x int) float64 {
		return (float64(int64(x)-int64(shot.Surface.X))*float64(shot.SourceW)/float64(shot.Surface.W) - float64(crop.X)) * float64(shot.PixelsW) / float64(crop.Width)
	}
	mapY := func(y int) float64 {
		return (float64(int64(y)-int64(shot.Surface.Y))*float64(shot.SourceH)/float64(shot.Surface.H) - float64(crop.Y)) * float64(shot.PixelsH) / float64(crop.Height)
	}
	left, top := int(math.Floor(mapX(r.X))), int(math.Floor(mapY(r.Y)))
	right, bottom := int(math.Ceil(mapX(r.X+r.Width))), int(math.Ceil(mapY(r.Y+r.Height)))
	if left < 0 || top < 0 || right > int(shot.PixelsW) || bottom > int(shot.PixelsH) {
		return r, false
	}
	return appuseControlRect{X: left, Y: top, Width: right - left, Height: bottom - top}, true
}
func appuseScreenShot(snapshot *appuseSnapshot, x, y *int) *appuseShot {
	if x == nil || y == nil {
		return nil
	}
	for i := range snapshot.Shots {
		s := &snapshot.Shots[i]
		if (appuseControlRect{X: int(s.Surface.X), Y: int(s.Surface.Y), Width: int(s.Surface.W), Height: int(s.Surface.H)}).contains(*x, *y) {
			return s
		}
	}
	return nil
}
func appuseScreenSnapshot(request *appuseRequest) (*appuseSnapshot, error) {
	if request.SnapshotID != "" || request.ImageID != "" {
		return nil, fmt.Errorf("screen 坐标不能携带图片 ID")
	}
	state := appuseElementsLast
	if state == nil || state.Owner != request.Owner || state.Snapshot.Invalidated != "" || time.Since(state.Snapshot.Taken) > appuseSnapshotTTL {
		return nil, fmt.Errorf("没有本会话最新可用的控件观察；先 appuse_elements，不自动回退到截图坐标")
	}
	if request.WindowID != nil && *request.WindowID != state.Window.ID {
		return nil, fmt.Errorf("screen 的 windowId 与控件观察不符")
	}
	for _, action := range request.Actions {
		if action.Action == "wait" {
			continue
		}
		switch action.Action {
		case "click", "double_click", "move", "drag", "scroll":
		default:
			return nil, fmt.Errorf("screen 只允许指针动作和 wait，不允许键盘输入")
		}
		if appuseScreenShot(state.Snapshot, action.X, action.Y) == nil {
			return nil, fmt.Errorf("screen 坐标不在已观察的显示器上")
		}
		if action.Action == "drag" && appuseScreenShot(state.Snapshot, action.ToX, action.ToY) == nil {
			return nil, fmt.Errorf("拖动终点不在已观察的显示器上")
		}
	}
	return state.Snapshot, nil
}
func appuseScreenControl(controls []appuseControl, x, y int) *appuseControl {
	var found *appuseControl
	for i := range controls {
		c := &controls[i]
		if c.Rect.contains(x, y) && (found == nil || int64(c.Rect.Width)*int64(c.Rect.Height) < int64(found.Rect.Width)*int64(found.Rect.Height)) {
			found = c
		}
	}
	return found
}
func appuseScreenCheckTarget(action appuseAction) error {
	state := appuseElementsLast
	if state == nil || action.X == nil || action.Y == nil {
		return fmt.Errorf("控件观察已失效")
	}
	current, err := appuseWindowInfo(state.Window.ID)
	if err != nil {
		return err
	}
	if current.PID != state.Window.PID || current.X != state.Window.X || current.Y != state.Window.Y || current.W != state.Window.W || current.H != state.Window.H || !appuseSameForeground(&state.Window.ID) {
		return fmt.Errorf("控件所在窗口或焦点已变化；先激活并重新观察，不自动切窗")
	}
	control := appuseScreenControl(state.Controls, *action.X, *action.Y)
	if control == nil || !control.Enabled {
		return fmt.Errorf("落点没有已观察且可用的控件；重新 elements 或截图定位")
	}
	return appuseCheckElement(state.Window.ID, appusePoint{X: int32(*action.X), Y: int32(*action.Y)}, *control)
}
