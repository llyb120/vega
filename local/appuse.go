package main

// appuse: 用真实鼠标键盘操作本机桌面的唯一通道（由 Nova 的剑来迁移而来，工具名统一为 appuse）。
// 观察与输入共用一份本机快照：截图给出坐标，输入只接受本会话 180 秒内最新的那一份；平台调用见 appuse_windows.go。
// shortcut: 单桌面、单快照、一把全局锁；需要多座席或独立私有桌面时再拆 broker。

import (
	"bytes"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"
)

const (
	appuseSnapshotTTL = 180 * time.Second
	appuseMaxActions  = 16
	appuseDefaultEdge = 1600
	appuseNotesLimit  = 12000
)

type appuseRegion struct {
	X      uint32 `json:"x"`
	Y      uint32 `json:"y"`
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
}

func (r appuseRegion) validate(width, height uint32) error {
	if r.Width == 0 || r.Height == 0 || uint64(r.X)+uint64(r.Width) > uint64(width) || uint64(r.Y)+uint64(r.Height) > uint64(height) {
		return fmt.Errorf("region 超出所选图片范围；regionSpace=source 用原始像素，image 用图内像素")
	}
	return nil
}

type appuseAction struct {
	Action string  `json:"action"`
	ID     *int    `json:"id"`
	X      *int    `json:"x"`
	Y      *int    `json:"y"`
	ToX    *int    `json:"toX"`
	ToY    *int    `json:"toY"`
	Button *string `json:"button"`
	Text   *string `json:"text"`
	Clear  *bool   `json:"clear"`
	Submit *bool   `json:"submit"`
	Key    *string `json:"key"`
	Delta  *int    `json:"delta"`
	Axis   *string `json:"axis"`
	MS     *int    `json:"ms"`
	Glide  *bool   `json:"glide"`
}

type appuseRequest struct {
	Operation       string         `json:"operation"`
	Owner           string         `json:"owner"`
	WindowID        *uint32        `json:"windowId"`
	MonitorID       *uint32        `json:"monitorId"`
	Region          *appuseRegion  `json:"region"`
	RegionSpace     string         `json:"regionSpace"`
	ZoomID          *int           `json:"zoomId"`
	Controls        *bool          `json:"controls"`
	SnapshotID      string         `json:"snapshotId"`
	ImageID         string         `json:"imageId"`
	Feedback        string         `json:"feedback"`
	Actions         []appuseAction `json:"actions"`
	MaxEdge         uint32         `json:"maxEdge"`
	ImagePath       string         `json:"imagePath"`
	Notes           string         `json:"notes"`
	Query           string         `json:"query"`
	Observe         *bool          `json:"observe"`
	CoordinateSpace string         `json:"coordinateSpace"`
	X               *int           `json:"x"`
	Y               *int           `json:"y"`
	Depth           int            `json:"depth"`
	MaxItems        int            `json:"maxItems"`
	Filter          string         `json:"filter"`
}

type appusePoint struct{ X, Y int32 }

type appuseWindow struct {
	ID        uint32
	PID       uint32
	App       string
	Title     string
	X, Y      int32
	W, H      uint32
	Monitor   uint32
	Focused   bool
	Minimized bool
}

type appuseSurface struct {
	ID  uint32
	PID uint32
	X   int32
	Y   int32
	W   uint32
	H   uint32
}

type appuseShot struct {
	ImageID        string
	Surface        appuseSurface
	Origin         appuseSurface
	PixelsW        uint32
	PixelsH        uint32
	SourceW        uint32
	SourceH        uint32
	Region         *appuseRegion
	Path           string
	Data           []byte
	Cursor         *appusePoint
	Controls       []appuseControlItem
	OverlayOutside *appusePoint
	WindowID       *uint32
	Monitor        uint32
	Screen         bool
}

type appuseSnapshot struct {
	ID          string
	Owner       string
	Taken       time.Time
	Shots       []appuseShot
	Foreground  *appusePoint
	MaxEdge     uint32
	Invalidated string
	GuardFrames map[uint32]*image.RGBA
}

var (
	appuseMu        sync.Mutex
	appuseSnapshots = map[string]*appuseSnapshot{}
)

// appuseExecute 处理一条 appuse 任务；返回给服务端的结果结构与 Nova 的剑来保持一致。
func appuseExecute(raw json.RawMessage) map[string]any {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request appuseRequest
	if err := decoder.Decode(&request); err != nil {
		return failure("appuse 参数无效：" + err.Error() + "；本批次尚未执行")
	}
	if request.Operation == "" && request.Actions != nil {
		request.Operation = "act"
	}
	if request.Owner == "" {
		request.Owner = "local"
	}
	maxEdge := request.MaxEdge
	if maxEdge == 0 && request.MaxEdge == 0 {
		maxEdge = appuseDefaultEdge
	}
	if maxEdge != 0 && (maxEdge < 640 || maxEdge > 3840) {
		return failure("maxEdge 允许 0（原分辨率）或 640–3840")
	}
	if len([]rune(request.Notes)) > appuseNotesLimit {
		return failure("notes 最多 12000 字符；本批次尚未执行")
	}
	if request.Feedback != "" && request.Feedback != "screenshot" && request.Feedback != "desktop" && request.Feedback != "none" {
		return failure("无效 feedback")
	}
	if request.Region != nil && request.Operation != "screenshot" {
		return failure("region 仅用于 screenshot")
	}
	if request.ZoomID != nil && request.Operation != "screenshot" {
		return failure("zoomId 仅用于 screenshot")
	}
	if request.ZoomID != nil && request.Region != nil {
		return failure("zoom.id 与 region 不能同时使用")
	}
	if request.RegionSpace != "" && request.RegionSpace != "source" && request.RegionSpace != "image" {
		return failure("regionSpace 必须是 source 或 image")
	}
	if request.RegionSpace == "image" && request.Region == nil {
		return failure("regionSpace=image 需要 region 及最新 snapshotId/imageId")
	}
	if request.MonitorID != nil && request.Operation != "screenshot" {
		return failure("monitorId 仅用于 screenshot；act 由 imageId 选择屏幕")
	}
	if request.CoordinateSpace != "" && request.CoordinateSpace != "image" && request.CoordinateSpace != "screen" {
		return failure("coordinateSpace 必须是 image 或 screen")
	}
	if request.CoordinateSpace == "screen" {
		if request.Operation != "act" || request.SnapshotID != "" || request.ImageID != "" {
			return failure("screen 只用于 act，不能携带图片 ID；本批未执行")
		}
		for _, action := range request.Actions {
			if action.Action == "type" || action.Action == "press" {
				return failure("screen 不允许键盘输入；本批未执行")
			}
		}
	}
	appuseDisplayOnly(&request)
	appuseInit()
	// 动鼠标键盘前先请用户点头：15 秒内不选就当作同意（与 Nova 数字员工操作电脑同一套）。
	// 放在拿全局锁之前：等用户点的那十几秒不能把截图和别路操作一起堵住。
	if request.Operation == "act" || request.Operation == "activate" {
		if reason := appuseConfirmInput(request.Owner); reason != "" {
			return map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false,
				"errorCode": "desktop_declined", "error": reason}
		}
	}
	appuseMu.Lock()
	defer appuseMu.Unlock()
	// 只有会动鼠标键盘、会抢焦点的操作才提醒；纯截图不该打扰用户。
	if request.Operation == "act" || request.Operation == "activate" {
		butterflyNotify("running", appuseRunningText(request.Operation))
		glowHold()
		defer glowRelease()
	}
	result := appuseRunLocked(&request, maxEdge)
	if request.Notes != "" {
		result["notes"] = request.Notes
	}
	appuseAnnounce(result)
	return result
}

// appuseDisplayOnly 丢掉只属于 windows 的展示选项：别的操作带上它不影响落点，
// 整批退回只是让模型白跑一轮（弱模型会顺手给 activate 带 observe:false）。
func appuseDisplayOnly(request *appuseRequest) {
	if request.Operation != "windows" {
		request.Query, request.Observe = "", nil
	}
}

func appuseRunningText(operation string) string {
	if operation == "activate" {
		return "正在把窗口切到前台（appuse activate），期间请不要抢鼠标"
	}
	return "正在用鼠标键盘操作这台电脑（appuse act），期间请不要抢鼠标"
}

// appuseAnnounce 根据结果收尾蝴蝶提示：可能已部分执行就留着让用户核对，其他情况收起“正在操作”。
func appuseAnnounce(result map[string]any) {
	if status, _ := result["status"].(string); status == "needs_review" {
		reason := ""
		for _, key := range []string{"reason", "executedNotice", "error"} {
			if text, _ := result[key].(string); text != "" {
				reason = text
				break
			}
		}
		butterflyNotify("needs_review", "appuse 可能已经部分执行："+appuseShort(reason)+"；请核对屏幕上的实际结果")
		return
	}
	butterflyClearIfKind("running")
}

