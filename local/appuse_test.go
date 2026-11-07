package main

import (
	"encoding/json"
	"testing"
	"time"
)

func appuseTestShot() *appuseShot {
	return &appuseShot{
		ImageID: "monitor-0", Surface: appuseSurface{ID: 0, X: 0, Y: 0, W: 1920, H: 1080},
		PixelsW: 960, PixelsH: 540, SourceW: 1920, SourceH: 1080, Monitor: 0,
	}
}

func TestAppusePointAimsAtPixelCentreAcrossScaleAndCrop(t *testing.T) {
	// 1:1：图内像素中心正好落在桌面像素中心。
	shot := appuseTestShot()
	shot.PixelsW, shot.PixelsH = 1920, 1080
	x, y := 10, 20
	point, err := appusePointOf(shot, &x, &y)
	if err != nil || point.X != 10 || point.Y != 20 {
		t.Fatalf("1:1 映射错了：%v %v", point, err)
	}
	// 半尺寸缩略图：图内 (5,10) 覆盖原始 (10..12, 20..22)，落点不偏左上。
	shot = appuseTestShot()
	x, y = 5, 10
	point, err = appusePointOf(shot, &x, &y)
	if err != nil || point.X != 11 || point.Y != 21 {
		t.Fatalf("缩放映射错了：%v %v", point, err)
	}
	// 局部截图：区域偏移必须叠回去。
	shot = appuseTestShot()
	shot.PixelsW, shot.PixelsH = 400, 300
	shot.Region = &appuseRegion{X: 100, Y: 200, Width: 800, Height: 600}
	x, y = 0, 0
	point, err = appusePointOf(shot, &x, &y)
	if err != nil || point.X != 101 || point.Y != 201 {
		t.Fatalf("区域映射错了：%v %v", point, err)
	}
	over := y + 300
	if _, err = appusePointOf(shot, &x, &over); err == nil {
		t.Fatal("超出图片的坐标必须报错，不能夹到边缘")
	}
}

func TestAppuseBatchSemanticsNeverClaimUntouchedInput(t *testing.T) {
	shot := appuseTestShot()
	// 未知动作、越界滚动、缺 key：整批在输入前退回。
	for _, action := range []appuseAction{
		{Action: "teleport"},
		{Action: "scroll", X: intPtr(1), Y: intPtr(1), Delta: intPtr(101)},
		{Action: "press"},
		{Action: "type", Text: stringPtr("ok\u0000")},
	} {
		if err := action.validate(shot); err == nil {
			t.Fatalf("应当拒绝：%+v", action)
		}
	}
	// 弱模型的等价格式仍然被接受。
	for _, action := range []appuseAction{
		{Action: "click", X: intPtr(1), Y: intPtr(2), Glide: boolPtr(false)},
		{Action: "wait", MS: intPtr(2000)},
		{Action: "press", Key: stringPtr("ctrl+s")},
	} {
		if err := action.validate(shot); err != nil {
			t.Fatalf("应当接受 %+v：%v", action, err)
		}
	}
	// 只等不输入：不算执行过输入。
	notice := appuseExecutedNotice([]appuseAction{{Action: "wait"}}, 1, "")
	if notice != "" {
		t.Fatalf("等待不应产生执行摘要：%s", notice)
	}
	// 批次中途失败：只概括已经完成的动作，notes 只作为意图转述。
	actions := []appuseAction{{Action: "click", X: intPtr(3), Y: intPtr(4)}, {Action: "type", Text: stringPtr("秘密")}}
	notice = appuseExecutedNotice(actions, 1, "打开菜单")
	if notice != "本批已执行：click(3,4)。你为这次操作写的意图：打开菜单" {
		t.Fatalf("执行摘要不对：%s", notice)
	}
}

