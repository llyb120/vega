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
	"image/png"
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
	X      *int    `json:"x"`
	Y      *int    `json:"y"`
	ToX    *int    `json:"toX"`
	ToY    *int    `json:"toY"`
	Button *string `json:"button"`
	Text   *string `json:"text"`
	Key    *string `json:"key"`
	Delta  *int    `json:"delta"`
	Axis   *string `json:"axis"`
	MS     *int    `json:"ms"`
	Glide  *bool   `json:"glide"`
}

type appuseRequest struct {
	Operation   string         `json:"operation"`
	Owner       string         `json:"owner"`
	WindowID    *uint32        `json:"windowId"`
	MonitorID   *uint32        `json:"monitorId"`
	Region      *appuseRegion  `json:"region"`
	RegionSpace string         `json:"regionSpace"`
	SnapshotID  string         `json:"snapshotId"`
	ImageID     string         `json:"imageId"`
	Feedback    string         `json:"feedback"`
	Actions     []appuseAction `json:"actions"`
	MaxEdge     uint32         `json:"maxEdge"`
	ImagePath   string         `json:"imagePath"`
	Notes       string         `json:"notes"`
	Query       string         `json:"query"`
	Observe     *bool          `json:"observe"`
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
	ImageID  string
	Surface  appuseSurface
	PixelsW  uint32
	PixelsH  uint32
	SourceW  uint32
	SourceH  uint32
	Region   *appuseRegion
	Path     string
	Data     []byte
	Cursor   *appusePoint
	WindowID *uint32
	Monitor  uint32
}