func appuseShort(text string) string {
	runes := []rune(text)
	if len(runes) <= 120 {
		return text
	}
	return string(runes[:120]) + "…"
}

func appuseRunLocked(request *appuseRequest, maxEdge uint32) map[string]any {
	switch request.Operation {
	case "windows":
		return appuseWindowsOperation(request, maxEdge)
	case "elements":
		return appuseElementsOperation(request)
	case "screenshot":
		return appuseScreenshotOperation(request, maxEdge)
	case "activate":
		return appuseActivateOperation(request, maxEdge)
	case "act":
		return appuseActOperation(request, maxEdge)
	case "recall":
		return appuseRecallOperation(request)
	default:
		return failure("未知 appuse 操作；可用：windows/elements/screenshot/act/activate/recall")
	}
}

func appuseWindowsOperation(request *appuseRequest, maxEdge uint32) map[string]any {
	rows := []map[string]any{}
	windows, err := appuseListWindows()
	if err == nil {
		for _, w := range windows {
			rows = append(rows, map[string]any{
				"windowId": w.ID, "pid": w.PID, "monitorId": w.Monitor,
				"width": w.W, "height": w.H, "app": w.App, "title": w.Title,
				"focused": w.Focused, "minimized": w.Minimized,
			})
		}
	}
	result := map[string]any{"windows": rows}
	target := request.WindowID
	if query := strings.ToLower(strings.TrimSpace(request.Query)); query != "" {
		matched := []map[string]any{}
		for _, row := range rows {
			app, _ := row["app"].(string)
			title, _ := row["title"].(string)
			if strings.Contains(strings.ToLower(app), query) || strings.Contains(strings.ToLower(title), query) {
				matched = append(matched, row)
			}
		}
		usable := []map[string]any{}
		for _, row := range matched {
			minimized, _ := row["minimized"].(bool)
			width, _ := row["width"].(uint32)
			height, _ := row["height"].(uint32)
			if !minimized && width > 32 && height > 32 {
				usable = append(usable, row)
			}
		}
		result["totalWindows"] = len(rows)
		result["query"] = query
		switch {
		case len(usable) == 1 && target == nil:
			if id, ok := usable[0]["windowId"].(uint32); ok {
				target = &id
			}
		case len(usable) == 0:
			result["next"] = "没有可见窗口匹配 query（最小化窗口需先在桌面恢复）；核对完整列表或换关键词"
		case target == nil:
			result["next"] = "query 匹配到多个窗口，请指定 windowId 后再截图"
		}
		result["windows"] = matched
	}
	observe := request.Observe != nil && *request.Observe
	controlsOn := request.Controls == nil || *request.Controls
	emptyQuery := strings.TrimSpace(request.Query) == ""
	if observe && (target != nil || emptyQuery) {
		if observed := appuseCaptureWithOptions(request.Owner, target, nil, nil, maxEdge, controlsOn); observed != nil {
			for key, value := range observed {
				result[key] = value
			}
			result["observedBy"] = "query/windowId"
			if target != nil {
				result["observedWindowId"] = *target
				focused := false
				if fg := appuseForegroundWindow(); fg != nil && *target == *fg {
					focused = true
				}
				result["observedWindowFocused"] = focused
				if !focused {
					result["nextCall"] = map[string]any{"operation": "activate", "windowId": *target}
				}
			}
		}
	}
	return result
}

func appuseScreenshotOperation(request *appuseRequest, maxEdge uint32) map[string]any {
	controlsOn := request.Controls == nil || *request.Controls
	if request.ZoomID != nil {
		snapshot := appuseCurrent(request.Owner, request.SnapshotID)
		if snapshot == nil {
			return failure("局部放大依据已失效，请先重新截图")
		}
		shot, ctrl := appuseFindControl(snapshot, request.ImageID, *request.ZoomID)
		if shot == nil || ctrl == nil {
			return failure(fmt.Sprintf("当前最新截图中不存在控件编号 [%d]，请核对编号或省略 id 重新截图", *request.ZoomID))
		}
		padX := maxInt(96, int(ctrl.SourceRect.Width)/2)
		padY := maxInt(72, int(ctrl.SourceRect.Height)/2)
		x0 := maxInt(0, int(ctrl.SourceRect.X)-padX)
		y0 := maxInt(0, int(ctrl.SourceRect.Y)-padY)
		x1 := minInt(int(shot.SourceW), int(ctrl.SourceRect.X+ctrl.SourceRect.Width)+padX)
		y1 := minInt(int(shot.SourceH), int(ctrl.SourceRect.Y+ctrl.SourceRect.Height)+padY)
		if x1-x0 < 320 && shot.SourceW >= 320 {
			cx := (x0 + x1) / 2
			x0 = maxInt(0, minInt(int(shot.SourceW)-320, cx-160))
			x1 = minInt(int(shot.SourceW), x0+320)
		}
		if y1-y0 < 220 && shot.SourceH >= 220 {
			cy := (y0 + y1) / 2
			y0 = maxInt(0, minInt(int(shot.SourceH)-220, cy-110))
			y1 = minInt(int(shot.SourceH), y0+220)
		}
		crop := appuseRegion{X: uint32(x0), Y: uint32(y0), Width: uint32(maxInt(1, x1-x0)), Height: uint32(maxInt(1, y1-y0))}
		monitorID, windowID := &shot.Monitor, shot.WindowID
		if windowID != nil {
			monitorID = nil
		}
		result := appuseCaptureWithOptions(request.Owner, windowID, monitorID, &crop, maxEdge, controlsOn)
		if result == nil {
			return failure("局部放大失败")
		}
		result["zoomedControlId"] = ctrl.ID
		return result
	}
	if request.WindowID != nil && request.MonitorID != nil {
		return failure("windowId 和 monitorId 不能同时用于截图")
	}
	windowID, monitorID, region := request.WindowID, request.MonitorID, request.Region
	if request.RegionSpace == "image" {
		snapshot := appuseCurrent(request.Owner, request.SnapshotID)
		if snapshot == nil {
			return failure("局部截图依据已失效，请先重新截图")
		}
		shot := appuseFindShot(snapshot, request.ImageID)
		if shot == nil {
			return failure("imageId 不属于最新截图")
		}
		crop, err := appuseImageRegion(shot, *region)
		if err != nil {
			return failure(err.Error())
		}
		if snapWindow := shot.WindowID; (request.WindowID != nil && snapWindow != nil && *request.WindowID != *snapWindow) ||
			(request.MonitorID != nil && (*request.MonitorID != shot.Monitor)) {
			return failure("局部截图目标与 snapshotId/imageId 不一致")
		}
		monitorID, region = &shot.Monitor, &crop
		if shot.WindowID != nil {
			windowID, monitorID = shot.WindowID, nil
		}
	} else if request.Region != nil && request.WindowID == nil && request.MonitorID == nil {
		return failure("原始像素 region 需要 windowId 或 monitorId")
	}
	result := appuseCaptureWithOptions(request.Owner, windowID, monitorID, region, maxEdge, controlsOn)
	if result == nil {
		return failure("截图失败")
	}
	return result
}

func appuseActivateOperation(request *appuseRequest, maxEdge uint32) map[string]any {
	if request.WindowID == nil {
		return failure("activate 需要 windows 返回的 windowId（不是 pid）")
	}
	id := *request.WindowID
	if _, err := appuseWindowInfo(id); err != nil {
		return failure(err.Error())
	}
	// 切窗会抢前台（真实输入），与 act 共用同一把输入租约。
	lease, err := appuseAcquireInput(request.Owner, "activate")
	if err != nil {
		return failure(err.Error())
	}
	defer lease.release()
	if err := appuseActivate(id); err != nil {
		return failure(err.Error())
	}
	if appuseElementsLast != nil {
		appuseElementsLast.Snapshot.Invalidated = "激活窗口后需要重新读取控件"
	}
	time.Sleep(150 * time.Millisecond)
	result := appuseCapture(request.Owner, &id, nil, nil, maxEdge)
	if result == nil {
		return failure("激活后截图失败")
	}
	result["activated"] = true
	return result
}

