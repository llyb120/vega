//go:build windows

package main

// 任务栏上的蝴蝶：和 Nova 一样把一只小蝴蝶钉在任务栏里（跨进程子窗口挂在 Shell_TrayWnd 上），
// 启动就在，点一下打开面板里的 BOT 会话；有待核对/正在操作的提示时角上亮一个点。

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	butterflyChipClass = "VegaTaskbarButterfly"
	butterflyChipTitle = "Vega Butterfly"
	butterflyChipTick  = 1
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
	procChipClientRect  = chipUser32.NewProc("GetClientRect")
	procChipTrackMouse  = chipUser32.NewProc("TrackMouseEvent")
	procChipPost        = chipUser32.NewProc("PostMessageW")
	procChipInvalidate  = chipUser32.NewProc("InvalidateRect")
	procChipDestroy     = chipUser32.NewProc("DestroyWindow")
	procChipScreenPoint = chipUser32.NewProc("ScreenToClient")
	procChipGetDpi      = chipUser32.NewProc("GetDpiForSystem")
	procChipEnumChild   = chipUser32.NewProc("EnumChildWindows")
	procChipChild       = chipUser32.NewProc("GetWindow")
	procChipLayered     = chipUser32.NewProc("SetLayeredWindowAttributes")
	procChipTopWindow   = chipUser32.NewProc("GetTopWindow")
	procChipGetParent   = chipUser32.NewProc("GetParent")
	procChipVersion     = chipNtdll.NewProc("RtlGetVersion")

	procChipBrush     = chipGDI32.NewProc("CreateSolidBrush")
	procChipPen       = chipGDI32.NewProc("CreatePen")
	procChipSelect    = chipGDI32.NewProc("SelectObject")
	procChipDelete    = chipGDI32.NewProc("DeleteObject")
	procChipRoundRect = chipGDI32.NewProc("RoundRect")
	procChipEllipse   = chipGDI32.NewProc("Ellipse")
	procChipPolygon   = chipGDI32.NewProc("Polygon")
	procChipMoveTo    = chipGDI32.NewProc("MoveToEx")
	procChipLineTo    = chipGDI32.NewProc("LineTo")
)

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

var chipState struct {
	sync.Mutex
	hwnd    windows.Handle
	parent  windows.Handle
	started bool
	dpi     uint32
	light   bool
	hover   bool
	notice  string
	width   int32
	height  int32
	placedX int32
	placedY int32
	proc    uintptr
}

func chipScale(value int32, dpi uint32) int32 { return value * int32(dpi) / 96 }

// chipDebug 只在 VEGA_CHIP_DEBUG 下打印定位/创建失败的原因（任务栏子窗口失败时屏幕上看不到任何东西）。
func chipDebug(stage string, last error) {
	if os.Getenv("VEGA_CHIP_DEBUG") == "" {
		return
	}
	fmt.Fprintf(os.Stderr, "vega-local: 任务栏蝴蝶 %s: %v\n", stage, last)
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
}

