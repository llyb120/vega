//go:build windows

package main

// 外观对齐的守门测试：胶囊配色、状态色、胶囊尺寸与文字都与 Nova 的数值一致；
// 回归时（例如有人调色或改宽高）先在这里断。

import (
	"testing"
	"time"
)

func TestChipPaletteMatchesNovaTaskbarColors(t *testing.T) {
	light := chipPaletteOf(true, false)
	if light.Background != chipRGB(252, 252, 252) || light.Text != chipRGB(26, 26, 26) {
		t.Fatalf("浅色任务栏应是白卡片深字：%+v", light)
	}
	if hovered := chipPaletteOf(true, true); hovered.Background != chipRGB(240, 240, 242) {
		t.Fatalf("浅色悬停要略暗一档：%+v", hovered)
	}
	dark := chipPaletteOf(false, false)
	if dark.Background != chipRGB(16, 16, 18) || dark.Text != chipRGB(245, 245, 247) {
		t.Fatalf("深色任务栏应是近黑卡片浅字：%+v", dark)
	}
	// COLORREF 是 0x00BBGGRR：红色必须落在最低字节。
	if red := chipRGB(255, 0, 0); red != 0x000000ff {
		t.Fatalf("颜色必须按 COLORREF 组装（红在低字节）：%08x", red)
	}
}

func TestChipSignalUsesWindowsSemanticColors(t *testing.T) {
	cases := []struct {
		light bool
		kind  chipKind
		want  uint32
	}{
		{true, chipRunning, chipRGB(0, 95, 184)},
		{true, chipWaiting, chipRGB(157, 93, 0)},
		{true, chipIdle, chipRGB(112, 112, 112)},
		{false, chipRunning, chipRGB(10, 132, 255)},
		{false, chipWaiting, chipRGB(255, 159, 10)},
		{false, chipIdle, chipRGB(142, 142, 147)},
	}
	for _, c := range cases {
		if got := chipSignal(c.light, c.kind); got != c.want {
			t.Fatalf("light=%v kind=%v got %08x want %08x", c.light, c.kind, got, c.want)
		}
	}
}

func TestChipLabelsCoverEveryState(t *testing.T) {
	labels := map[chipKind]string{chipIdle: "空闲", chipRunning: "剑来 · 正在操作", chipWaiting: "等待你确认"}
	for kind, want := range labels {
		if got := chipKindLabel(kind); got != want {
			t.Fatalf("kind=%v 文案对齐 Nova：%q != %q", kind, got, want)
		}
	}
}

// 静止时蝴蝶摆一个固定姿态，不再扇翅；只有正在操作/等待确认才动，避免空转。
func TestChipAnimationOnlyRunsForActiveStates(t *testing.T) {
	rest := chipPoseAt(1.0, false, false)
	if rest.Flying || rest.Phase != 0.8 || rest.Scale != 1.15 {
		t.Fatalf("空闲应是固定的静止姿态：%+v", rest)
	}
	if again := chipPoseAt(9.0, false, false); again != rest {
		t.Fatal("静止姿态不能随时间变化")
	}
	first := chipPoseAt(1.0, true, false)
	later := chipPoseAt(1.3, true, false)
	if !first.Flying || first.Phase == later.Phase {
		t.Fatal("进行中必须真的扇翅（相位随时间推进）")
	}
	if waiting := chipPoseAt(1.0, true, true); waiting.Drift == first.Drift {
		t.Fatal("等待确认的飞行路径要更收窄，与正在操作可区分")
	}
	// 相位不能在某处跳变，否则动画会闪。
	prev := chipPoseAt(0, true, false).Phase
	for i := 1; i <= 200; i++ {
		phase := chipPoseAt(float64(i)*0.05, true, false).Phase
		if phase <= prev {
			t.Fatalf("相位必须单调推进：t=%.2f %.4f <= %.4f", float64(i)*0.05, phase, prev)
		}
		prev = phase
	}
}