func appuseActOperation(request *appuseRequest, maxEdge uint32) map[string]any {
	if len(request.Actions) == 0 || len(request.Actions) > appuseMaxActions {
		return failure("每次需要 1 至 16 个动作；本批次尚未执行")
	}
	waitOnly := true
	for _, action := range request.Actions {
		if action.Action != "wait" {
			waitOnly = false
			break
		}
	}
	if waitOnly {
		// 等待不注入输入：不需要快照，也不能借它改变任何画面基线。
		for index := range request.Actions {
			if err := request.Actions[index].validate(nil); err != nil {
				return failure(fmt.Sprintf("actions[%d].%s", index, err.Error()))
			}
		}
		for _, action := range request.Actions {
			time.Sleep(time.Duration(action.milliseconds()) * time.Millisecond)
		}
		result := map[string]any{"status": "executed", "completedActions": len(request.Actions), "inputAttempted": false}
		if request.Feedback != "none" {
			observed := appuseCapture(request.Owner, request.WindowID, nil, nil, maxEdge)
			for key, value := range observed {
				result[key] = value
			}
		}
		return result
	}
	var snapshot *appuseSnapshot
	var shot *appuseShot
	if request.CoordinateSpace == "screen" {
		var err error
		snapshot, err = appuseScreenSnapshot(request)
		if err != nil {
			return map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false, "error": err.Error()}
		}
		shot = &snapshot.Shots[0]
	} else {
		bindInputSnapshot(request)
		if request.SnapshotID == "" {
			result := map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false,
				"required": []string{"observation"}, "errorCode": "observation_required",
				"error": "没有本会话可用的观察；本批次未执行。先 windows(observe:true) 或 screenshot 看目标画面再决策，不需要补填 snapshotId。"}
			return result
		}
		snapshot = appuseSnapshots[request.Owner]
		if snapshot == nil || snapshot.ID != request.SnapshotID {
			result := map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false,
				"required": []string{"snapshotId"}, "errorCode": "stale_snapshot_id",
				"error": "旧 snapshotId 不可用于输入；最新快照仍可用，未执行、未重新截图。请核对最新图及 completedActions，不要重放已执行动作。"}
			if snapshot != nil {
				result["snapshotId"] = snapshot.ID
				result["snapshotPreserved"] = true
				result["imageIds"] = appuseImageIDs(snapshot)
				next := map[string]any{"operation": "act", "snapshotId": snapshot.ID}
				if len(snapshot.Shots) == 1 {
					next["imageId"] = snapshot.Shots[0].ImageID
				}
				result["nextArguments"] = next
			}
			return result
		}
		if snapshot.Invalidated != "" {
			result := map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false,
				"error": fmt.Sprintf("快照在截图后被其它操作改动的画面作废：%s；附当前观察，请基于新图重新决策", snapshot.Invalidated)}
			appuseObserve(request.Owner, nil, nil, maxEdge, result)
			return result
		}
		var shotErr error
		shot, shotErr = appuseShotForActions(snapshot, request.ImageID, request.Actions)
		if shotErr != nil {
			return failure(shotErr.Error())
		}
	}
	if err := appuseResolveActions(request, shot); err != nil {
		return failure(err.Error() + "；本批次尚未执行")
	}
	for index := range request.Actions {
		if err := request.Actions[index].validate(shot); err != nil {
			return failure(fmt.Sprintf("actions[%d].%s；本批次尚未执行", index, err.Error()))
		}
	}
	// 只有真要注入输入时才拿租约；等待类动作不占桌面。
	lease, leaseErr := appuseAcquireInput(request.Owner, "act")
	if leaseErr != nil {
		result := map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false,
			"errorCode": "input_busy", "error": leaseErr.Error()}
		return result
	}
	defer lease.release()
	monitor := shot.Monitor
	windowID := shot.WindowID
	expected := appuseForegroundWindow()
	completed := 0
	attempted := false
	failureText := ""
	for index := range request.Actions {
		action := request.Actions[index]
		if action.Action != "wait" {
			if request.CoordinateSpace == "screen" {
				shot = appuseScreenShot(snapshot, action.X, action.Y)
				monitor, windowID = shot.Monitor, shot.WindowID
			}
			if err := appuseCheckTarget(snapshot, shot, action); err != nil {
				failureText = err.Error()
				break
			}
			if (action.Action == "type" || action.Action == "press") && !appuseSameForeground(expected) {
				failureText = "输入焦点已改变，已停止按键/文字输入；请根据新截图继续，不自动切回窗口"
				break
			}
		}
		if action.Action != "wait" {
			attempted = true
		}
		if err := appusePerform(shot, action); err != nil {
			failureText = err.Error()
			break
		}
		completed++
		time.Sleep(appuseActionDelay(request.Actions, index))
	}
	snapshot.Invalidated = "动作已执行，请先观察新画面，不重放输入"
	if appuseElementsLast != nil {
		appuseElementsLast.Snapshot.Invalidated = snapshot.Invalidated
	}
	if request.CoordinateSpace == "screen" && attempted {
		if previous := appuseSnapshots[request.Owner]; previous != nil {
			previous.Invalidated = snapshot.Invalidated
		}
	}
	status := "executed"
	if failureText != "" {
		if attempted {
			status = "needs_review"
		} else {
			status = "not_executed"
		}
	}
	result := map[string]any{"status": status, "completedActions": completed, "inputAttempted": attempted, "error": failureText}
	if notice := appuseExecutedNotice(request.Actions, completed, request.Notes); notice != "" {
		result["executedNotice"] = notice
	}
	if failureText != "" || request.Feedback != "none" {
		appuseObserve(request.Owner, windowID, appuseMonitorOrNil(monitor, windowID), maxEdge, result)
	}
	return result
}

func appuseRecallOperation(request *appuseRequest) map[string]any {
	if request.ImagePath == "" {
		return failure("recall 缺少 imagePath")
	}
	path, err := filepath.Abs(request.ImagePath)
	if err != nil {
		return failure(err.Error())
	}
	root, err := filepath.Abs(appuseShotFolder(request.Owner))
	if err != nil {
		return failure(err.Error())
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".webp":
	default:
		return failure("只能回看本会话的桌面截图")
	}
	if !strings.HasPrefix(path, root+string(os.PathSeparator)) {
		return failure("只能回看本会话的桌面截图")
	}
	return map[string]any{"images": []map[string]any{{"path": path}}, "historical": true}
}

// bindInputSnapshot 与 Nova 一致：没填 snapshotId 时自动绑定本会话最新的可用快照，填了就必须是最新那一个。
func bindInputSnapshot(request *appuseRequest) {
	current := appuseCurrent(request.Owner, "")
	if strings.TrimSpace(request.SnapshotID) == "" && current != nil {
		request.SnapshotID = current.ID
	}
}

func appuseCurrent(owner, id string) *appuseSnapshot {
	snapshot := appuseSnapshots[owner]
	if snapshot == nil || snapshot.Taken.IsZero() || time.Since(snapshot.Taken) > appuseSnapshotTTL {
		return nil
	}
	if id != "" && snapshot.ID != id {
		return nil
	}
	return snapshot
}

func appuseFindShot(snapshot *appuseSnapshot, imageID string) *appuseShot {
	if imageID != "" {
		for index := range snapshot.Shots {
			if snapshot.Shots[index].ImageID == imageID {
				return &snapshot.Shots[index]
			}
		}
		return nil
	}
	if len(snapshot.Shots) == 1 {
		return &snapshot.Shots[0]
	}
	return nil
}

func appuseFindControl(snapshot *appuseSnapshot, imageID string, controlID int) (*appuseShot, *appuseControlItem) {
	if snapshot == nil || controlID <= 0 {
		return nil, nil
	}
	if imageID != "" {
		shot := appuseFindShot(snapshot, imageID)
		if shot == nil {
			return nil, nil
		}
		for i := range shot.Controls {
			if shot.Controls[i].ID == controlID {
				return shot, &shot.Controls[i]
			}
		}
		return shot, nil
	}
	for si := range snapshot.Shots {
		shot := &snapshot.Shots[si]
		for ci := range shot.Controls {
			if shot.Controls[ci].ID == controlID {
				return shot, &shot.Controls[ci]
			}
		}
	}
	return nil, nil
}

func appuseShotForActions(snapshot *appuseSnapshot, imageID string, actions []appuseAction) (*appuseShot, error) {
	if shot := appuseFindShot(snapshot, imageID); shot != nil {
		return shot, nil
	}
	// 多屏快照未写 imageId 时，如果动作里带了唯一的控件编号 id，可据此锁定所在截图（不猜测）。
	var matched *appuseShot
	for _, act := range actions {
		if act.ID == nil {
			continue
		}
		s, c := appuseFindControl(snapshot, "", *act.ID)
		if s == nil || c == nil {
			return nil, fmt.Errorf("控件编号 [%d] 不在当前最新截图中；可用 imageId 请核对截图", *act.ID)
		}
		if matched != nil && matched != s {
			return nil, fmt.Errorf("同一批次的控件编号跨多张截图，请拆分并指定 imageId")
		}
		matched = s
	}
	if matched != nil {
		return matched, nil
	}
	return nil, fmt.Errorf("%s", appuseImageListError(snapshot))
}

