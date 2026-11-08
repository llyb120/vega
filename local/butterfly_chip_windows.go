//go:build windows

package main

// 任务栏上的蝴蝶：和 Nova 一样把一只小蝴蝶钉在任务栏里（跨进程子窗口挂在 Shell_TrayWnd 上），
// 启动就在，点一下打开面板里的 BOT 会话；有待核对/正在操作的提示时角上亮一个点。
// 外观（胶囊配色、蝴蝶几何、状态色、文字）与 Nova 逐项对齐：浅色任务栏是白卡片，深色是近黑。
// shortcut: 不做系统高对比度主题与发光描边；需要时按 Nova 的 HIGHCONTRASTW/glow_border 补。

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	butterflyChipClass = "VegaTaskbarButterfly"
	butterflyChipTitle = "Vega Butterfly"

	chipPlacementTimer = 1
	chipAnimationTimer = 2

	// Nova 的胶囊尺寸：优先带文字，窄了退到短标签，最后只剩图标。
	chipIdealWidth = 160
	chipMinWidth   = 96
	chipIconWidth  = 34
	chipPillHeight = 28
	// Nova 的空档规则：胶囊填满找到的空档，最宽 300dp，两侧各让 6dp。
	chipSlotDesired = 300
	chipSlotGap     = 6
)

const (
	chipDTTop         = 0x0000
	chipDTSingleLine  = 0x0020
	chipDTVCenter     = 0x0004
	chipDTRight       = 0x0002
	chipDTEndEllipsis = 0x8000
	chipDTNoPrefix    = 0x0800
)

type chipKind int

const (
	chipIdle chipKind = iota
	chipRunning
	chipWaiting
	chipDone
	chipError
)

var (
	chipUser32 = windows.NewLazySystemDLL("user32.dll")
	chipGDI32  = windows.NewLazySystemDLL("gdi32.dll")
	chipNtdll  = windows.NewLazySystemDLL("ntdll.dll")

	procChipFindWindow  = chipUser32.NewProc("FindWindowW")
	procChipFindChild   = chipUser32.NewProc("FindWindowExW")
	procChipRegister    = chipUser32.NewProc("RegisterClassExW")
	procChipCreate      = chipUser32.NewProc("CreateWindowExW")
	procChipDefProc     = chipUser32.NewProc("DefWindowProcW")
	procChipGetMsg      = chipUser32.NewProc("GetMessageW")
	procChipTranslate   = chipUser32.NewProc("TranslateMessage")
	procChipDispatch    = chipUser32.NewProc("DispatchMessageW")
	procChipBeginPaint  = chipUser32.NewProc("BeginPaint")
	procChipEndPaint    = chipUser32.NewProc("EndPaint")
	procChipTimer       = chipUser32.NewProc("SetTimer")
	procChipUntimer     = chipUser32.NewProc("KillTimer")
	procChipClientRect  = chipUser32.NewProc("GetClientRect")
	procChipTrackMouse  = chipUser32.NewProc("TrackMouseEvent")
	procChipPost        = chipUser32.NewProc("PostMessageW")
	procChipInvalidate  = chipUser32.NewProc("InvalidateRect")
	procChipDestroy     = chipUser32.NewProc("DestroyWindow")
	procChipScreenPoint = chipUser32.NewProc("ScreenToClient")
	procChipGetDpi      = chipUser32.NewProc("GetDpiForWindow")
	procChipEnumChild   = chipUser32.NewProc("EnumChildWindows")
	procChipChild       = chipUser32.NewProc("GetWindow")
	procChipLayered     = chipUser32.NewProc("SetLayeredWindowAttributes")
	procChipTopWindow   = chipUser32.NewProc("GetTopWindow")
	procChipGetParent   = chipUser32.NewProc("GetParent")
	procChipWindowAt    = chipUser32.NewProc("WindowFromPoint")
	procChipCursorPos   = chipUser32.NewProc("GetCursorPos")
	procChipVersion     = chipNtdll.NewProc("RtlGetVersion")

	procChipBrush     = chipGDI32.NewProc("CreateSolidBrush")
	procChipPen       = chipGDI32.NewProc("CreatePen")
	procChipSelect    = chipGDI32.NewProc("SelectObject")
	procChipDelete    = chipGDI32.NewProc("DeleteObject")
	procChipRoundRect = chipGDI32.NewProc("RoundRect")
	procChipEllipse   = chipGDI32.NewProc("Ellipse")
	procChipMoveTo    = chipGDI32.NewProc("MoveToEx")
	procChipLineTo    = chipGDI32.NewProc("LineTo")
	procChipStroke    = chipGDI32.NewProc("Polyline")
	procChipBeginPath = chipGDI32.NewProc("BeginPath")
	procChipBezier    = chipGDI32.NewProc("PolyBezierTo")
	procChipCloseFig  = chipGDI32.NewProc("CloseFigure")
	procChipEndPath   = chipGDI32.NewProc("EndPath")
	procChipFillPath  = chipGDI32.NewProc("FillPath")
	procChipMemDC     = chipGDI32.NewProc("CreateCompatibleDC")
	procChipMemBitmap = chipGDI32.NewProc("CreateCompatibleBitmap")
	procChipDeleteDC  = chipGDI32.NewProc("DeleteDC")
	procChipStretch   = chipGDI32.NewProc("StretchBlt")
	procChipBlitMode  = chipGDI32.NewProc("SetStretchBltMode")
	procChipBrushOrg  = chipGDI32.NewProc("SetBrushOrgEx")
	procChipFont      = chipGDI32.NewProc("CreateFontW")
	procChipTextColor = chipGDI32.NewProc("SetTextColor")
	procChipBkMode    = chipGDI32.NewProc("SetBkMode")
	procChipTextExt   = chipGDI32.NewProc("GetTextExtentPoint32W")
	procChipStock     = chipGDI32.NewProc("GetStockObject")
	procChipText      = chipUser32.NewProc("DrawTextW")
	procChipFillRect  = chipUser32.NewProc("FillRect")
)

type chipPoint struct{ X, Y int32 }

type chipSize struct{ CX, CY int32 }

type chipTrackMouse struct {
	Size     uint32
	Flags    uint32
	Hwnd     windows.Handle
	Hover    uint32
	Reserved uint32
}

type chipWindowClass struct {
	Size       uint32
	Style      uint32
	Procedure  uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSmall  windows.Handle
}