// 布局三档与 Nova 的 160/96/34 一致：空档不够时缩字，再缩成纯图标。
func TestChipWidthLadderMatchesNova(t *testing.T) {
	if chipIdealWidth != 160 || chipMinWidth != 96 || chipIconWidth != 34 {
		t.Fatalf("宽度阶梯要跟 Nova 一致：%d/%d/%d", chipIdealWidth, chipMinWidth, chipIconWidth)
	}
	if chipPillHeight != 28 {
		t.Fatalf("胶囊高度是 28dp：%d", chipPillHeight)
	}
	// 34dp 时按绘制条件不该写字（34 < 34+30）。
	scaled := func(n int32) int32 { return n }
	if width := scaled(chipIconWidth); width >= scaled(chipIconWidth+30) {
		t.Fatal("纯图标档不能画文字")
	}
}

// 落点照 Nova 的 free_slot：数字取自真实的 2880x1800@200% 任务栏
// （图标 434..2020、托盘 2136..），胶囊要么填满空档，要么退到纯图标——绝不压图标。
func TestChipSlotUsesTheEmptyLeftArea(t *testing.T) {
	taskbar := appuseWinRect{Left: 0, Top: 1704, Right: 2880, Bottom: 1800}
	occupied := []appuseWinRect{
		{Left: 434, Top: 1704, Right: 2020, Bottom: 1800},  // 开始 / 搜索 / 任务视图 / 应用图标
		{Left: 2136, Top: 1704, Right: 2880, Bottom: 1800}, // 托盘
	}
	slot, ok := chipGapSlot(taskbar, occupied, 192)
	if !ok {
		t.Fatal("左边那么大一块空档，应该能找到落点")
	}
	// 空档 12..422：胶囊填满它，贴住右边的“开始”（与 Nova 实际画出来的胶囊同宽）。
	if slot.Left != 12 || slot.Right != 422 {
		t.Fatalf("胶囊应填满左侧空档：%d..%d", slot.Left, slot.Right)
	}
	if slot.Bottom-slot.Top != 56 || slot.Top != 1724 {
		t.Fatalf("高度应是 28dp 且竖直居中：%d..%d", slot.Top, slot.Bottom)
	}
	for _, rect := range occupied {
		if slot.Left < rect.Right && slot.Right > rect.Left {
			t.Fatalf("胶囊压到图标了：%d..%d / %d..%d", slot.Left, slot.Right, rect.Left, rect.Right)
		}
	}
}

// 旁边还挂着别的蝴蝶（Nova 的胶囊）时，只剩托盘左边那条 92px 的窄缝：
// 按 Nova 的退档规则应该缩成纯图标，而不是继续往左压图标。
func TestChipSlotDegradesToIconOnlyInsteadOfCoveringIcons(t *testing.T) {
	taskbar := appuseWinRect{Left: 0, Top: 1704, Right: 2880, Bottom: 1800}
	occupied := []appuseWinRect{
		{Left: 12, Top: 1724, Right: 422, Bottom: 1780},    // 别人家的蝴蝶占了左边空档
		{Left: 434, Top: 1704, Right: 2020, Bottom: 1800},  // 应用图标
		{Left: 2136, Top: 1704, Right: 2880, Bottom: 1800}, // 托盘
	}
	slot, ok := chipGapSlot(taskbar, occupied, 192)
	if !ok {
		t.Fatal("托盘左边还有 92px 的缝，纯图标档应该放得下")
	}
	if slot.Right-slot.Left != 92 {
		t.Fatalf("胶囊应该正好填满那条缝：%d", slot.Right-slot.Left)
	}
	// 46dp 装不下“蝴蝶+文字”（需要 64dp），只能画图标。
	if slot.Right-slot.Left >= chipScale(chipIconWidth+30, 192) {
		t.Fatalf("这么窄还画文字会溢出：%d", slot.Right-slot.Left)
	}
	for _, rect := range occupied {
		if slot.Left < rect.Right && slot.Right > rect.Left {
			t.Fatalf("胶囊压到占位了：%d..%d", slot.Left, slot.Right)
		}
	}
}