func appuseResolveActions(request *appuseRequest, shot *appuseShot) error {
	for i := range request.Actions {
		act := &request.Actions[i]
		if act.ID != nil {
			if request.CoordinateSpace == "screen" {
				return fmt.Errorf("actions[%d]：screen 坐标模式不支持按 id 操作，请改用 x/y", i)
			}
			switch act.Action {
			case "click", "double_click", "move", "type", "scroll":
			default:
				return fmt.Errorf("actions[%d]（%s）不支持 id 字段", i, act.Action)
			}
			if act.X != nil || act.Y != nil {
				return fmt.Errorf("actions[%d] 不能同时传 id 与 x/y", i)
			}
			var found *appuseControlItem
			if shot != nil {
				for ci := range shot.Controls {
					if shot.Controls[ci].ID == *act.ID {
						found = &shot.Controls[ci]
						break
					}
				}
			}
			if found == nil {
				count := 0
				if shot != nil {
					count = len(shot.Controls)
				}
				return fmt.Errorf("actions[%d]：当前截图中没有编号 [%d]（已标注 %d 个控件），请核对截图或改用 x/y", i, *act.ID, count)
			}
			x, y := found.ImageX, found.ImageY
			act.X, act.Y = &x, &y
		}
		if act.Action == "dismiss" && act.X == nil && act.Y == nil && shot != nil && shot.OverlayOutside != nil {
			ox, oy := int(shot.OverlayOutside.X), int(shot.OverlayOutside.Y)
			act.X, act.Y = &ox, &oy
		}
	}
	return nil
}

func appuseImageIDs(snapshot *appuseSnapshot) []string {
	ids := make([]string, 0, len(snapshot.Shots))
	for _, shot := range snapshot.Shots {
		ids = append(ids, shot.ImageID)
	}
	return ids
}

func appuseImageListError(snapshot *appuseSnapshot) string {
	list := make([]string, 0, len(snapshot.Shots))
	for _, shot := range snapshot.Shots {
		region := ""
		if shot.Region != nil {
			region = fmt.Sprintf("，原始区域 x%d y%d %dx%d", shot.Region.X, shot.Region.Y, shot.Region.Width, shot.Region.Height)
		}
		list = append(list, fmt.Sprintf("%s（%dx%d%s）", shot.ImageID, shot.PixelsW, shot.PixelsH, region))
	}
	return fmt.Sprintf("imageId 缺失或不属于此截图；可用 imageId：%s。x/y 须按所选图片的像素坐标重算；沿用当前 snapshotId 并修正 imageId，无需重新截图", strings.Join(list, ", "))
}

// appuseCapture 只截可见桌面像素；windowId 用于定位所在显示器，并在能取到窗口自身像素时优先用它。
func appuseCapture(owner string, windowID, monitorID *uint32, region *appuseRegion, maxEdge uint32) map[string]any {
	return appuseCaptureWithOptions(owner, windowID, monitorID, region, maxEdge, true)
}

func appuseSelfProtectedRects() []appuseControlRect {
	ownPID := uint32(os.Getpid())
	wins, err := appuseListWindows()
	if err != nil {
		return nil
	}
	var out []appuseControlRect
	for _, w := range wins {
		if w.PID == ownPID {
			out = append(out, appuseControlRect{X: int(w.X), Y: int(w.Y), Width: int(w.W), Height: int(w.H)})
		}
	}
	return out
}

func appuseCloneRGBA(src *image.RGBA) *image.RGBA {
	if src == nil {
		return nil
	}
	dst := image.NewRGBA(image.Rect(0, 0, src.Bounds().Dx(), src.Bounds().Dy()))
	for y := 0; y < src.Bounds().Dy(); y++ {
		sOff := y * src.Stride
		dOff := y * dst.Stride
		copy(dst.Pix[dOff:dOff+dst.Rect.Dx()*4], src.Pix[sOff:sOff+src.Rect.Dx()*4])
	}
	return dst
}

func appuseFormatControlLine(id int, node appuseUIANode, cx, cy int) string {
	label := strings.TrimSpace(node.Name)
	if label == "" {
		label = strings.TrimSpace(node.AutomationID)
	}
	if len([]rune(label)) > 36 {
		r := []rune(label)
		label = string(r[:36]) + "…"
	}
	parts := []string{fmt.Sprintf("[%d] %s", id, node.Role)}
	if label != "" {
		parts = append(parts, fmt.Sprintf("%q", label))
	}
	parts = append(parts, fmt.Sprintf("@(%d,%d)", cx, cy))
	if node.Value != "" && node.Value != label {
		val := node.Value
		if len([]rune(val)) > 24 {
			r := []rune(val)
			val = string(r[:24]) + "…"
		}
		parts = append(parts, fmt.Sprintf("val=%q", val))
	}
	if node.State != "" {
		parts = append(parts, "["+node.State+"]")
	}
	return strings.Join(parts, " ")
}