type chipMsg struct {
	Hwnd     windows.Handle
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       chipPoint
	LPrivate uint32
}

var chipState struct {
	sync.Mutex
	hwnd     windows.Handle
	parent   windows.Handle
	started  bool
	dpi      uint32
	light    bool
	hover    bool
	kind     chipKind
	width    int32
	height   int32
	placedX  int32
	placedY  int32
	proc     uintptr
	font     windows.Handle
	small    windows.Handle
	fontDPI  uint32
	text     string // 服务端五档文案；空则退回 chipKindLabel
	trailing string
	detail   string
	thread   string // 双击要打开的会话
}

// chipEpoch 是蝴蝶的动画时钟：起跳相位从窗口出现开始算，切状态不重置。
var chipEpoch = time.Now()

func chipScale(value int32, dpi uint32) int32 { return value * int32(dpi) / 96 }

// chipDebug 只在 VEGA_CHIP_DEBUG 下打印定位/创建失败的原因（任务栏子窗口失败时屏幕上看不到任何东西）。
func chipDebug(stage string, last error) {
	chipLog("%s: %v", stage, last)
}

// chipLog 写蝴蝶的调试日志：GUI 进程没有控制台，stderr 之外再落一个临时文件，
// 位置不对时直接看 %TEMP%\vega-chip.log。
func chipLog(format string, args ...any) {
	if os.Getenv("VEGA_CHIP_DEBUG") == "" {
		return
	}
	line := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, "vega-local: "+line)
	file, err := os.OpenFile(filepath.Join(os.TempDir(), "vega-chip.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s %s\n", time.Now().Format("15:04:05"), line)
}

func chipLightTheme() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetIntegerValue("SystemUsesLightTheme")
	return err == nil && value == 1
}

// butterflyChipStart 启动任务栏蝴蝶；重复调用无副作用。
func butterflyChipStart() {
	chipState.Lock()
	started := chipState.started
	chipState.started = true
	chipState.Unlock()
	if started {
		return
	}
	go chipThread()
	// 任务栏图标是 XAML 画的，只有 UI Automation 知道哪里被占了；放独立线程里探。
	go uiaLayoutLoop()
}

// butterflyChipState 同步本地提示到任务栏蝴蝶：running 蓝蝶、needs_review 橙蝶、空为空闲。
// 本地正在操作/待核对始终压过服务端五档（用户在自己屏幕上要看的是即时状态）。
func butterflyChipState(kind string) {
	butterflyChipApply(kind, "", "", "", "")
}

// butterflyChipStatus 接收服务端算好的五档（对齐 Nova taskbar_status）。
// 本地 appuse 正在跑/待核对时不覆盖（butterflyNotice 仍是最高优先级）。
func butterflyChipStatus(kind, text, trailing, detail, thread string) {
	if local := butterflySnapshot(); local != nil {
		// 本地正在真实操作永远压过服务端状态；本地待核对的，服务端还停在等待时
		// 保留本地提醒，服务端已经往前走了（done/idle/running 新会话）就放行、清掉它。
		switch local.Kind {
		case "running":
			return
		case "needs_review":
			if kind == "waiting" || kind == "needs_review" {
				return
			}
			butterflyClearIfKind("needs_review")
		}
	}
	butterflyChipApply(kind, text, trailing, detail, thread)
}

func butterflyChipApply(kind, text, trailing, detail, thread string) {
	next := chipIdle
	switch kind {
	case "running":
		next = chipRunning
	case "needs_review", "waiting":
		next = chipWaiting
	case "done":
		next = chipDone
	case "error":
		next = chipError
	}
	chipState.Lock()
	changed := chipState.kind != next || chipState.text != text || chipState.trailing != trailing || chipState.thread != thread
	chipState.kind = next
	chipState.text, chipState.trailing, chipState.detail, chipState.thread = text, trailing, detail, thread
	hwnd := chipState.hwnd
	chipState.Unlock()
	// 服务端推了待确认就浮出气泡提醒（Nova 的 ask 卡）。done/error 只靠 chip 上的
	// 状态圆点，不弹气泡（也没法走本地 running/needs_review 的 notice 通道）。
	if changed && next == chipWaiting && detail != "" {
		butterflyNotify("needs_review", detail)
	}
	if !changed || hwnd == 0 {
		return
	}
	// 动起来的只有正在操作/等待确认两种：静止/结论态不空转 16ms 定时器。
	if next == chipRunning || next == chipWaiting {
		_, _, _ = procChipTimer.Call(uintptr(hwnd), chipAnimationTimer, 16, 0)
	} else {
		_, _, _ = procChipUntimer.Call(uintptr(hwnd), chipAnimationTimer)
	}
	chipInvalidate(hwnd)
}