type appuseSnapshot struct {
	ID          string
	Owner       string
	Taken       time.Time
	Shots       []appuseShot
	Foreground  *appusePoint
	MaxEdge     uint32
	Invalidated string
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
	if request.RegionSpace != "" && request.RegionSpace != "source" && request.RegionSpace != "image" {
		return failure("regionSpace 必须是 source 或 image")
	}
	if request.RegionSpace == "image" && request.Region == nil {
		return failure("regionSpace=image 需要 region 及最新 snapshotId/imageId")
	}
	if request.MonitorID != nil && request.Operation != "screenshot" {
		return failure("monitorId 仅用于 screenshot；act 由 imageId 选择屏幕")
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
	case "screenshot":
		return appuseScreenshotOperation(request, maxEdge)
	case "activate":
		return appuseActivateOperation(request, maxEdge)
	case "act":
		return appuseActOperation(request, maxEdge)
	case "recall":
		return appuseRecallOperation(request)
	default:
		return failure("未知 appuse 操作；可用：windows/screenshot/act/activate/recall")
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
	emptyQuery := strings.TrimSpace(request.Query) == ""
	if observe && (target != nil || emptyQuery) {
		if observed := appuseCapture(request.Owner, target, nil, nil, maxEdge); observed != nil {
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
	result := appuseCapture(request.Owner, windowID, monitorID, region, maxEdge)
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
	bindInputSnapshot(request)
	if request.SnapshotID == "" {
		result := map[string]any{"status": "not_executed", "completedActions": 0, "inputAttempted": false,
			"required": []string{"observation"}, "errorCode": "observation_required",
			"error": "没有本会话可用的观察；本批次未执行。先 windows(observe:true) 或 screenshot 看目标画面再决策，不需要补填 snapshotId。"}
		return result
	}
	snapshot := appuseSnapshots[request.Owner]
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
	shot := appuseFindShot(snapshot, request.ImageID)
	if shot == nil {
		return failure(appuseImageListError(snapshot))
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

// appuseCapture 只截可见桌面像素；windowId 用于定位所在显示器，并在能取到窗口自身像素时优先用它
// （与 Nova 一致：普通模式指定 windowId 就调窗口自身像素，被遮挡也不会截错内容）。
func appuseCapture(owner string, windowID, monitorID *uint32, region *appuseRegion, maxEdge uint32) map[string]any {
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
	images := []map[string]any{}
	shots := []appuseShot{}
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
						ImageID: candidate["imageId"].(string), Surface: monitor,
						PixelsW: uint32(candidate["width"].(int)), PixelsH: uint32(candidate["height"].(int)),
						SourceW: prior.SourceW, SourceH: prior.SourceH, Path: candidate["path"].(string),
						WindowID: windowID, Monitor: monitor.ID,
					})
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
		delivered = appuseScale(delivered, maxEdge, region != nil)
		var marked *appusePoint
		if hasCursor && before != nil {
			marked = appuseMarkCursor(delivered, monitor, appusePoint{X: int32(sourceW), Y: int32(sourceH)}, crop, cursor)
		}
		path := filepath.Join(folder, fmt.Sprintf("%s-%s.png", id, imageID))
		data, err := appuseEncodePNG(path, delivered)
		if err != nil {
			return map[string]any{"observationError": err.Error()}
		}
		entry := map[string]any{
			"imageId": imageID, "width": delivered.Bounds().Dx(), "height": delivered.Bounds().Dy(),
			"pixelWidth": delivered.Bounds().Dx(), "pixelHeight": delivered.Bounds().Dy(),
			"snapshotId": id, "capturedAt": time.Now().UTC().Format(time.RFC3339),
			"stability":     map[string]any{"status": "not_checked", "samples": 1},
			"originalWidth": sourceW, "originalHeight": sourceH,
			"desktopBounds": map[string]any{"x": monitor.X, "y": monitor.Y, "width": monitor.W, "height": monitor.H},
			"monitorId":     monitor.ID, "mime": "image/png", "path": path, "data": data,
		}
		appuseRememberFrame(owner, monitor.ID, grab, entry)
		if region != nil {
			entry["region"] = region
		}
		if marked != nil {
			entry["cursor"] = map[string]any{"x": marked.X, "y": marked.Y, "marker": "sword-tip", "source": "system-pointer"}
		}
		shots = append(shots, appuseShot{
			ImageID: imageID, Surface: monitor, PixelsW: uint32(delivered.Bounds().Dx()), PixelsH: uint32(delivered.Bounds().Dy()),
			SourceW: sourceW, SourceH: sourceH, Region: region, Path: path,
			Cursor: marked, WindowID: windowID, Monitor: monitor.ID,
		})
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
	return map[string]any{
		"snapshotId": id, "historical": false, "windowId": windowID, "images": images,
		"coordinateSpace": "image-pixels", "expiresInMs": int64(appuseSnapshotTTL / time.Millisecond),
		"foreground": foreground, "maxEdge": maxEdge, "changed": changed,
		"timingsMs": map[string]any{"capture": time.Since(started).Milliseconds()},
	}
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
	scale := 1.0
	if maxEdge > 0 && (forced || long > float64(maxEdge)) {
		scale = float64(maxEdge) / long
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
	appuseBlendPointer(&appuseImage{Pix: img.Pix, W: int(edgeW), H: int(edgeH)}, size, int(appusePointerTip), pixels, imageX, imageY)
	return &appusePoint{X: int32(imageX), Y: int32(imageY)}
}

func appuseEncodePNG(path string, img *image.RGBA) (string, error) {
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0o600); err != nil {
		return "", err
	}
	return base64Encode(buffer.Bytes()), nil
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
	if *x < 0 || *y < 0 || uint32(*x) >= shot.PixelsW || uint32(*y) >= shot.PixelsH || shot.SourceW == 0 || shot.SourceH == 0 {
		return appusePoint{}, fmt.Errorf("坐标超出原始截图范围")
	}
	crop := appuseRegion{X: 0, Y: 0, Width: shot.SourceW, Height: shot.SourceH}
	if shot.Region != nil {
		crop = *shot.Region
	}
	pw, ph := int64(shot.PixelsW), int64(shot.PixelsH)
	px := int64(shot.Surface.X) + (2*int64(crop.X)*pw+int64(2*(*x)+1)*int64(crop.Width))*int64(shot.Surface.W)/(2*pw*int64(shot.SourceW))
	py := int64(shot.Surface.Y) + (2*int64(crop.Y)*ph+int64(2*(*y)+1)*int64(crop.Height))*int64(shot.Surface.H)/(2*ph*int64(shot.SourceH))
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
	case "click", "double_click", "drag":
	default:
		return nil
	}
	if action.X == nil || action.Y == nil {
		return nil
	}
	frame := appusePreviousFrame(snapshot.Owner)[shot.Monitor]
	if !appuseFrameFresh(frame, appuseSnapshotTTL) || frame.Image == nil {
		return nil
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
	if !appuseRegionUnchanged(frame.Image, grab, region, 0.06) {
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

func appusePerform(shot *appuseShot, action appuseAction) error {
	switch action.Action {
	case "wait":
		time.Sleep(time.Duration(action.milliseconds()) * time.Millisecond)
		return nil
	case "type":
		if action.Text == nil {
			return fmt.Errorf("type 缺少 text")
		}
		// Windows 走整段粘贴：逐键输入会被中文输入法改写/吞掉。
		return appusePasteText(*action.Text)
	case "press":
		if action.Key == nil {
			return fmt.Errorf("press 缺少 key")
		}
		return appusePressCombo(*action.Key)
	}
	target, err := appusePointOf(shot, action.X, action.Y)
	if err != nil {
		return err
	}
	button := "left"
	if action.Button != nil {
		button = *action.Button
	}
	// 指针默认沿轨迹可见地移过去（用户能看清在做什么）；glide:false 才瞬移。滚动始终瞬移定位。
	glide := action.Glide == nil || (*action.Glide && action.Action != "scroll")
	if glide {
		from, ok := appuseCursor()
		if ok {
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
	case "click", "double_click", "move", "drag", "type", "press", "scroll", "wait":
	default:
		return fmt.Errorf("未知动作；可用：click/double_click/move/drag/type/press/scroll/wait，按键用 press+key")
	}
	if a.Button != nil && *a.Button != "left" && *a.Button != "right" && *a.Button != "middle" {
		return fmt.Errorf("button 仅允许 left/right/middle")
	}
	if a.Axis != nil && *a.Axis != "vertical" && *a.Axis != "horizontal" {
		return fmt.Errorf("axis 仅允许 vertical/horizontal")
	}
	if a.Glide != nil && a.Action != "click" && a.Action != "double_click" && a.Action != "move" && a.Action != "drag" {
		return fmt.Errorf("glide 仅用于 click/double_click/move/drag")
	}
	if a.MS != nil && *a.MS > 2000 {
		return fmt.Errorf("ms=%d，允许范围为 0–2000", *a.MS)
	}
	switch a.Action {
	case "click", "double_click", "move", "drag", "scroll":
		if shot == nil {
			return fmt.Errorf("坐标动作需要截图")
		}
		if _, err := appusePointOf(shot, a.X, a.Y); err != nil {
			return err
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
		actions[index].Action == "type" || actions[index].Action == "scroll"
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

// appuseGlide 拟人位移：时长随距离增长（Fitts）、最小抖动缓动、略微弧线。
func appuseGlide(from, to appusePoint) error {
	distance := math.Hypot(float64(to.X-from.X), float64(to.Y-from.Y))
	milliseconds := math.Min(400, 80+60*math.Log2(1+distance/24))
	bend := (rand.Float64() - 0.5) * 0.2
	started := time.Now()
	for {
		// 按经过时间取样，不按步数：系统 sleep 粒度不能把动作拉长。
		t := math.Min(1, float64(time.Since(started).Milliseconds())/math.Max(1, milliseconds))
		point := appuseGlideAt(from, to, bend, t)
		if err := appuseMovePointer(point.X, point.Y, true); err != nil {
			return err
		}
		if t >= 1 {
			return nil
		}
		time.Sleep(8 * time.Millisecond)
	}
}

func appuseGlideAt(from, to appusePoint, bend, t float64) appusePoint {
	fx, fy := float64(from.X), float64(from.Y)
	dx, dy := float64(to.X-from.X), float64(to.Y-from.Y)
	cx, cy := fx+dx/2-dy*bend, fy+dy/2+dx*bend
	s := t * t * t * (10 - 15*t + 6*t*t)
	u := 1 - s
	return appusePoint{
		X: int32(math.Round(u*u*fx + 2*u*s*cx + s*s*float64(to.X))),
		Y: int32(math.Round(u*u*fy + 2*u*s*cy + s*s*float64(to.Y))),
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