func appuseCaptureWithOptions(owner string, windowID, monitorID *uint32, region *appuseRegion, maxEdge uint32, controlsOn bool) map[string]any {
	started := time.Now()
	target := monitorID
	var window *appuseWindow
	if windowID != nil {
		info, err := appuseWindowInfo(*windowID)
		if err != nil {
			return map[string]any{"observationError": err.Error()}
		}
		if info.Minimized {
			return map[string]any{"observationError": "窗口已最小化，请先通过桌面恢复窗口"}
		}
		window = &info
		target = &info.Monitor
	}
	monitors, err := appuseMonitors()
	if err != nil {
		return map[string]any{"observationError": err.Error()}
	}
	if len(monitors) == 0 || len(monitors) > 16 {
		return map[string]any{"observationError": "需要 1 至 16 个可截图显示器"}
	}
	folder := appuseShotFolder(owner)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		return map[string]any{"observationError": err.Error()}
	}
	id := appuseID()
	cursor, hasCursor := appuseCursor()
	before := appuseForegroundWindow()

	var uiaMs int64
	var encodeMs int64
	var uiaExtract appuseUIAExtract
	if controlsOn {
		uiaStarted := time.Now()
		var uiaWin uint32
		if windowID != nil {
			uiaWin = *windowID
		} else if before != nil {
			uiaWin = *before
		}
		if uiaWin != 0 {
			uiaExtract = appuseCollectFastUIA(uiaWin, appuseSelfProtectedRects())
		}
		uiaMs = time.Since(uiaStarted).Milliseconds()
	}

	images := []map[string]any{}
	shots := []appuseShot{}
	elementsAll := []string{}
	var overlayAll map[string]any
	var scrollAll *appuseScrollInfo
	if controlsOn && uiaExtract.PrimaryScroll != nil {
		scrollAll = uiaExtract.PrimaryScroll
	}
	nextControlID := 1

	// 上一帧的原始像素：用来判断这次画面是否真的变了（unchanged 不重传图）。
	previous := appusePreviousFrame(owner)
	changed := false
	for _, monitor := range monitors {
		if target != nil && *target != monitor.ID {
			continue
		}
		grab, err := appuseGrab(monitor, window)
		if err != nil {
			return map[string]any{"observationError": err.Error()}
		}
		sourceW, sourceH := uint32(grab.Bounds().Dx()), uint32(grab.Bounds().Dy())
		if sourceW == 0 || sourceH == 0 {
			return map[string]any{"observationError": "截图范围为空"}
		}
		origin := monitor
		if window != nil && sourceW == window.W && sourceH == window.H {
			origin = appuseSurface{ID: monitor.ID, PID: window.PID, X: window.X, Y: window.Y, W: window.W, H: window.H}
		}

		if prior := previous[monitor.ID]; prior != nil {
			if region == nil && appuseEqualPixels(prior.Image, grab, 0.002) {
				// 画面没变：沿用上一张图与它的路径，不重传、也不占用新的快照 ID。
				unchanged := prior.Entry()
				candidate := map[string]any{}
				for key, value := range unchanged {
					candidate[key] = value
				}
				if appuseEntryGeometryMatches(candidate, monitor, sourceW, sourceH) {
					candidate["unchanged"] = true
					shots = append(shots, appuseShot{
						ImageID: candidate["imageId"].(string), Surface: monitor, Origin: origin,
						PixelsW: uint32(candidate["width"].(int)), PixelsH: uint32(candidate["height"].(int)),
						SourceW: prior.SourceW, SourceH: prior.SourceH, Path: candidate["path"].(string),
						Controls: prior.Controls, OverlayOutside: prior.OverlayOutside,
						WindowID: windowID, Monitor: monitor.ID,
					})
					if controlsOn {
						elementsAll = append(elementsAll, prior.ElementsText...)
						if overlayAll == nil && prior.OverlayPayload != nil {
							overlayAll = prior.OverlayPayload
						}
						if scrollAll == nil && prior.ScrollHint != nil {
							scrollAll = prior.ScrollHint
						}
					}
					images = append(images, candidate)
					continue
				}
			}
		}

		changed = true
		imageID := fmt.Sprintf("monitor-%d", monitor.ID)
		delivered := grab
		crop := appuseRegion{X: 0, Y: 0, Width: sourceW, Height: sourceH}
		if region != nil {
			if err := region.validate(sourceW, sourceH); err != nil {
				return map[string]any{"observationError": err.Error()}
			}
			crop = *region
			imageID = fmt.Sprintf("%s-region-%d-%d-%d-%d", imageID, region.X, region.Y, region.Width, region.Height)
			delivered = grab.SubImage(image.Rect(int(region.X), int(region.Y), int(region.X+region.Width), int(region.Y+region.Height))).(*image.RGBA)
		}
		scaled := appuseScale(delivered, maxEdge, region != nil)
		// 绝不就地修改原始 grab 像素，保证 GuardFrames 与 unchanged 检测拿到零标注纯画面。
		if scaled == delivered {
			delivered = appuseCloneRGBA(scaled)
		} else {
			delivered = scaled
		}
		delW, delH := delivered.Bounds().Dx(), delivered.Bounds().Dy()

		shotControls := []appuseControlItem{}
		shotElementsText := []string{}
		somBoxes := []appuseSomBox{}
		var shotOutside *appusePoint
		var shotOverlayPayload map[string]any

		mapRectToDelivered := func(sr appuseControlRect) (x, y, w, h int, srcRegion appuseRegion, ok bool) {
			if origin.W == 0 || origin.H == 0 || crop.Width == 0 || crop.Height == 0 {
				return 0, 0, 0, 0, srcRegion, false
			}
			srcL := float64(int64(sr.X)-int64(origin.X)) * float64(sourceW) / float64(origin.W)
			srcT := float64(int64(sr.Y)-int64(origin.Y)) * float64(sourceH) / float64(origin.H)
			srcR := float64(int64(sr.X+sr.Width)-int64(origin.X)) * float64(sourceW) / float64(origin.W)
			srcB := float64(int64(sr.Y+sr.Height)-int64(origin.Y)) * float64(sourceH) / float64(origin.H)
			if srcR <= float64(crop.X) || srcB <= float64(crop.Y) || srcL >= float64(crop.X+crop.Width) || srcT >= float64(crop.Y+crop.Height) {
				return 0, 0, 0, 0, srcRegion, false
			}
			cL := math.Max(srcL, float64(crop.X))
			cT := math.Max(srcT, float64(crop.Y))
			cR := math.Min(srcR, float64(crop.X+crop.Width))
			cB := math.Min(srcB, float64(crop.Y+crop.Height))
			srcRegion = appuseRegion{
				X: uint32(math.Max(0, math.Floor(cL))), Y: uint32(math.Max(0, math.Floor(cT))),
				Width:  uint32(math.Max(1, math.Ceil(cR)-math.Floor(cL))),
				Height: uint32(math.Max(1, math.Ceil(cB)-math.Floor(cT))),
			}
			ix0 := int(math.Round((cL - float64(crop.X)) * float64(delW) / float64(crop.Width)))
			iy0 := int(math.Round((cT - float64(crop.Y)) * float64(delH) / float64(crop.Height)))
			ix1 := int(math.Round((cR - float64(crop.X)) * float64(delW) / float64(crop.Width)))
			iy1 := int(math.Round((cB - float64(crop.Y)) * float64(delH) / float64(crop.Height)))
			if ix1-ix0 < 3 || iy1-iy0 < 3 {
				return 0, 0, 0, 0, srcRegion, false
			}
			return ix0, iy0, ix1 - ix0, iy1 - iy0, srcRegion, true
		}

		mapPtToDelivered := func(pt appusePoint) *appusePoint {
			if origin.W == 0 || origin.H == 0 || crop.Width == 0 || crop.Height == 0 {
				return nil
			}
			sx := float64(int64(pt.X)-int64(origin.X))*float64(sourceW)/float64(origin.W) - float64(crop.X)
			sy := float64(int64(pt.Y)-int64(origin.Y))*float64(sourceH)/float64(origin.H) - float64(crop.Y)
			if sx < 0 || sy < 0 || sx >= float64(crop.Width) || sy >= float64(crop.Height) {
				return nil
			}
			ix := maxInt(0, minInt(delW-1, int(math.Round(sx*float64(delW)/float64(crop.Width)))))
			iy := maxInt(0, minInt(delH-1, int(math.Round(sy*float64(delH)/float64(crop.Height)))))
			return &appusePoint{X: int32(ix), Y: int32(iy)}
		}

		if controlsOn && len(uiaExtract.Nodes) > 0 {
			for _, node := range uiaExtract.Nodes {
				bx, by, bw, bh, srcReg, ok := mapRectToDelivered(node.Rect)
				if !ok {
					continue
				}
				cx := maxInt(0, minInt(delW-1, bx+bw/2))
				cy := maxInt(0, minInt(delH-1, by+bh/2))
				cid := nextControlID
				nextControlID++
				shotControls = append(shotControls, appuseControlItem{
					ID: cid, Role: node.Role, Name: node.Name, Value: node.Value, State: node.State,
					ImageX: cx, ImageY: cy,
					ImageRect:  appuseControlRect{X: bx, Y: by, Width: bw, Height: bh},
					SourceRect: srcReg, ScreenRect: node.Rect,
				})
				somBoxes = append(somBoxes, appuseSomBox{ID: cid, X: bx, Y: by, W: bw, H: bh})
				if len(shotElementsText) < 60 {
					shotElementsText = append(shotElementsText, appuseFormatControlLine(cid, node, cx, cy))
				}
			}
		}
		if controlsOn && uiaExtract.Overlay != nil {
			ov := uiaExtract.Overlay
			if bx, by, bw, bh, _, ok := mapRectToDelivered(ov.ScreenRect); ok {
				shotOverlayPayload = map[string]any{
					"kind": ov.Kind, "role": ov.Role, "name": ov.Name,
					"rect": map[string]int{"x": bx, "y": by, "width": bw, "height": bh},
				}
				if ov.OutsidePoint != nil {
					if opt := mapPtToDelivered(*ov.OutsidePoint); opt != nil {
						shotOutside = opt
						shotOverlayPayload["outsidePoint"] = map[string]any{"x": opt.X, "y": opt.Y, "imageId": imageID}
					}
				}
			}
		}

		// 先保留无辅助框、无指针标记的纯净交付图（若本次将绘制 SoM 框或指针）。
		var cleanData string
		if len(somBoxes) > 0 || (hasCursor && before != nil) {
			if _, cleanB64, cleanErr := appuseEncodeJPEG(delivered); cleanErr == nil {
				cleanData = cleanB64
			}
		}

		// 先把离线 [1][2] SoM 标注画在模型副本上，再画系统剑形落点。
		if len(somBoxes) > 0 {
			appuseDrawSomRaw(delivered, somBoxes)
		}
		var marked *appusePoint
		if hasCursor && before != nil {
			marked = appuseMarkCursor(delivered, origin, appusePoint{X: int32(sourceW), Y: int32(sourceH)}, crop, cursor)
		}

		encStarted := time.Now()
		path := filepath.Join(folder, fmt.Sprintf("%s-%s.jpg", id, imageID))
		rawJPEG, data, err := appuseEncodeJPEG(delivered)
		if err != nil {
			return map[string]any{"observationError": err.Error()}
		}
		if err := os.WriteFile(path, rawJPEG, 0o600); err != nil {
			return map[string]any{"observationError": err.Error()}
		}
		encodeMs += time.Since(encStarted).Milliseconds()

		entry := map[string]any{
			"imageId": imageID, "width": delW, "height": delH,
			"pixelWidth": delW, "pixelHeight": delH,
			"snapshotId": id, "capturedAt": time.Now().UTC().Format(time.RFC3339),
			"stability":     map[string]any{"status": "not_checked", "samples": 1},
			"originalWidth": sourceW, "originalHeight": sourceH,
			"desktopBounds": map[string]any{"x": monitor.X, "y": monitor.Y, "width": monitor.W, "height": monitor.H},
			"monitorId":     monitor.ID, "mime": "image/jpeg", "path": path, "data": data,
		}
		if cleanData != "" {
			entry["cleanData"] = cleanData
		}
		appuseRememberFrame(owner, monitor.ID, grab, entry, shotControls, shotOutside, shotElementsText, shotOverlayPayload, scrollAll)
		if region != nil {
			entry["region"] = region
		}
		if marked != nil {
			entry["cursor"] = map[string]any{"x": marked.X, "y": marked.Y, "marker": "sword-tip", "source": "system-pointer"}
		}
		shots = append(shots, appuseShot{
			ImageID: imageID, Surface: monitor, Origin: origin, PixelsW: uint32(delW), PixelsH: uint32(delH),
			SourceW: sourceW, SourceH: sourceH, Region: region, Path: path,
			Cursor: marked, Controls: shotControls, OverlayOutside: shotOutside,
			WindowID: windowID, Monitor: monitor.ID,
		})
		elementsAll = append(elementsAll, shotElementsText...)
		if overlayAll == nil && shotOverlayPayload != nil {
			overlayAll = shotOverlayPayload
		}
		images = append(images, entry)
	}
	if len(images) == 0 {
		return map[string]any{"observationError": "显示器不存在，请重新截图"}
	}
	foreground := map[string]any(nil)
	if before != nil {
		foreground = map[string]any{"windowId": *before}
	}
	appuseSnapshots[owner] = &appuseSnapshot{
		ID: id, Owner: owner, Taken: time.Now(), Shots: shots,
		MaxEdge: maxEdge,
	}
	out := map[string]any{
		"snapshotId": id, "historical": false, "windowId": windowID, "images": images,
		"coordinateSpace": "image-pixels", "expiresInMs": int64(appuseSnapshotTTL / time.Millisecond),
		"foreground": foreground, "maxEdge": maxEdge, "changed": changed,
		"timingsMs": map[string]any{"capture": time.Since(started).Milliseconds(), "uia": uiaMs, "encode": encodeMs},
	}
	if len(elementsAll) > 0 {
		out["elements"] = elementsAll
	}
	if overlayAll != nil {
		out["overlay"] = overlayAll
	}
	if scrollAll != nil {
		out["scrollHint"] = scrollAll
	}
	return out
}