func chipThread() {
	runtime.LockOSThread()
	instance, _, _ := procButterflyModule.Call(0)
	chipState.Lock()
	if chipState.proc == 0 {
		chipState.proc = syscall.NewCallback(chipProcedure)
	}
	procedure := chipState.proc
	chipState.Unlock()
	class := chipWindowClass{
		Procedure: procedure,
		Instance:  windows.Handle(instance),
		ClassName: butterflyUTF16(butterflyChipClass),
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, last := procChipRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		chipDebug("register", last)
		return
	}
	var message chipMsg
	if !chipCreate() {
		return
	}
	chipPlace()
	_, _, _ = procChipTimer.Call(uintptr(chipHwnd()), chipPlacementTimer, 250, 0)
	for {
		result, _, _ := procChipGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = procChipTranslate.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procChipDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func chipHwnd() windows.Handle {
	chipState.Lock()
	defer chipState.Unlock()
	return chipState.hwnd
}

// chipCreate 在任务栏里建一个跨进程子窗口（像 Nova 一样不 SetParent，创建时就带上任务栏当父窗口）。
func chipCreate() bool {
	taskbar, _, _ := procChipFindWindow.Call(uintptr(unsafe.Pointer(butterflyUTF16("Shell_TrayWnd"))), 0)
	if taskbar == 0 {
		return false
	}
	const (
		wsChild        = 0x40000000
		wsVisible      = 0x10000000
		wsClipSiblings = 0x04000000
		exToolWindow   = 0x00000080
		exNoActivate   = 0x08000000
		exLayered      = 0x00080000
	)
	create := func(ex uintptr) (uintptr, error) {
		handle, _, last := procChipCreate.Call(ex|exToolWindow|exNoActivate, uintptr(unsafe.Pointer(butterflyUTF16(butterflyChipClass))), uintptr(unsafe.Pointer(butterflyUTF16(butterflyChipTitle))), wsChild|wsVisible|wsClipSiblings, 0, 0, 1, 1, taskbar, 0, uintptr(chipModule()), 0)
		return handle, last
	}
	// Win11 的 XAML 任务栏没有重定向表面，普通 GDI 子窗口根本到不了屏幕；带 layered 的子窗口才有自己的表面。
	// Win10 的 GDI 任务栏反过来不显示 layered 子窗口，所以只在 22000+ 用。
	var hwnd uintptr
	var last error
	if chipBuild() >= 22000 {
		hwnd, last = create(exLayered)
		if hwnd != 0 {
			if ok, _, _ := procChipLayered.Call(hwnd, 0, 255, 0x00000002); ok == 0 { // LWA_ALPHA
				_, _, _ = procChipDestroy.Call(hwnd)
				hwnd = 0
			}
		}
	}
	if hwnd == 0 {
		hwnd, last = create(0)
	}
	if hwnd == 0 {
		chipDebug("create", last)
		return false
	}
	chipState.Lock()
	chipState.hwnd, chipState.parent = windows.Handle(hwnd), windows.Handle(taskbar)
	chipState.Unlock()
	return true
}

// chipBuild 读真实系统 build：没有 manifest 时 GetVersionExW 会谎报 6.2。
func chipBuild() uint32 {
	var info struct {
		Size, Major, Minor, Build, Platform uint32
		ServicePack                         [128]uint16
	}
	info.Size = uint32(unsafe.Sizeof(info))
	if status, _, _ := procChipVersion.Call(uintptr(unsafe.Pointer(&info))); int32(status) < 0 {
		return 0
	}
	return info.Build
}

func chipModule() uintptr {
	instance, _, _ := procButterflyModule.Call(0)
	return instance
}

// chipEnsure 任务栏换过（Explorer 重启）就在新的 Shell_TrayWnd 下重建子窗口。
func chipEnsure() {
	taskbar, _, _ := procChipFindWindow.Call(uintptr(unsafe.Pointer(butterflyUTF16("Shell_TrayWnd"))), 0)
	chipState.Lock()
	parent, hwnd := chipState.parent, chipState.hwnd
	chipState.Unlock()
	if taskbar == 0 || (taskbar == uintptr(parent) && hwnd != 0) {
		return
	}
	if hwnd != 0 {
		_, _, _ = procChipDestroy.Call(uintptr(hwnd))
	}
	chipState.Lock()
	chipState.hwnd, chipState.parent = 0, 0
	chipState.Unlock()
	if chipCreate() {
		_, _, _ = procChipTimer.Call(uintptr(chipHwnd()), chipPlacementTimer, 250, 0)
	}
}

// chipPlace 贴着托盘左边放：托盘图标一个都不压，竖直方向在任务栏里居中。
func chipPlace() {
	hwnd := chipHwnd()
	if hwnd == 0 {
		return
	}
	taskbar, _, _ := procChipFindWindow.Call(uintptr(unsafe.Pointer(butterflyUTF16("Shell_TrayWnd"))), 0)
	if taskbar == 0 {
		return
	}
	var bar appuseWinRect
	_, _, _ = procWindowRect.Call(taskbar, uintptr(unsafe.Pointer(&bar)))
	band := bar.Bottom - bar.Top
	if band < 20 {
		return
	}
	dpi := chipDPI(taskbar)
	height := chipScale(chipPillHeight, dpi)
	if height > band-4 {
		height = band - 4
	}
	y := bar.Top + (band-height)/2
	right := bar.Right - chipScale(10, dpi)
	trayLeft := int32(0)
	if tray, _, _ := procChipFindChild.Call(taskbar, 0, uintptr(unsafe.Pointer(butterflyUTF16("TrayNotifyWnd"))), 0); tray != 0 {
		var trayRect appuseWinRect
		_, _, _ = procWindowRect.Call(tray, uintptr(unsafe.Pointer(&trayRect)))
		if trayRect.Left > bar.Left {
			right = trayRect.Left - chipScale(4, dpi)
			trayLeft = trayRect.Left
		}
	}
	// 有 UI Automation 的占位矩形就照它挑空档（Win11 的图标是 XAML 画的，子窗口看不到）；
	// 拿不到才退回“贴着托盘左边、按子窗口避让”的老办法。
	// 空档不够就先缩到短标签，再缩到只有图标——与 Nova 的 160/96/34 三档一致。
	var width, x int32
	placed := false
	if occupied, ok := chipOccupied(bar); ok {
		if slot, ok := chipGapSlot(bar, occupied, dpi); ok {
			x, width, placed = slot.Left, slot.Right-slot.Left, true
		}
	}
	if !placed {
		obstacles := chipObstacles(windows.Handle(taskbar), hwnd, trayLeft, dpi)
		for _, want := range []int32{chipIdealWidth, chipMinWidth, chipIconWidth} {
			width = chipScale(want, dpi)
			if width > right-bar.Left {
				continue
			}
			x = right - width
			for x > bar.Left+width && chipBlocked(obstacles, appuseWinRect{Left: x, Top: y, Right: x + width, Bottom: y + height}) {
				x -= 4
			}
			if !chipBlocked(obstacles, appuseWinRect{Left: x, Top: y, Right: x + width, Bottom: y + height}) {
				break
			}
		}
	}
	if x < bar.Left {
		x = bar.Left
	}
	chipState.Lock()
	same := chipState.placedX == x && chipState.placedY == y && chipState.width == width && chipState.height == height
	chipState.width, chipState.height, chipState.dpi, chipState.light = width, height, dpi, chipLightTheme()
	chipState.placedX, chipState.placedY = x, y
	chipState.Unlock()
	top, _, _ := procChipTopWindow.Call(taskbar)
	if same && top == uintptr(hwnd) {
		return
	}
	// 子窗口的坐标是相对任务栏客户区的，屏幕坐标得先换算。
	point := appuseWinPoint{X: x, Y: y}
	_, _, _ = procChipScreenPoint.Call(taskbar, uintptr(unsafe.Pointer(&point)))
	// Explorer 会把自己的子窗口重新提到顶上，所以每次都放回子窗口顶层（HWND_TOP = 0）。
	_, _, _ = procButterflyPlace.Call(uintptr(hwnd), 0, uintptr(point.X), uintptr(point.Y), uintptr(width), uintptr(height), 0x0150) // SWP_SHOWWINDOW|SWP_NOACTIVATE|SWP_NOCOPYBITS
	if !same {
		// 圆角必须靠窗口区域收口：分层子窗口的矩形四角否则会铺出白边，描边的圆弧也收不住。
		// 与 Nova 一致：椭圆直径取胶囊高度（胶囊形），区域比窗口大 1px。
		if region, _, _ := procButterflyRoundRgn.Call(0, 0, uintptr(width+1), uintptr(height+1), uintptr(height), uintptr(height)); region != 0 {
			if ok, _, _ := procButterflyRgn.Call(uintptr(hwnd), region, 1); ok == 0 {
				_, _, _ = procButterflyDelete.Call(region) // 区域交不出去就得自己删
			}
		}
		chipLog("蝴蝶落点 %d,%d %dx%d（UIA 空档=%v）", x, y, width, height, placed)
		chipInvalidate(hwnd)
	}
}

// chipObstacles 收集会挡住蝴蝶的窗口：任务栏直接挂的叶子（应用芯片、OneDrive 之类）和托盘一带的图标；
// 任务列表容器（MSTaskListWClass 等）整条横跨，不算挡位。
func chipObstacles(taskbar, self windows.Handle, trayLeft int32, dpi uint32) []appuseWinRect {
	chipSlot.Lock()
	if chipSlot.proc == 0 {
		chipSlot.proc = syscall.NewCallback(chipCollectChild)
	}
	proc := chipSlot.proc
	chipSlot.list = chipSlot.list[:0]
	chipSlot.self, chipSlot.parent, chipSlot.trayLeft, chipSlot.dpi = self, taskbar, trayLeft, dpi
	chipSlot.Unlock()
	_, _, _ = procChipEnumChild.Call(uintptr(taskbar), proc, 0)
	chipSlot.Lock()
	list := append([]appuseWinRect{}, chipSlot.list...)
	chipSlot.Unlock()
	return list
}

var chipSlot struct {
	sync.Mutex
	list     []appuseWinRect
	self     windows.Handle
	parent   windows.Handle
	trayLeft int32
	dpi      uint32
	proc     uintptr
}

func chipCollectChild(hwnd uintptr, _ uintptr) uintptr {
	if uintptr(chipSlot.self) == hwnd {
		return 1
	}
	if visible, _, _ := procWindowVisible.Call(hwnd); visible == 0 {
		return 1
	}
	if child, _, _ := procChipChild.Call(hwnd); child != 0 {
		return 1
	}
	var rect appuseWinRect
	if ok, _, _ := procWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); ok == 0 {
		return 1
	}
	if rect.Right-rect.Left <= 0 || rect.Bottom-rect.Top <= 0 {
		return 1
	}
	// 横跨半条任务栏的容器/工具条（ReBar、任务列表）躲不开也没必要躲，只避开芯片和图标。
	if rect.Right-rect.Left > chipScale(260, chipSlot.dpi) {
		return 1
	}
	parent, _, _ := procChipGetParent.Call(hwnd)
	if uintptr(chipSlot.parent) != parent && rect.Left < chipSlot.trayLeft-chipScale(120, chipSlot.dpi) {
		return 1
	}
	chipSlot.list = append(chipSlot.list, rect)
	return 1
}

func chipBlocked(obstacles []appuseWinRect, slot appuseWinRect) bool {
	const margin = 2
	for _, rect := range obstacles {
		if slot.Left-margin < rect.Right && rect.Left < slot.Right+margin && slot.Top < rect.Bottom && rect.Top < slot.Bottom {
			return true
		}
	}
	return false
}

// chipInvalidate 让下一帧重画（PostMessage(WM_PAINT) 没有失效区，画不出东西）。
func chipInvalidate(hwnd windows.Handle) {
	_, _, _ = procChipInvalidate.Call(uintptr(hwnd), 0, 1)
}

func chipDPI(taskbar uintptr) uint32 {
	if dpi, _, _ := procChipGetDpi.Call(taskbar); dpi >= 96 {
		return uint32(dpi)
	}
	if dpi, _, _ := procChipGetDpi.Call(); dpi >= 96 {
		return uint32(dpi)
	}
	return 96
}

func chipProcedure(hwnd windows.Handle, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case 0x000f: // WM_PAINT
		chipPaint(hwnd)
		return 0
	case 0x0005: // WM_SIZE
		chipInvalidate(hwnd)
		return 0
	case 0x0113: // WM_TIMER
		switch wparam {
		case chipPlacementTimer: // 跟着任务栏走；Explorer 重启后父窗口没了就重建
			chipEnsure()
			chipPlace()
		case chipAnimationTimer:
			chipInvalidate(hwnd)
		}
		return 0
	case 0x0200: // WM_MOUSEMOVE
		chipState.Lock()
		hover := chipState.hover
		chipState.hover = true
		chipState.Unlock()
		if !hover {
			track := chipTrackMouse{Size: uint32(unsafe.Sizeof(chipTrackMouse{})), Flags: 0x00000002, Hwnd: hwnd} // TME_LEAVE
			_, _, _ = procChipTrackMouse.Call(uintptr(unsafe.Pointer(&track)))
			chipInvalidate(hwnd)
		}
		return 0
	case 0x02A3: // WM_MOUSELEAVE
		chipState.Lock()
		chipState.hover = false
		chipState.Unlock()
		chipInvalidate(hwnd)
		return 0
	case 0x0202: // WM_LBUTTONUP：单击开助理气泡（Nova 单击 → assistant）。
		// 有 thread 直接进那条牛马会话，没有就退回 BOT 会话列表页。
		// 放到别的 goroutine：蝴蝶是任务栏的子窗口，这里阻塞（拉起进程）会连着 Explorer 一起卡。
		chipState.Lock()
		thread := chipState.thread
		chipState.Unlock()
		go butterflyOpenThread(thread)
		return 0
	case 0x0203: // WM_LBUTTONDBLCLK：双击直达当前那条会话（Nova open_thread）。
		chipState.Lock()
		thread := chipState.thread
		chipState.Unlock()
		go butterflyOpenThread(thread)
		return 0
	case 0x0002: // WM_DESTROY
		return 0
	}
	result, _, _ := procChipDefProc.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
	return result
}