// butterflyChipState 同步提示状态到任务栏蝴蝶：running 蓝点、needs_review 橙点、空为无点。
func butterflyChipState(kind string) {
	chipState.Lock()
	changed := chipState.notice != kind
	chipState.notice = kind
	hwnd := chipState.hwnd
	chipState.Unlock()
	if changed && hwnd != 0 {
		chipInvalidate(hwnd)
	}
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
	_, _, _ = procChipTimer.Call(uintptr(chipHwnd()), butterflyChipTick, 250, 0)
	for {
		result, _, _ := procChipGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = procChipTranslate.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procChipDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

type chipMsg struct {
	Hwnd     windows.Handle
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       appuseWinPoint
	LPrivate uint32
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
		_, _, _ = procChipTimer.Call(uintptr(chipHwnd()), butterflyChipTick, 250, 0)
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
	width := chipScale(44, dpi)
	height := chipScale(36, dpi)
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
	// 从右往左挪，直到整只蝴蝶都落在没有图标的空档里（OneDrive、其它客户端的蝴蝶都算挡位）。
	obstacles := chipObstacles(windows.Handle(taskbar), hwnd, trayLeft, dpi)
	x := right - width
	for x > bar.Left+width && chipBlocked(obstacles, appuseWinRect{Left: x, Top: y, Right: x + width, Bottom: y + height}) {
		x -= 4
	}
	if x <= bar.Left+width {
		x = right - width
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
	case 0x0113: // WM_TIMER：跟着任务栏走；Explorer 重启后父窗口没了就重建
		chipEnsure()
		chipPlace()
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
	case 0x0202: // WM_LBUTTONUP
		butterflyOpen()
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

// chipPaintHdc 画一个圆角胶囊：浅色任务栏上深色蝴蝶，深色任务栏上浅色蝴蝶；有提示时右上角点一个色点。
func chipPaintHdc(hwnd windows.Handle, hdc uintptr) {
	chipState.Lock()
	width, height, light, hover, notice, dpi := chipState.width, chipState.height, chipState.light, chipState.hover, chipState.notice, chipState.dpi
	chipState.Unlock()
	client := appuseWinRect{}
	_, _, _ = procChipClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&client)))
	if client.Right > 0 && client.Bottom > 0 {
		width, height = client.Right, client.Bottom
	}
	var background, wing, body uint32 = 0x001e1e1e, 0x00ff8ba7, 0x00f2eded
	if light {
		background, wing, body = 0x00f2f2f2, 0x00e75c6c, 0x00332b2b
	}
	if hover {
		if light {
			background = 0x00e2e2e2
		} else {
			background = 0x002d2d2d
		}
	}
	brush, _, _ := procChipBrush.Call(uintptr(background))
	previousBrush, _, _ := procChipSelect.Call(hdc, brush)
	nullPen, _, _ := procChipPen.Call(1, 1, 0) // PS_NULL
	previousPen, _, _ := procChipSelect.Call(hdc, nullPen)
	_, _, _ = procChipRoundRect.Call(hdc, 0, 0, uintptr(width), uintptr(height), uintptr(height), uintptr(height))

	cx, cy := int32(width)/2, int32(height)/2
	unit := int32(height) / 3
	if unit < 6 {
		unit = 6
	}
	// 把 12 份宽的设计缩放进 unit，蝴蝶才跟着任务栏高度缩放。
	point := func(dx, dy int32) appuseWinPoint {
		return appuseWinPoint{X: cx + dx*unit/12, Y: cy + dy*unit/12}
	}
	wingBrush, _, _ := procChipBrush.Call(uintptr(wing))
	_, _, _ = procChipSelect.Call(hdc, wingBrush)
	polygon := func(points ...appuseWinPoint) {
		_, _, _ = procChipPolygon.Call(hdc, uintptr(unsafe.Pointer(&points[0])), uintptr(len(points)))
	}
	// 上翅宽、下翅圆，中间一根细身子：小到 44×36 也认得出是蝴蝶。
	polygon(point(-1, -3), point(-5, -10), point(-9, -9), point(-12, -4), point(-11, 1), point(-6, 2), point(-2, 1))
	polygon(point(1, -3), point(5, -10), point(9, -9), point(12, -4), point(11, 1), point(6, 2), point(2, 1))
	polygon(point(-1, 2), point(-6, 5), point(-7, 10), point(-3, 11), point(-2, 5))
	polygon(point(1, 2), point(6, 5), point(7, 10), point(3, 11), point(2, 5))
	bodyBrush, _, _ := procChipBrush.Call(uintptr(body))
	_, _, _ = procChipSelect.Call(hdc, bodyBrush)
	_, _, _ = procChipRoundRect.Call(hdc, uintptr(cx-unit/8), uintptr(cy-unit+unit/4), uintptr(cx+unit/8+1), uintptr(cy+unit/2), 3, 3)
	bodyPen, _, _ := procChipPen.Call(0, 1, uintptr(body)) // PS_SOLID
	_, _, _ = procChipSelect.Call(hdc, bodyPen)
	antenna := func(dx int32) {
		_, _, _ = procChipMoveTo.Call(hdc, uintptr(cx+dx*unit/12/2), uintptr(cy-unit+unit/6))
		_, _, _ = procChipLineTo.Call(hdc, uintptr(cx+dx*unit/12), uintptr(cy-unit-unit/2))
	}
	antenna(-4)
	antenna(4)
	if notice != "" {
		color := uint32(0x00e16028) // 正在操作：蓝
		if notice == "needs_review" {
			color = 0x0000a5f5 // 待核对：橙
		}
		dot, _, _ := procChipBrush.Call(uintptr(color))
		_, _, _ = procChipSelect.Call(hdc, dot)
		radius := chipScale(3, dpi)
		if radius < 2 {
			radius = 2
		}
		dx, dy := int32(width)-chipScale(8, dpi), chipScale(8, dpi)
		_, _, _ = procChipEllipse.Call(hdc, uintptr(dx-radius), uintptr(dy-radius), uintptr(dx+radius), uintptr(dy+radius))
		_, _, _ = procChipDelete.Call(dot)
	}
	_, _, _ = procChipSelect.Call(hdc, previousBrush)
	_, _, _ = procChipSelect.Call(hdc, previousPen)
	for _, object := range []uintptr{brush, nullPen, wingBrush, bodyBrush, bodyPen} {
		_, _, _ = procChipDelete.Call(object)
	}
}