func appuseObserve(owner string, windowID, monitorID *uint32, maxEdge uint32, out map[string]any) {
	observed := appuseCapture(owner, windowID, monitorID, nil, maxEdge)
	if observed == nil {
		out["observationError"] = "截图失败"
		return
	}
	for key, value := range observed {
		if key == "observationError" {
			continue
		}
		out[key] = value
	}
}

func appuseMonitorOrNil(monitor uint32, windowID *uint32) *uint32 {
	if windowID != nil {
		return nil
	}
	return &monitor
}

func appuseScale(src *image.RGBA, maxEdge uint32, forced bool) *image.RGBA {
	width, height := src.Bounds().Dx(), src.Bounds().Dy()
	long := float64(width)
	if height > width {
		long = float64(height)
	}
	scale := appuseVisionScale(width, height)
	if maxEdge > 0 && (forced || long > float64(maxEdge)) {
		edgeScale := float64(maxEdge) / long
		if edgeScale < scale {
			scale = edgeScale
		}
	}
	// 模型看到的图不会超过 vision_scale 给出的像素；再放大反而让坐标对不上。
	if scale > 1 {
		scale = 1
	}
	if scale >= 0.999 {
		return src
	}
	dstW := uint32(math.Max(1, math.Round(float64(width)*scale)))
	dstH := uint32(math.Max(1, math.Round(float64(height)*scale)))
	dst := image.NewRGBA(image.Rect(0, 0, int(dstW), int(dstH)))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	return dst
}

// appuseImage 只是像素视图：同一块 RGBA 缓冲交给指针混合用，避免再复制整张图。
type appuseImage struct {
	Pix  []uint8
	W, H int
}

// appuseMarkCursor 用同一套映射把系统指针画回图上：剑尖即热点，与系统指针同款的剑；
// 反馈图里的光晕刻意很淡，压住的内容仍然可读，不干扰模型对目标的判断。
func appuseMarkCursor(img *image.RGBA, surface appuseSurface, source appusePoint, crop appuseRegion, position appusePoint) *appusePoint {
	if surface.W == 0 || surface.H == 0 || source.X == 0 || source.Y == 0 {
		return nil
	}
	x := (int64(position.X)-int64(surface.X))*int64(source.X) - int64(crop.X)*int64(surface.W)
	y := (int64(position.Y)-int64(surface.Y))*int64(source.Y) - int64(crop.Y)*int64(surface.H)
	width := int64(crop.Width) * int64(surface.W)
	height := int64(crop.Height) * int64(surface.H)
	if x < 0 || y < 0 || x >= width || y >= height || width == 0 || height == 0 {
		return nil
	}
	edgeW, edgeH := int64(img.Bounds().Dx()), int64(img.Bounds().Dy())
	// 映射到桌面像素中心（与 appusePointOf 同式），所以图内 (x,y) 就标在 (x,y)。
	toImage := func(v, pixel, size, edge int64) int {
		value := (2*v + pixel) * edge / (2 * size)
		if value > edge-1 {
			value = edge - 1
		}
		return int(value)
	}
	imageX := toImage(x, int64(source.X), width, edgeW)
	imageY := toImage(y, int64(source.Y), height, edgeH)
	const size = 32
	pixels := appusePointerPixels(size, appuseMarkerGlow)
	appuseBlendPointer(&appuseImage{Pix: img.Pix, W: int(edgeW), H: int(edgeH)}, size, int(math.Floor(appusePointerTip)), pixels, imageX, imageY)
	return &appusePoint{X: int32(imageX), Y: int32(imageY)}
}

func appuseShotFolder(owner string) string {
	sum := 0
	for _, char := range owner {
		sum = (sum*31 + int(char)) & 0x7fffffff
	}
	return filepath.Join(os.TempDir(), "vega-appuse", fmt.Sprintf("%08x", sum))
}

// appusePoint 把图内像素映射成桌面像素，瞄准像素中心（少一位会整体偏左上）。
func appusePointOf(shot *appuseShot, x, y *int) (appusePoint, error) {
	if x == nil || y == nil {
		return appusePoint{}, fmt.Errorf("缺少 x/y 坐标")
	}
	if shot.Screen {
		point := appusePoint{X: int32(*x), Y: int32(*y)}
		if int(point.X) != *x || int(point.Y) != *y {
			return appusePoint{}, fmt.Errorf("坐标超出物理像素范围")
		}
		return point, nil
	}
	if *x < 0 || *y < 0 || uint32(*x) >= shot.PixelsW || uint32(*y) >= shot.PixelsH || shot.SourceW == 0 || shot.SourceH == 0 {
		return appusePoint{}, fmt.Errorf("坐标超出原始截图范围")
	}
	crop := appuseRegion{X: 0, Y: 0, Width: shot.SourceW, Height: shot.SourceH}
	if shot.Region != nil {
		crop = *shot.Region
	}
	origin := shot.Origin
	if origin.W == 0 || origin.H == 0 {
		origin = shot.Surface
	}
	pw, ph := int64(shot.PixelsW), int64(shot.PixelsH)
	px := int64(origin.X) + (2*int64(crop.X)*pw+int64(2*(*x)+1)*int64(crop.Width))*int64(origin.W)/(2*pw*int64(shot.SourceW))
	py := int64(origin.Y) + (2*int64(crop.Y)*ph+int64(2*(*y)+1)*int64(crop.Height))*int64(origin.H)/(2*ph*int64(shot.SourceH))
	return appusePoint{X: int32(px), Y: int32(py)}, nil
}

func appuseImageRegion(shot *appuseShot, region appuseRegion) (appuseRegion, error) {
	if err := region.validate(shot.PixelsW, shot.PixelsH); err != nil {
		return appuseRegion{}, err
	}
	toSource := func(x, y float64) (float64, float64) {
		crop := appuseRegion{X: 0, Y: 0, Width: shot.SourceW, Height: shot.SourceH}
		if shot.Region != nil {
			crop = *shot.Region
		}
		return float64(crop.X) + x*float64(crop.Width)/float64(shot.PixelsW),
			float64(crop.Y) + y*float64(crop.Height)/float64(shot.PixelsH)
	}
	left, top := toSource(float64(region.X), float64(region.Y))
	right, bottom := toSource(float64(region.X+region.Width), float64(region.Y+region.Height))
	crop := appuseRegion{X: uint32(math.Floor(left)), Y: uint32(math.Floor(top)),
		Width: uint32(math.Ceil(right)) - uint32(math.Floor(left)), Height: uint32(math.Ceil(bottom)) - uint32(math.Floor(top))}
	if err := crop.validate(shot.SourceW, shot.SourceH); err != nil {
		return appuseRegion{}, err
	}
	return crop, nil
}