type chipPaintStruct struct {
	Hdc       windows.Handle
	Erase     int32
	Rect      appuseWinRect
	Restore   int32
	IncUpdate int32
	Reserved  [32]byte
}

// chipPaint 处理 WM_PAINT：BeginPaint 拿到的 DC 交给绘制函数，画完 EndPaint。
func chipPaint(hwnd windows.Handle) {
	var paint chipPaintStruct
	hdc, _, _ := procChipBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return
	}
	chipPaintHdc(hwnd, hdc)
	_, _, _ = procChipEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&paint)))
}

// ───────────────────────── 外观：与 Nova 同一套几何与配色 ─────────────────────────

type chipPalette struct {
	Background, Border, Text, Muted uint32
}

// rgb 与 Nova 一样按 COLORREF 组装（0x00BBGGRR）。
func chipRGB(r, g, b uint32) uint32 { return r | (g << 8) | (b << 16) }

// chipPaletteOf 与 Nova palette() 一致：浅色任务栏是白卡片，深色是近黑。
func chipPaletteOf(light, hover bool) chipPalette {
	if light {
		if hover {
			return chipPalette{Background: chipRGB(240, 240, 242), Border: chipRGB(222, 222, 226), Text: chipRGB(26, 26, 26), Muted: chipRGB(96, 96, 96)}
		}
		return chipPalette{Background: chipRGB(252, 252, 252), Border: chipRGB(222, 222, 226), Text: chipRGB(26, 26, 26), Muted: chipRGB(96, 96, 96)}
	}
	if hover {
		return chipPalette{Background: chipRGB(40, 40, 44), Border: chipRGB(58, 58, 64), Text: chipRGB(245, 245, 247), Muted: chipRGB(152, 152, 160)}
	}
	return chipPalette{Background: chipRGB(16, 16, 18), Border: chipRGB(58, 58, 64), Text: chipRGB(245, 245, 247), Muted: chipRGB(152, 152, 160)}
}