func TestAppuseSnapshotBindsOnlyOwnRecentObservation(t *testing.T) {
	appuseSnapshots = map[string]*appuseSnapshot{}
	fresh := &appuseSnapshot{ID: "a", Owner: "s1", Taken: time.Now(), Shots: []appuseShot{*appuseTestShot()}}
	appuseSnapshots["s1"] = fresh
	appuseSnapshots["s2"] = &appuseSnapshot{ID: "b", Owner: "s2", Taken: time.Now().Add(-time.Hour), Shots: []appuseShot{*appuseTestShot()}}

	request := &appuseRequest{Operation: "act", Owner: "s1"}
	bindInputSnapshot(request)
	if request.SnapshotID != "a" {
		t.Fatalf("省略 snapshotId 时应绑定本会话最新快照，得到 %q", request.SnapshotID)
	}
	if appuseCurrent("s2", "") != nil {
		t.Fatal("过期快照不能再用于输入")
	}
	if appuseCurrent("s1", "b") != nil {
		t.Fatal("别的 snapshotId 必须被拒，不能换成最新快照")
	}
	shots := []appuseShot{*appuseTestShot()}
	shot := appuseFindShot(&appuseSnapshot{Shots: shots}, "")
	if shot == nil || shot.ImageID != "monitor-0" {
		t.Fatal("单图快照允许省略 imageId")
	}
	multi := &appuseSnapshot{Shots: []appuseShot{*appuseTestShot(), {ImageID: "monitor-1"}}}
	if appuseFindShot(multi, "") != nil {
		t.Fatal("多图快照必须明确 imageId，不能猜")
	}
	if message := appuseImageListError(multi); message == "" || !contains(message, "monitor-1") {
		t.Fatalf("多图未指定 imageId 时要列出可用 id：%s", message)
	}
}

func TestAppuseRejectsUnknownFieldsBeforeDesktopWork(t *testing.T) {
	// 与 Nova 一致：多写字段直接退回，不做“猜意图”的宽松解析。
	raw, _ := json.Marshal(map[string]any{"operation": "windows", "unexpected": true})
	if appuseExecute(raw)["error"] == nil {
		t.Fatal("未知字段必须在桌面工作前被拒")
	}
	// 只读操作忽略无关字段（与 Nova 一致），但仍不接受动作。
	raw, _ = json.Marshal(map[string]any{"operation": "windows", "actions": []any{map[string]any{"action": "type", "text": "never"}}})
	if _, ok := appuseExecute(raw)["windows"]; !ok {
		t.Fatal("windows 应忽略无关字段并返回窗口列表")
	}
	raw, _ = json.Marshal(map[string]any{"operation": "act", "actions": []any{map[string]any{"action": "wait", "ms": 2001}}})
	result := appuseExecute(raw)
	if result["error"] == nil {
		t.Fatalf("ms=2001 必须在执行前被拒：%v", result)
	}
	raw, _ = json.Marshal(map[string]any{"operation": "act", "actions": []any{}})
	if appuseExecute(raw)["error"] == nil {
		t.Fatal("空 actions 必须被拒")
	}
	raw, _ = json.Marshal(map[string]any{"operation": "screenshot", "maxEdge": 100})
	if appuseExecute(raw)["error"] == nil {
		t.Fatal("maxEdge=100 必须被拒")
	}
}

func TestAppuseKeyNamesMatchNovaShortcuts(t *testing.T) {
	for _, raw := range []string{"Enter", "ctrl+shift+s", "f5", "PageDown", "meta+Left"} {
		if _, err := appuseKeys(raw); err != nil {
			t.Fatalf("%s 应当可用：%v", raw, err)
		}
	}
	for _, raw := range []string{"ctrl+shift+alt+meta+s", "hyper", ""} {
		if _, err := appuseKeys(raw); err == nil {
			t.Fatalf("%s 应当被拒", raw)
		}
	}
}

func TestAppuseDelayKeepsExplicitWaitsAndReactions(t *testing.T) {
	actions := []appuseAction{{Action: "click"}, {Action: "wait"}, {Action: "move"}, {Action: "type"}}
	if got := appuseActionDelay(actions, 1); got != 0 {
		t.Fatalf("等待本身不应额外等待：%v", got)
	}
	if got := appuseActionDelay(actions, 2); got != 0 {
		t.Fatalf("等待之前的动作不应再补反应时间：%v", got)
	}
	if got := appuseActionDelay(actions, 3); got != 300*time.Millisecond {
		t.Fatalf("最后一个输入要留反应时间：%v", got)
	}
	if got := appuseActionDelay([]appuseAction{{Action: "press"}, {Action: "type"}, {Action: "press"}}, 0); got != 80*time.Millisecond {
		t.Fatalf("中间动作只需一点点间隔：%v", got)
	}
	if got := appuseActionDelay([]appuseAction{{Action: "click"}, {Action: "type"}, {Action: "press"}}, 0); got != 300*time.Millisecond {
		t.Fatalf("点击后要留反应时间：%v", got)
	}
}

func intPtr(value int) *int          { return &value }
func stringPtr(value string) *string { return &value }
func boolPtr(value bool) *bool       { return &value }

func contains(haystack, needle string) bool {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