func appuseCheckTarget(snapshot *appuseSnapshot, shot *appuseShot, action appuseAction) error {
	if time.Since(snapshot.Taken) > appuseSnapshotTTL {
		return fmt.Errorf("截图已过期，请重新截图")
	}
	current, err := appuseMonitors()
	if err != nil {
		return err
	}
	if shot.Screen {
		if err := appuseScreenCheckTarget(action); err != nil {
			return err
		}
		for _, expected := range snapshot.Shots {
			matched := false
			for _, monitor := range current {
				if monitor == expected.Surface {
					matched = true
					break
				}
			}
			if !matched {
				return fmt.Errorf("显示器布局已改变，请重新观察")
			}
		}
	}
	for _, monitor := range current {
		if monitor.ID == shot.Monitor {
			if monitor.X != shot.Surface.X || monitor.Y != shot.Surface.Y || monitor.W != shot.Surface.W || monitor.H != shot.Surface.H {
				return fmt.Errorf("显示器布局已改变，请重新截图")
			}
			return appuseGuardPixels(snapshot, shot, action)
		}
	}
	return fmt.Errorf("显示器布局已改变，请重新截图")
}

// appuseGuardPixels 是视觉守卫：向下/双击/拖拽之前，比较目标周围那一小块画面
// 是否还是截图里的那个样子。变了（弹窗、翻页、滚动、别的窗口盖住）就不执行，
// 让人和模型先看新图——绝不直接点一个可能已经不是它以为是的东西的位置。
func appuseGuardPixels(snapshot *appuseSnapshot, shot *appuseShot, action appuseAction) error {
	switch action.Action {
	case "click", "double_click", "drag", "dismiss":
	default:
		return nil
	}
	if action.X == nil || action.Y == nil {
		return nil
	}
	baseline := snapshot.GuardFrames[shot.Monitor]
	if baseline == nil {
		if shot.Screen {
			return fmt.Errorf("控件观察缺少视觉守卫基线；未输入，请重新观察")
		}
		frame := appusePreviousFrame(snapshot.Owner)[shot.Monitor]
		if !appuseFrameFresh(frame, appuseSnapshotTTL) || frame.Image == nil {
			return nil
		}
		baseline = frame.Image
	}
	point, err := appusePointOf(shot, action.X, action.Y)
	if err != nil {
		return err
	}
	grab, err := appuseCaptureMonitor(shot.Surface)
	if err != nil {
		// 抓不到当前画面就不能证明目标还在，直接不执行。
		return fmt.Errorf("无法核对当前画面（%v）：本批未执行，请重新截图后再决策", err)
	}
	// 目标周围一圈：比一个点更能容下光标/悬停反馈，又不至于把整屏动画算进来。
	const radius = 48
	left := int32(point.X) - int32(shot.Surface.X) - radius
	top := int32(point.Y) - int32(shot.Surface.Y) - radius
	region := appuseRegion{X: uint32(maxInt32(left, 0)), Y: uint32(maxInt32(top, 0)), Width: radius * 2, Height: radius * 2}
	if uint32(left) != region.X || uint32(top) != region.Y {
		return nil // 贴着屏幕边缘就不做像素比对，避免误报
	}
	if !appuseRegionUnchanged(baseline, grab, region, 0.06) {
		return fmt.Errorf("目标周围画面在截图后已经变化（可能弹窗/翻页/被遮挡）；本批未执行，请基于新图重新定位，不要重放")
	}
	return nil
}

func maxInt32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

// appusePressCombo 按一组组合键（不涉坐标，不需要快照）。
func appusePressCombo(raw string) error {
	keys, err := appuseKeys(raw)
	if err != nil {
		return err
	}
	if err := appuseKeyPress(keys); err != nil {
		return err
	}
	return appuseKeyRelease(keys)
}

func appuseGlideAndMove(target appusePoint, glide bool) error {
	if glide {
		if from, ok := appuseCursor(); ok {
			if err := appuseGlide(from, target); err != nil {
				return err
			}
		}
	}
	if err := appuseMovePointer(target.X, target.Y, false); err != nil {
		return err
	}
	if actual, ok := appuseCursor(); ok {
		if absInt32(actual.X-target.X) > 2 || absInt32(actual.Y-target.Y) > 2 {
			return fmt.Errorf("系统鼠标落点与请求不符（请求 %d,%d，实际 %d,%d），未按下按钮；请根据新图继续", target.X, target.Y, actual.X, actual.Y)
		}
	}
	return nil
}