// chipSignal 是状态色：与 Nova signal() 的 Windows 部分一一对应（含 Done/Error）。
func chipSignal(light bool, kind chipKind) uint32 {
	if light {
		switch kind {
		case chipRunning:
			return chipRGB(0, 95, 184)
		case chipWaiting:
			return chipRGB(157, 93, 0)
		case chipDone:
			return chipRGB(15, 123, 15)
		case chipError:
			return chipRGB(196, 43, 28)
		default:
			return chipRGB(112, 112, 112)
		}
	}
	switch kind {
	case chipRunning:
		return chipRGB(10, 132, 255)
	case chipWaiting:
		return chipRGB(255, 159, 10)
	case chipDone:
		return chipRGB(48, 209, 88)
	case chipError:
		return chipRGB(255, 69, 58)
	default:
		return chipRGB(142, 142, 147)
	}
}

// chipMix GDI 没有 alpha：手工混色，与 Nova mix() 同式。
func chipMix(a, b uint32, t float64) uint32 {
	channel := func(shift uint) uint32 {
		x, y := float64((a>>shift)&255), float64((b>>shift)&255)
		v := math.Round(x + (y-x)*t)
		if v < 0 {
			v = 0
		}
		if v > 255 {
			v = 255
		}
		return uint32(v) << shift
	}
	return channel(0) | channel(8) | channel(16)
}

func chipDot(dc uintptr, x, y, r int32, color uint32) {
	chipEllipse(dc, x-r, y-r, x+r, y+r, color)
}

func chipEllipse(dc uintptr, left, top, right, bottom int32, color uint32) {
	brush, _, _ := procChipBrush.Call(uintptr(color))
	oldBrush, _, _ := procChipSelect.Call(dc, brush)
	nullPen, _, _ := procChipStock.Call(8) // NULL_PEN
	oldPen, _, _ := procChipSelect.Call(dc, nullPen)
	_, _, _ = procChipEllipse.Call(dc, uintptr(left), uintptr(top), uintptr(right+1), uintptr(bottom+1))
	_, _, _ = procChipSelect.Call(dc, oldPen)
	_, _, _ = procChipSelect.Call(dc, oldBrush)
	_, _, _ = procChipDelete.Call(brush)
}

// 三次贝塞尔轮廓：扫掠前翅 + 较小的波状后翅，不是镜像的图标瓣。
var chipForewing = [][2]float64{
	{0.3, 1.0}, {1.1, 3.2}, {4.7, 6.4}, {6.9, 5.8},
	{8.0, 5.5}, {6.7, 2.2}, {6.2, 0.9},
	{5.0, -0.4}, {2.1, -0.5}, {0.35, 0.1},
	{0.15, 0.35}, {0.15, 0.75}, {0.3, 1.0},
}

var chipHindwing = [][2]float64{
	{0.25, 0.65}, {2.7, 1.1}, {5.8, 1.0}, {5.7, -1.6},
	{5.6, -2.1}, {5.2, -2.5}, {4.9, -2.5},
	{4.8, -3.1}, {4.3, -3.6}, {3.8, -3.5},
	{3.3, -4.4}, {2.2, -4.4}, {1.7, -3.7},
	{0.9, -2.9}, {0.35, -1.0}, {0.25, 0.65},
}

type chipPose struct {
	Phase  float64
	Effort float64
	Yaw    float64
	Bank   float64
	Drift  float64
	Lift   float64
	Scale  float64
	Flying bool
}

func chipPoseAt(t float64, flying, waiting bool) chipPose {
	const fracPi4 = math.Pi / 4
	if !flying {
		return chipPose{Phase: 0.8, Effort: 0.65, Yaw: fracPi4, Bank: -0.22, Drift: 0, Lift: 0, Scale: 1.15}
	}
	// 一段偶发的滑翔；连续相位调制避免机械式循环。
	glide := math.Max(0, math.Min(1, (math.Sin(t*1.43)-0.72)/0.28))
	effort := 1 - 0.9*glide*glide*(3-2*glide)
	// Running/Waiting 共用一条拍翅时钟；等待只是收窄飞行路径。
	phase := t*2*math.Pi*1.65 + 0.22*math.Sin(t*1.7)
	wander := 1.0
	if waiting {
		wander = 0.9
	}
	turn := t * 1.45
	return chipPose{
		Phase: phase, Effort: effort, Flying: true,
		Yaw:   fracPi4 + 0.13*math.Sin(turn),
		Bank:  -0.22 + 0.16*math.Cos(turn) + 0.055*effort*math.Sin(phase-0.8),
		Drift: wander * (1.8*math.Sin(turn) + 0.30*math.Sin(t*0.62)),
		// 让主体先飞出几像素再让镜头跟上；转弯时带侧倾。
		Lift:  wander*1.2*math.Sin(t*2.1) + 0.42*effort*math.Sin(phase-1.1),
		Scale: 1.10 + 0.045*math.Sin(t*0.83),
	}
}