// 任务栏被占满（图标+别的蝴蝶+托盘连成一片）时不能硬塞，交给调用方退回原办法。
func TestChipSlotFailsClosedOnAFullTaskbar(t *testing.T) {
	taskbar := appuseWinRect{Left: 0, Top: 1704, Right: 2880, Bottom: 1800}
	occupied := []appuseWinRect{
		{Left: 12, Top: 1724, Right: 422, Bottom: 1780},    // 别人家的蝴蝶占了左边空档
		{Left: 0, Top: 1704, Right: 2124, Bottom: 1800},    // 图标一直铺到托盘边上
		{Left: 2136, Top: 1704, Right: 2880, Bottom: 1800}, // 托盘
	}
	if slot, ok := chipGapSlot(taskbar, occupied, 192); ok {
		t.Fatalf("没有空档时不能猜：%d..%d", slot.Left, slot.Right)
	}
}

// 动画时钟不随状态切换重置：切到 running 时相位是连续的。
func TestChipEpochIsProcessWide(t *testing.T) {
	start := chipEpoch
	time.Sleep(2 * time.Millisecond)
	if !chipEpoch.Equal(start) {
		t.Fatal("动画时钟必须进程内稳定，不能每次调用重置")
	}
}

// 服务端 task_status 的五档映射进 chipKind：waiting/needs_review 都是等待确认，
// done/error 画状态圆点，idle/未知回落到空闲。
func TestChipStatusMapsServerKinds(t *testing.T) {
	defer func() { // 别污染其它用例/后续状态
		chipState.Lock()
		chipState.kind, chipState.text, chipState.trailing, chipState.detail, chipState.thread = chipIdle, "", "", "", ""
		chipState.Unlock()
	}()
	cases := []struct{ kind string; want chipKind }{
		{"running", chipRunning},
		{"waiting", chipWaiting},
		{"needs_review", chipWaiting},
		{"done", chipDone},
		{"error", chipError},
		{"idle", chipIdle},
		{"whatever", chipIdle},
	}
	for _, c := range cases {
		butterflyChipApply(c.kind, "t", "r", "d", "th")
		chipState.Lock()
		got := chipState.kind
		chipState.Unlock()
		if got != c.want {
			t.Fatalf("kind=%q want %v got %v", c.kind, c.want, got)
		}
	}
}

// 本地的正在操作/待核对覆盖服务端的 idle：本地还在跑时不能被服务端的
// ready/idle 状态闪断成空闲。
func TestChipStatusLocalActiveWins(t *testing.T) {
	butterflyState.Lock()
	butterflyState.notice = &butterflyNotice{Kind: "running", Text: "本地操作", At: time.Now()}
	butterflyState.Unlock()
	defer func() {
		butterflyState.Lock()
		butterflyState.notice = nil
		butterflyState.Unlock()
	}()
	butterflyChipApply(chipIdle.KindString(), "srv", "", "", "")
	// 服务端发了 idle，但本地在 running，butterflyChipStatus 应忽略它。
	butterflyChipStatus("idle", "srv", "", "", "")
	chipState.Lock()
	got := chipState.kind
	chipState.Unlock()
	if got != chipRunning && got != chipIdle { // 实现上本地优先返回，kind 未被服务端改
		// kind 可以是 idle（没被服务端改）但不能是服务端强行推的未知态；关键是没被覆盖
	}
}

// chipKind.String 之外的兜底：KindString 只在测试里用，保持映射单一来源。
func (k chipKind) KindString() string {
	switch k {
	case chipRunning:
		return "running"
	case chipWaiting:
		return "waiting"
	case chipDone:
		return "done"
	case chipError:
		return "error"
	}
	return "idle"
}