func appusePerform(shot *appuseShot, action appuseAction) error {
	glide := action.Glide == nil || (*action.Glide && action.Action != "scroll")
	switch action.Action {
	case "wait":
		time.Sleep(time.Duration(action.milliseconds()) * time.Millisecond)
		return nil
	case "type":
		if action.Text == nil {
			return fmt.Errorf("type 缺少 text")
		}
		if action.X != nil && action.Y != nil {
			target, err := appusePointOf(shot, action.X, action.Y)
			if err != nil {
				return err
			}
			if err := appuseGlideAndMove(target, glide); err != nil {
				return err
			}
			if err := appuseClick("left"); err != nil {
				return err
			}
			time.Sleep(60 * time.Millisecond)
		}
		if action.Clear != nil && *action.Clear {
			if err := appusePressCombo("ctrl+a"); err != nil {
				return err
			}
			time.Sleep(25 * time.Millisecond)
			if err := appusePressCombo("backspace"); err != nil {
				return err
			}
			time.Sleep(35 * time.Millisecond)
		}
		// Windows 走整段粘贴：逐键输入会被中文输入法改写/吞掉。
		if err := appusePasteText(*action.Text); err != nil {
			return err
		}
		if action.Submit != nil && *action.Submit {
			time.Sleep(50 * time.Millisecond)
			return appusePressCombo("enter")
		}
		return nil
	case "press":
		if action.Key == nil {
			return fmt.Errorf("press 缺少 key")
		}
		return appusePressCombo(*action.Key)
	case "dismiss":
		if action.X == nil || action.Y == nil {
			return appusePressCombo("escape")
		}
		target, err := appusePointOf(shot, action.X, action.Y)
		if err != nil {
			return err
		}
		if err := appuseGlideAndMove(target, glide); err != nil {
			return err
		}
		return appuseClick("left")
	}
	target, err := appusePointOf(shot, action.X, action.Y)
	if err != nil {
		return err
	}
	button := "left"
	if action.Button != nil {
		button = *action.Button
	}
	if err := appuseGlideAndMove(target, glide); err != nil {
		return err
	}
	switch action.Action {
	case "move":
		return nil
	case "click", "double_click":
		clicks := 1
		if action.Action == "double_click" {
			clicks = 2
		}
		for index := 0; index < clicks; index++ {
			if err := appuseClick(button); err != nil {
				return err
			}
			if index+1 < clicks {
				time.Sleep(70 * time.Millisecond)
			}
		}
		return nil
	case "drag":
		end, err := appusePointOf(shot, action.ToX, action.ToY)
		if err != nil {
			return err
		}
		if err := appuseMouseButton(button, true); err != nil {
			return err
		}
		moved := error(nil)
		if action.Glide != nil && *action.Glide {
			moved = appuseGlide(target, end)
		} else {
			for step := 1; step <= 12; step++ {
				x := int32(int64(target.X) + int64(end.X-target.X)*int64(step)/12)
				y := int32(int64(target.Y) + int64(end.Y-target.Y)*int64(step)/12)
				if err := appuseMovePointer(x, y, true); err != nil {
					moved = err
					break
				}
				time.Sleep(16 * time.Millisecond)
			}
		}
		released := appuseMouseButton(button, false)
		if moved != nil {
			return moved
		}
		return released
	case "scroll":
		if action.Delta == nil {
			return fmt.Errorf("scroll 缺少 delta")
		}
		axis := "vertical"
		if action.Axis != nil {
			axis = *action.Axis
		}
		delta := *action.Delta
		step := 1
		if delta < 0 {
			step = -1
		}
		for index := 0; index < absInt(delta); index++ {
			if index > 0 {
				time.Sleep(8 * time.Millisecond)
			}
			if err := appuseWheel(axis, int32(step)); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("未知动作 %s", action.Action)
}

func (a appuseAction) milliseconds() int {
	if a.MS == nil {
		return 250
	}
	return *a.MS
}

func (a appuseAction) validate(shot *appuseShot) error {
	switch a.Action {
	case "click", "double_click", "move", "drag", "type", "press", "scroll", "dismiss", "wait":
	default:
		return fmt.Errorf("未知动作；可用：click/double_click/move/drag/type/press/scroll/dismiss/wait")
	}
	if (a.X == nil) != (a.Y == nil) {
		return fmt.Errorf("x 与 y 必须同时提供")
	}
	if a.Button != nil && *a.Button != "left" && *a.Button != "right" && *a.Button != "middle" {
		return fmt.Errorf("button 仅允许 left/right/middle")
	}
	if a.Axis != nil && *a.Axis != "vertical" && *a.Axis != "horizontal" {
		return fmt.Errorf("axis 仅允许 vertical/horizontal")
	}
	if a.Glide != nil {
		switch a.Action {
		case "click", "double_click", "move", "drag", "type", "dismiss":
		default:
			return fmt.Errorf("glide 仅用于 click/double_click/move/drag/type/dismiss")
		}
	}
	if (a.Clear != nil || a.Submit != nil) && a.Action != "type" {
		return fmt.Errorf("clear/submit 仅用于 type")
	}
	if a.MS != nil && (*a.MS < 0 || *a.MS > 10000) {
		return fmt.Errorf("ms=%d，允许范围为 0–10000", *a.MS)
	}
	switch a.Action {
	case "click", "double_click", "move", "drag", "scroll":
		if shot == nil {
			return fmt.Errorf("坐标动作需要截图")
		}
		if _, err := appusePointOf(shot, a.X, a.Y); err != nil {
			return err
		}
	case "type", "dismiss":
		if a.X != nil && a.Y != nil {
			if shot == nil {
				return fmt.Errorf("坐标动作需要截图")
			}
			if _, err := appusePointOf(shot, a.X, a.Y); err != nil {
				return err
			}
		}
	}
	if a.Action == "drag" {
		if shot == nil {
			return fmt.Errorf("坐标动作需要截图")
		}
		if _, err := appusePointOf(shot, a.ToX, a.ToY); err != nil {
			return err
		}
	}
	if a.Action == "press" {
		if a.Key == nil {
			return fmt.Errorf("press 缺少 key")
		}
		if _, err := appuseKeys(*a.Key); err != nil {
			return err
		}
	}
	if a.Action == "type" {
		if a.Text == nil {
			return fmt.Errorf("type 缺少 text")
		}
		if len([]rune(*a.Text)) > 10000 || strings.ContainsRune(*a.Text, 0) {
			return fmt.Errorf("文本过长或含 NUL")
		}
	}
	if a.Action == "scroll" {
		if a.Delta == nil {
			return fmt.Errorf("scroll 缺少 delta")
		}
		if *a.Delta < -100 || *a.Delta > 100 {
			return fmt.Errorf("滚动刻度必须在 -100 至 100 之间")
		}
	}
	return nil
}

// appuseDelay 给出与 Nova 一致的节拍：显式等待与紧随其后的等待不再额外等待，输入后留反应时间。
func appuseActionDelay(actions []appuseAction, index int) time.Duration {
	redundant := actions[index].Action == "wait" || actions[index].Action == "move" ||
		(index+1 < len(actions) && actions[index+1].Action == "wait")
	reacts := index+1 == len(actions) || actions[index].Action == "click" || actions[index].Action == "double_click" ||
		actions[index].Action == "type" || actions[index].Action == "scroll" || actions[index].Action == "dismiss"
	switch {
	case redundant:
		return 0
	case reacts:
		return 300 * time.Millisecond
	default:
		return 80 * time.Millisecond
	}
}

// appuseExecutedNotice 只概括已完成的输入；notes 是调用方的意图，不是业务成功证明。
func appuseExecutedNotice(actions []appuseAction, completed int, notes string) string {
	done := []string{}
	for index := 0; index < completed && index < len(actions); index++ {
		action := actions[index]
		switch action.Action {
		case "click", "double_click", "move":
			if action.X != nil && action.Y != nil {
				done = append(done, fmt.Sprintf("%s(%d,%d)", action.Action, *action.X, *action.Y))
			}
		case "drag":
			if action.X != nil && action.Y != nil && action.ToX != nil && action.ToY != nil {
				done = append(done, fmt.Sprintf("drag(%d,%d→%d,%d)", *action.X, *action.Y, *action.ToX, *action.ToY))
			}
		case "type":
			if action.Text != nil {
				done = append(done, fmt.Sprintf("type(%d 字符)", len([]rune(*action.Text))))
			}
		case "press":
			if action.Key != nil {
				done = append(done, fmt.Sprintf("press(%s)", *action.Key))
			}
		case "scroll":
			if action.Delta != nil {
				axis := "vertical"
				if action.Axis != nil {
					axis = *action.Axis
				}
				done = append(done, fmt.Sprintf("scroll(%s,%d)", axis, *action.Delta))
			}
		case "dismiss":
			if action.X != nil && action.Y != nil {
				done = append(done, fmt.Sprintf("dismiss(%d,%d)", *action.X, *action.Y))
			} else {
				done = append(done, "dismiss(Esc)")
			}
		}
	}
	if len(done) == 0 {
		return ""
	}
	notice := "本批已执行：" + strings.Join(done, "、") + "。"
	if intent := strings.TrimSpace(notes); intent != "" {
		notice += "你为这次操作写的意图：" + intent
	}
	return notice
}

// appuseGlide Flash-Hogan 非对称最小急动度拟人位移：长距离先快后缓，末尾微过冲回正（t=1 精确落点）。
func appuseGlide(from, to appusePoint) error {
	distance := math.Hypot(float64(to.X-from.X), float64(to.Y-from.Y))
	if distance < 2 {
		return appuseMovePointer(to.X, to.Y, true)
	}
	milliseconds := math.Min(380, 90+56*math.Log2(1+distance/22))
	bend := (rand.Float64() - 0.5) * 0.22
	overshoot := 0.0
	if distance > 140 {
		// 仅长距离才附加约 2%-4% 的自然过冲再平滑回稳。
		overshoot = 0.02 + rand.Float64()*0.02
	}
	started := time.Now()
	for {
		t := math.Min(1, float64(time.Since(started).Milliseconds())/math.Max(1, milliseconds))
		point := appuseGlideAt(from, to, bend, overshoot, t)
		if err := appuseMovePointer(point.X, point.Y, true); err != nil {
			return err
		}
		if t >= 1 {
			return nil
		}
		time.Sleep(8 * time.Millisecond)
	}
}

func appuseGlideAt(from, to appusePoint, bend, overshoot, t float64) appusePoint {
	if t <= 0 {
		return from
	}
	if t >= 1 {
		return to
	}
	// 非对称时间扭曲：前半程加快接近、后半程收敛精调（u = 1 - (1-t)^1.22）。
	u := 1 - math.Pow(1-t, 1.22)
	s := u * u * u * (10 - 15*u + 6*u*u)
	if overshoot != 0 && u > 0.65 {
		// 单周期衰减过冲在 u=1 时严格归 0，保证终点 zero-error。
		phase := (u - 0.65) / 0.35
		s += overshoot * math.Sin(phase*math.Pi)
	}
	fx, fy := float64(from.X), float64(from.Y)
	dx, dy := float64(to.X-from.X), float64(to.Y-from.Y)
	cx, cy := fx+dx/2-dy*bend, fy+dy/2+dx*bend
	inv := 1 - s
	return appusePoint{
		X: int32(math.Round(inv*inv*fx + 2*inv*s*cx + s*s*float64(to.X))),
		Y: int32(math.Round(inv*inv*fy + 2*inv*s*cy + s*s*float64(to.Y))),
	}
}

func appuseKeys(raw string) ([]appuseKey, error) {
	parts := strings.Split(raw, "+")
	if len(parts) > 4 {
		return nil, fmt.Errorf("组合键最多 4 键")
	}
	keys := make([]appuseKey, 0, len(parts))
	for _, part := range parts {
		key, err := appuseKeyOf(strings.ToLower(strings.TrimSpace(part)))
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, nil
}

func appuseID() string {
	buffer := make([]byte, 16)
	if _, err := crand.Read(buffer); err != nil {
		return fmt.Sprintf("snap-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func appuseSameForeground(expected *uint32) bool {
	current := appuseForegroundWindow()
	if expected == nil || current == nil {
		return true
	}
	return *expected == *current
}

func absInt32(value int32) int32 {
	if value < 0 {
		return -value
	}
	return value
}

func base64Encode(data []byte) string { return base64.StdEncoding.EncodeToString(data) }

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