func (p chipPose) project(x, y, z float64) (float64, float64, float64) {
	sy, cy := math.Sincos(p.Yaw)
	// 更高的四分之三机位能同时露出两侧翅面，而不是一条边。
	se, ce := math.Sincos(0.82)
	depth := (x*sy-y*cy)*ce + z*se
	perspective := p.Scale * 42 / (42 - depth)
	u, v := x*cy+y*sy, (x*sy-y*cy)*se-z*ce
	sb, cb := math.Sincos(p.Bank)
	return (u*cb-v*sb)*perspective + p.Drift, (u*sb+v*cb)*perspective + p.Lift, depth
}

// wing 给出翅面某一点的三维位置：翅尖/后缘比根部滞后，近翅与远翅不同步。
func (p chipPose) wing(span, y, side float64) (float64, float64, float64) {
	phase := p.Phase - span*0.028 - side*0.055
	angle := 0.18 + p.Effort*(0.94*math.Sin(phase)+0.16*math.Sin(2*phase)+math.Max(1.5-y, 0)*0.022*math.Cos(phase))
	return p.project(side*span*math.Cos(angle), y, span*math.Sin(angle))
}

func chipPath(dc uintptr, points []chipPoint, color uint32) {
	if len(points) < 4 {
		return
	}
	brush, _, _ := procChipBrush.Call(uintptr(color))
	old, _, _ := procChipSelect.Call(dc, brush)
	_, _, _ = procChipBeginPath.Call(dc)
	_, _, _ = procChipMoveTo.Call(dc, uintptr(points[0].X), uintptr(points[0].Y), 0)
	_, _, _ = procChipBezier.Call(dc, uintptr(unsafe.Pointer(&points[1])), uintptr(len(points)-1))
	_, _, _ = procChipCloseFig.Call(dc)
	_, _, _ = procChipEndPath.Call(dc)
	_, _, _ = procChipFillPath.Call(dc)
	_, _, _ = procChipSelect.Call(dc, old)
	_, _, _ = procChipDelete.Call(brush)
}

func chipStroke(dc uintptr, points []chipPoint, width int32, color uint32) {
	if len(points) < 2 || width < 1 {
		return
	}
	pen, _, _ := procChipPen.Call(0, uintptr(width), uintptr(color)) // PS_SOLID
	old, _, _ := procChipSelect.Call(dc, pen)
	_, _, _ = procChipStroke.Call(dc, uintptr(unsafe.Pointer(&points[0])), uintptr(len(points)))
	_, _, _ = procChipSelect.Call(dc, old)
	_, _, _ = procChipDelete.Call(pen)
}

// chipButterflyFrame 画一帧蝴蝶：光晕/翅面/翅脉与身体，层的顺序按深度排。
func chipButterflyFrame(dc uintptr, cx, cy int32, unit float64, pose chipPose, accent, background, ink uint32, highContrast bool) {
	at := func(x, y, z float64) chipPoint {
		return chipPoint{X: cx + int32(math.Round(x*unit)), Y: cy + int32(math.Round(y*unit))}
	}
	rim := accent
	if !highContrast {
		rim = chipMix(accent, chipRGB(6, 15, 26), 0.78)
	}
	if pose.Flying && !highContrast {
		// 运动翅上极淡的短快门拖影；身体与计数器保持锐利。
		shutter := pose
		shutter.Phase = pose.Phase - 0.28
		fade := 1 - 0.13*pose.Effort*math.Abs(math.Cos(pose.Phase))
		for _, side := range []float64{-1, 1} {
			for _, shape := range [][][2]float64{chipHindwing, chipForewing} {
				points := make([]chipPoint, len(shape))
				for i, p := range shape {
					points[i] = at(shutter.wing(p[0], p[1], side))
				}
				chipPath(dc, points, chipMix(accent, background, fade))
			}
		}
	}
	// ponytail: 固定 45° 机位下整翅排序就够；要绕行镜头时再改成带深度测试的网格。
	sides := []float64{-1, 1}
	depth := func(side float64) float64 {
		_, _, z := pose.wing(4, 0.5, side)
		return z
	}
	if depth(sides[0]) > depth(sides[1]) {
		sides[0], sides[1] = sides[1], sides[0]
	}
	body := rim
	if highContrast {
		body = background
	}
	drawBody := func() {
		line := func(pts [][3]float64, width float64, color uint32) {
			points := make([]chipPoint, len(pts))
			for i, p := range pts {
				x, y, z := pose.project(p[0], p[1], p[2])
				points[i] = at(x, y, z)
			}
			w := int32(math.Round(unit * width))
			if w < 1 {
				w = 1
			}
			chipStroke(dc, points, w, color)
		}
		// 逐渐收细的腹部、胸部、头部与两根细棒状触角，都沿飞行轴。
		line([][3]float64{{0, -4.1, 0.2}, {0, -2.3, 0.35}, {0, 1.8, 0.35}}, 0.8, body)
		for _, seg := range [][2]float64{{1.4, 0.63}, {2.6, 0.48}} {
			p := at(pose.project(0, seg[0], 0.4))
			r := int32(math.Round(unit * seg[1]))
			if r < 1 {
				r = 1
			}
			chipDot(dc, p.X, p.Y, r, body)
		}
		line([][3]float64{{-0.15, -2.8, 0.65}, {-0.15, 0.3, 0.7}, {-0.15, 1.8, 0.8}}, 0.22, chipMix(accent, ink, 0.48))
		for _, side := range []float64{-1, 1} {
			antenna := chipMix(accent, ink, 0.32)
			if highContrast {
				antenna = accent
			}
			line([][3]float64{{side * 0.15, 2.9, 0.4}, {side * 0.50, 3.8, 0.65}, {side * 0.85, 4.25, 0.6}}, 0.18, antenna)
			tip := at(pose.project(side*0.85, 4.25, 0.6))
			r := int32(math.Round(unit * 0.14))
			if r < 1 {
				r = 1
			}
			chipDot(dc, tip.X, tip.Y, r, accent)
		}
	}
	veins := [][][2]float64{
		{{5.2, -1.6}, {4.4, -2.6}, {2.8, -3.8}},
		{{6.8, 5.45}, {6.6, 4.0}, {6.0, 2.1}},
	}
	for layer, side := range sides {
		if layer == 1 {
			drawBody() // 近翅挡住胸部，而不是反过来。
		}
		for index, shape := range [][][2]float64{chipHindwing, chipForewing} {
			light := 0.22 + 0.22*math.Abs(math.Cos(pose.Phase-0.4))*pose.Effort
			for _, inset := range [][2]float64{{1.0, -1}, {0.90, 0}, {0.76, light * 0.65}, {0.56, light}} {
				color := accent
				if !highContrast {
					if inset[1] < 0 {
						color = rim
					} else {
						blue := chipMix(accent, chipRGB(208, 242, 250), inset[1])
						t := 0.0
						if layer == 0 {
							t = 0.28
						}
						color = chipMix(blue, rim, t)
					}
				}
				points := make([]chipPoint, len(shape))
				for i, p := range shape {
					points[i] = at(pose.wing(p[0]*inset[0], 0.7+(p[1]-0.7)*(0.5+inset[0]*0.5), side))
				}
				chipPath(dc, points, color)
				if highContrast {
					break
				}
			}
			if highContrast {
				continue
			}
			for _, vein := range veins[index] {
				curve := [][2]float64{{0.4, 0.7}, {vein[0] * 0.52, vein[1]*0.48 + 0.36}, {vein[0] * 0.94, vein[1] * 0.94}}
				points := make([]chipPoint, len(curve))
				for i, p := range curve {
					points[i] = at(pose.wing(p[0], p[1], side))
				}
				w := int32(math.Round(unit * 0.16))
				if w < 1 {
					w = 1
				}
				chipStroke(dc, points, w, chipMix(accent, rim, 0.58))
				spot := at(pose.wing(vein[0]*0.99, vein[1], side))
				chipDot(dc, spot.X, spot.Y, w, chipMix(accent, ink, 0.55))
			}
		}
	}
}

// chipButterfly 只对蝴蝶做 4× 超采样，再缩回原位：胶囊与文字保持 ClearType 的清晰度。
func chipButterfly(dc uintptr, cx, cy int32, unit float64, pose chipPose, accent, background, ink uint32, highContrast bool) {
	width := int32(math.Max(1, math.Round(28*unit)))
	height := int32(math.Max(1, math.Round(26*unit)))
	buffer, _, _ := procChipMemDC.Call(dc)
	bitmap, _, _ := procChipMemBitmap.Call(dc, uintptr(width*4), uintptr(height*4))
	if buffer == 0 || bitmap == 0 {
		if bitmap != 0 {
			_, _, _ = procChipDelete.Call(bitmap)
		}
		if buffer != 0 {
			_, _, _ = procChipDeleteDC.Call(buffer)
		}
		chipButterflyFrame(dc, cx, cy, unit, pose, accent, background, ink, highContrast)
		return
	}
	oldBitmap, _, _ := procChipSelect.Call(buffer, bitmap)
	// 镜头略微盖住圆角：底下保留胶囊边框。
	const srcCopy = 0x00CC0020
	_, _, _ = procChipStretch.Call(buffer, 0, 0, uintptr(width*4), uintptr(height*4), dc,
		uintptr(cx-width/2), uintptr(cy-height/2), uintptr(width), uintptr(height), srcCopy)
	chipButterflyFrame(buffer, width*2, height*2, unit*4, pose, accent, background, ink, highContrast)
	oldMode, _, _ := procChipBlitMode.Call(dc, 4) // HALFTONE
	var origin chipPoint
	_, _, _ = procChipBrushOrg.Call(dc, 0, 0, uintptr(unsafe.Pointer(&origin)))
	_, _, _ = procChipStretch.Call(dc, uintptr(cx-width/2), uintptr(cy-height/2), uintptr(width), uintptr(height),
		buffer, 0, 0, uintptr(width*4), uintptr(height*4), srcCopy)
	_, _, _ = procChipBrushOrg.Call(dc, uintptr(origin.X), uintptr(origin.Y), 0)
	_, _, _ = procChipBlitMode.Call(dc, oldMode)
	_, _, _ = procChipSelect.Call(buffer, oldBitmap)
	_, _, _ = procChipDelete.Call(bitmap)
	_, _, _ = procChipDeleteDC.Call(buffer)
}

// chipFonts 按 DPI 缓存两套字体（正文与次要信息），与 Nova 的 px(12)/px(11) 一致。
func chipFonts(dpi uint32) (windows.Handle, windows.Handle) {
	chipState.Lock()
	defer chipState.Unlock()
	if chipState.fontDPI != dpi || chipState.font == 0 {
		for _, handle := range []windows.Handle{chipState.font, chipState.small} {
			if handle != 0 {
				_, _, _ = procChipDelete.Call(uintptr(handle))
			}
		}
		face := butterflyUTF16("Segoe UI")
		create := func(points int32) windows.Handle {
			// DEFAULT_CHARSET + CLEARTYPE_QUALITY + FF_DONTCARE
			handle, _, _ := procChipFont.Call(uintptr(-chipScale(points, dpi)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(face)))
			return windows.Handle(handle)
		}
		chipState.font, chipState.small = create(12), create(11)
		chipState.fontDPI = dpi
	}
	return chipState.font, chipState.small
}

// chipKindLabel 是胶囊上的兜底文字，与 Nova 的措辞保持一致；服务端给了 text 时优先用 text。
func chipKindLabel(kind chipKind) string {
	switch kind {
	case chipRunning:
		return "剑来 · 正在操作"
	case chipWaiting:
		return "等待你确认"
	case chipDone:
		return "已完成"
	case chipError:
		return "出了问题"
	default:
		return "空闲"
	}
}

func chipCursorOn(hwnd windows.Handle) bool {
	var point chipPoint
	if ok, _, _ := procChipCursorPos.Call(uintptr(unsafe.Pointer(&point))); ok == 0 {
		return false
	}
	// POINT 是 8 字节按值传参：x 在低 32 位、y 在高 32 位。
	packed := uintptr(uint32(point.X)) | uintptr(uint32(point.Y))<<32
	hit, _, _ := procChipWindowAt.Call(packed)
	return hit == uintptr(hwnd)
}

// chipPaintHdc 画一整只胶囊：底色/描边、蝴蝶（或状态圆点）、状态文字。
func chipPaintHdc(hwnd windows.Handle, hdc uintptr) {
	chipState.Lock()
	width, height, light, kind, dpi := chipState.width, chipState.height, chipState.light, chipState.kind, chipState.dpi
	label := chipState.text
	trailing := chipState.trailing
	font, small := chipState.font, chipState.small
	chipState.Unlock()
	client := appuseWinRect{}
	_, _, _ = procChipClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&client)))
	if client.Right > 0 && client.Bottom > 0 {
		width, height = client.Right, client.Bottom
	}
	if width <= 0 || height <= 0 {
		return
	}
	if dpi < 96 {
		dpi = 96
	}
	font, small = chipFonts(dpi)
	hover := chipCursorOn(hwnd)
	colors := chipPaletteOf(light, hover)
	accent := chipSignal(light, kind)
	scale := func(n int32) int32 { return chipScale(n, dpi) }

	// 先画到内存位图再整体贴回：状态切换/动画时不会闪出灰底。
	buffer, _, _ := procChipMemDC.Call(hdc)
	bitmap, _, _ := procChipMemBitmap.Call(hdc, uintptr(width), uintptr(height))
	buffered := buffer != 0 && bitmap != 0
	target := hdc
	var oldBitmap uintptr
	if buffered {
		target = buffer
		oldBitmap, _, _ = procChipSelect.Call(buffer, bitmap)
	}
	brush, _, _ := procChipBrush.Call(uintptr(colors.Background))
	pen, _, _ := procChipPen.Call(0, uintptr(max32(1, scale(1))), uintptr(colors.Border))
	// 整个矩形先铺底色（与 Nova 一致）：分层子窗口没画到的地方是不透明的黑，圆角外也必须铺满。
	rect := appuseWinRect{Right: width, Bottom: height}
	_, _, _ = procChipFillRect.Call(target, uintptr(unsafe.Pointer(&rect)), brush)
	oldBrush, _, _ := procChipSelect.Call(target, brush)
	oldPen, _, _ := procChipSelect.Call(target, pen)
	_, _, _ = procChipRoundRect.Call(target, 0, 0, uintptr(width), uintptr(height), uintptr(height), uintptr(height))
	_, _, _ = procChipSelect.Call(target, oldPen)
	_, _, _ = procChipSelect.Call(target, oldBrush)
	_, _, _ = procChipDelete.Call(pen)
	_, _, _ = procChipDelete.Call(brush)

	// 蝴蝶镜头留在前导槽位里：计数与点击区域不随动画移动。
	cx := scale(17)
	cy := height / 2
	if kind == chipDone || kind == chipError {
		// 结论态画状态圆点（Nova paint_chip 的 Done/Error：绿勾/红叹号），不画飞蝶。
		r := max32(3, scale(5))
		chipDot(target, cx, cy, r, accent)
	} else {
		unit := math.Min(float64(dpi)/96, float64(max32(1, height-scale(2)))/26)
		pose := chipPoseAt(time.Since(chipEpoch).Seconds(), kind != chipIdle, kind == chipWaiting)
		chipButterfly(target, cx, cy, unit, pose, accent, colors.Background, colors.Text, false)
	}

	_, _, _ = procChipBkMode.Call(target, 1) // TRANSPARENT
	// 只有够宽时才写字：窄到 34dp 就只剩图标，而不是留一个孤零零的省略号。
	if width >= scale(chipIconWidth+30) {
		if label == "" {
			label = chipKindLabel(kind)
		}
		text := butterflyUTF16(label)
		_, _, _ = procChipTextColor.Call(target, uintptr(colors.Text))
		if font != 0 {
			_, _, _ = procChipSelect.Call(target, uintptr(font))
		}
		area := appuseWinRect{Left: scale(32), Top: 0, Right: width - scale(12), Bottom: height}
		if area.Right < area.Left {
			area.Right = area.Left
		}
		_, _, _ = procChipText.Call(target, uintptr(unsafe.Pointer(text)), ^uintptr(0), uintptr(unsafe.Pointer(&area)),
			chipDTSingleLine|chipDTVCenter|chipDTEndEllipsis|chipDTNoPrefix)
		// trailing 徽标（已 12 分/3 分钟前）画在胶囊右上角，小字灰调。
		if trailing != "" && small != 0 {
			tail := butterflyUTF16(trailing)
			_, _, _ = procChipTextColor.Call(target, uintptr(colors.Muted))
			_, _, _ = procChipSelect.Call(target, uintptr(small))
			var extent chipSize
			_, _, _ = procChipTextExt.Call(target, uintptr(unsafe.Pointer(tail)), ^uintptr(0), uintptr(unsafe.Pointer(&extent)))
			tailArea := appuseWinRect{Left: width - extent.CX - scale(8), Top: 0, Right: width - scale(8), Bottom: height}
			_, _, _ = procChipText.Call(target, uintptr(unsafe.Pointer(tail)), ^uintptr(0), uintptr(unsafe.Pointer(&tailArea)),
				chipDTSingleLine|chipDTVCenter|chipDTRight|chipDTNoPrefix)
		}
	}
	if buffered {
		var clientRect appuseWinRect
		_, _, _ = procChipClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&clientRect)))
		const srcCopy = 0x00CC0020
		_, _, _ = procChipStretch.Call(hdc, 0, 0, uintptr(clientRect.Right), uintptr(clientRect.Bottom), buffer, 0, 0, uintptr(clientRect.Right), uintptr(clientRect.Bottom), srcCopy)
		_, _, _ = procChipSelect.Call(buffer, oldBitmap)
	}
	if bitmap != 0 {
		_, _, _ = procChipDelete.Call(bitmap)
	}
	if buffer != 0 {
		_, _, _ = procChipDeleteDC.Call(buffer)
	}
	_ = small
}

func max32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}
