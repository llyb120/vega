//go:build windows

package main

// 光效层：剑来接手桌面时，屏幕边缘一圈缓慢的呼吸光 + 剑形系统指针（仅 Windows，与 Nova 一致）。
//
// 与 Nova 的 agent_glow 对齐的要点：
//   - 多屏拼接成一块覆盖整个虚拟桌面的分层窗口，只画边框，中间完全透明；
//   - 鼠标穿透 + 不可激活 + TOOLWINDOW（不进任务栏/Alt+Tab）；
//   - 用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) 把它排除在所有截图之外：
//     模型不会截到自己的光效，观察不被污染；系统不支持时干脆不显示，绝不降级成“截得到”；
//   - 只在真有会话操作桌面时亮（由输入租约驱动），空闲 60 秒自动熄灭；
//   - Esc 由常驻低级键盘钩子监听，只认物理按键，注入的 Esc 不算。

import (
	"math"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	glowClass = "VegaAgentGlow"
	glowTimer = 1
	// 按住桌面的会话结束了还在跑、但这么久没再碰桌面也收起。
	glowIdleCap = 60 * time.Second
	// 光效亮着时用户亲手按下 Esc（毫秒，0 为没有）。
	glowTick = 16
)

var (
	glowUser32 = windows.NewLazySystemDLL("user32.dll")
	glowGDI32  = windows.NewLazySystemDLL("gdi32.dll")

	procGlowRegister  = glowUser32.NewProc("RegisterClassExW")
	procGlowCreate    = glowUser32.NewProc("CreateWindowExW")
	procGlowDefProc   = glowUser32.NewProc("DefWindowProcW")
	procGlowGetMsg    = glowUser32.NewProc("GetMessageW")
	procGlowTrans     = glowUser32.NewProc("TranslateMessage")
	procGlowDispatch  = glowUser32.NewProc("DispatchMessageW")
	procGlowTimer     = glowUser32.NewProc("SetTimer")
	procGlowUntimer   = glowUser32.NewProc("KillTimer")
	procGlowBegin     = glowUser32.NewProc("BeginPaint")
	procGlowEnd       = glowUser32.NewProc("EndPaint")
	procGlowShow      = glowUser32.NewProc("ShowWindow")
	procGlowPlace     = glowUser32.NewProc("SetWindowPos")
	procGlowInvalid   = glowUser32.NewProc("InvalidateRect")
	procGlowAffinity  = glowUser32.NewProc("SetWindowDisplayAffinity")
	procGlowGetDC     = glowUser32.NewProc("GetDC")
	procGlowRelease   = glowUser32.NewProc("ReleaseDC")
	procGlowModule    = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procGlowPost      = glowUser32.NewProc("PostMessageW")
	procGlowMonitors  = glowUser32.NewProc("EnumDisplayMonitors")
	procGlowMonitorIn = glowUser32.NewProc("GetMonitorInfoW")
	procGlowHook      = glowUser32.NewProc("SetWindowsHookExW")
	procGlowUnhook    = glowUser32.NewProc("UnhookWindowsHookEx")
	procGlowNextHook  = glowUser32.NewProc("CallNextHookEx")
	procGlowKeyState  = glowUser32.NewProc("GetAsyncKeyState")

	procGlowBrush     = glowGDI32.NewProc("CreateSolidBrush")
	procGlowDelete    = glowGDI32.NewProc("DeleteObject")
	procGlowRoundRect = glowGDI32.NewProc("RoundRect")
	procGlowPen       = glowGDI32.NewProc("CreatePen")
	procGlowSelect    = glowGDI32.NewProc("SelectObject")
	procGlowFillRect  = glowUser32.NewProc("FillRect")
)

type glowRect struct{ Left, Top, Right, Bottom int32 }

type glowWindowClass struct {
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

type glowMsg struct {
	Hwnd     windows.Handle
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       appuseWinPoint
	LPrivate uint32
}

type glowMonitor struct {
	Size    uint32
	Monitor glowRect
	Work    glowRect
	Flags   uint32
}

var glowState struct {
	sync.Mutex
	hwnd     windows.Handle
	started  bool
	visible  bool
	off      bool // 系统不支持把光效排除出截图：永久不再显示
	startedAt time.Time
	proc     uintptr
}

// glowEpoch 是呼吸的时钟；每次重新点亮换一代，让第一帧就从最暗开始。
var glowEpoch = time.Now()

const (
	glowMessageStart = 0x0400 + 11 // WM_APP + 11
	glowMessageStop  = 0x0400 + 12
)

// glowHold 在真正要操作桌面时点亮；整批输入期间保持。
func glowHold() {
	glowState.Lock()
	visible := glowState.visible
	glowState.visible = true
	glowState.startedAt = time.Now()
	hwnd := glowState.hwnd
	if !visible {
		glowEpoch = time.Now()
	}
	glowState.Unlock()
	if hwnd != 0 {
		_, _, _ = procGlowPost.Call(uintptr(hwnd), glowMessageStart, 0, 0)
	}
}

// glowRelease 在输入结束后收起；回合状态由 appuseInput 决定，不靠单次调用。
func glowRelease() {
	appuseInput.Lock()
	busy := appuseInput.holder != ""
	last := appuseInput.last
	appuseInput.Unlock()
	if busy || time.Since(last) < glowIdleCap {
		return
	}
	glowHide()
}

func glowHide() {
	glowState.Lock()
	visible := glowState.visible
	glowState.visible = false
	hwnd := glowState.hwnd
	glowState.Unlock()
	if !visible || hwnd == 0 {
		return
	}
	_, _, _ = procGlowPost.Call(uintptr(hwnd), glowMessageStop, 0, 0)
}

// glowStart 启动光效线程与常驻 Esc 钩子；重复调用无副作用。
func glowStart() {
	glowState.Lock()
	started := glowState.started
	glowState.started = true
	glowState.Unlock()
	if started {
		return
	}
	go glowThread()
	go glowEscHook()
}

func glowThread() {
	runtime.LockOSThread()
	instance, _, _ := procGlowModule.Call(0)
	glowState.Lock()
	if glowState.proc == 0 {
		glowState.proc = syscall.NewCallback(glowProcedure)
	}
	procedure := glowState.proc
	glowState.Unlock()
	class := glowWindowClass{
		Procedure: procedure,
		Instance:  windows.Handle(instance),
		ClassName: butterflyUTF16(glowClass),
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, _ := procGlowRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return
	}
	const (
		wsPopup    = 0x80000000
		exLayered  = 0x00080000
		exToolWnd  = 0x00000080
		exTopmost  = 0x00000008
		exTransp   = 0x00000020
		exNoActive = 0x08000000
	)
	hwnd, _, _ := procGlowCreate.Call(
		exLayered|exToolWnd|exTopmost|exTransp|exNoActive,
		uintptr(unsafe.Pointer(butterflyUTF16(glowClass))),
		0, wsPopup, 0, 0, 1, 1, 0, 0, instance, 0)
	if hwnd == 0 {
		return
	}
	glowState.Lock()
	glowState.hwnd = windows.Handle(hwnd)
	glowState.Unlock()
	var message glowMsg
	for {
		result, _, _ := procGlowGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = procGlowTrans.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procGlowDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func glowProcedure(hwnd windows.Handle, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case 0x000f: // WM_PAINT
		glowPaint(hwnd)
		return 0
	case glowMessageStart:
		glowShow(hwnd)
		return 0
	case glowMessageStop:
		_, _, _ = procGlowUntimer.Call(uintptr(hwnd), glowTimer)
		_, _, _ = procGlowShow.Call(uintptr(hwnd), 0) // SW_HIDE
		return 0
	case 0x0113: // WM_TIMER
		if !glowWanted() {
			_, _, _ = procGlowPost.Call(uintptr(hwnd), glowMessageStop, 0, 0)
			return 0
		}
		_, _, _ = procGlowInvalid.Call(uintptr(hwnd), 0, 0)
		return 0
	}
	result, _, _ := procGlowDefProc.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
	return result
}

// glowWanted 判断光效是否该亮着：有租约，或刚操作过桌面还在保持期。
func glowWanted() bool {
	glowState.Lock()
	if !glowState.visible {
		glowState.Unlock()
		return false
	}
	started := glowState.startedAt
	glowState.Unlock()
	busy, last := appuseInputActive()
	if busy {
		return true
	}
	if last.After(started) {
		return time.Since(last) < glowIdleCap
	}
	return time.Since(started) < glowIdleCap/4
}

// glowShow 铺满整个虚拟桌面并检查系统能否把这一层排除出截图。
func glowShow(hwnd windows.Handle) {
	glowState.Lock()
	off := glowState.off
	glowState.Unlock()
	if off {
		return
	}
	// WDA_EXCLUDEFROMCAPTURE = 0x00000011：不支持就别显示，绝不把光效截进观察。
	if ok, _, _ := procGlowAffinity.Call(uintptr(hwnd), 0x00000011); ok == 0 {
		glowState.Lock()
		glowState.off = true
		glowState.Unlock()
		return
	}
	left, top, right, bottom := glowVirtualDesktop()
	if right <= left || bottom <= top {
		return
	}
	const swpNoActivate = 0x0010
	const swpShowWindow = 0x0040
	const swpNoOwnerZ = 0x0200
	_, _, _ = procGlowPlace.Call(uintptr(hwnd), ^uintptr(0), uintptr(left), uintptr(top),
		uintptr(right-left), uintptr(bottom-top), swpNoActivate|swpShowWindow|swpNoOwnerZ)
	_, _, _ = procGlowTimer.Call(uintptr(hwnd), glowTimer, glowTick, 0)
	_, _, _ = procGlowInvalid.Call(uintptr(hwnd), 0, 0)
}

// glowVirtualDesktop 是所有显示器拼起来的矩形（含负坐标的副屏）。
func glowVirtualDesktop() (left, top, right, bottom int32) {
	left, top = math.MaxInt32, math.MaxInt32
	right, bottom = math.MinInt32, math.MinInt32
	glowSlot.Lock()
	if glowSlot.proc == 0 {
		glowSlot.proc = syscall.NewCallback(glowCollectMonitor)
	}
	proc := glowSlot.proc
	glowSlot.list = glowSlot.list[:0]
	glowSlot.Unlock()
	_, _, _ = procGlowMonitors.Call(0, 0, proc, 0)
	glowSlot.Lock()
	list := append([]glowRect{}, glowSlot.list...)
	glowSlot.Unlock()
	for _, rect := range list {
		if rect.Left < left {
			left = rect.Left
		}
		if rect.Top < top {
			top = rect.Top
		}
		if rect.Right > right {
			right = rect.Right
		}
		if rect.Bottom > bottom {
			bottom = rect.Bottom
		}
	}
	if right <= left || bottom <= top {
		return 0, 0, 0, 0
	}
	return left, top, right, bottom
}

var glowSlot struct {
	sync.Mutex
	list []glowRect
	proc uintptr
}

func glowCollectMonitor(handle, _ uintptr, _ *glowRect, _ uintptr) uintptr {
	info := glowMonitor{}
	info.Size = uint32(unsafe.Sizeof(info))
	if ok, _, _ := procGlowMonitorIn.Call(handle, uintptr(unsafe.Pointer(&info))); ok != 0 {
		glowSlot.list = append(glowSlot.list, info.Monitor)
	}
	return 1
}

// glowPaint 只画边框：中间必须保持透明，否则会挡住用户的画面。
func glowPaint(hwnd windows.Handle) {
	var paint struct {
		Hdc       windows.Handle
		Erase     int32
		Rect      glowRect
		Restore   int32
		IncUpdate int32
		Reserved  [32]byte
	}
	hdc, _, _ := procGlowBegin.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return
	}
	defer func() { _, _, _ = procGlowEnd.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&paint))) }()
	var client glowRect
	_, _, _ = procChipClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&client)))
	width, height := client.Right-client.Left, client.Bottom-client.Top
	if width <= 0 || height <= 0 {
		return
	}
	// 中间整块清成透明（分层窗口用黑色 + alpha 0 表示全透明）。
	const blackBrush = 0
	brush, _, _ := procGlowBrush.Call(blackBrush)
	_, _, _ = procGlowFillRect.Call(uintptr(hdc), uintptr(unsafe.Pointer(&client)), brush)
	_, _, _ = procGlowDelete.Call(brush)
	// 呼吸：一圈天蓝色渐变，最外沿稍浓。
	t := time.Since(glowEpoch).Seconds()
	intensity := 0.35 + 0.65*(0.5+0.5*math.Sin(t*math.Pi*2/2.6))
	const layers = 6
	for layer := 0; layer < layers; layer++ {
		inset := int32(layer) * 2
		if width-inset*2 <= 0 || height-inset*2 <= 0 {
			break
		}
		alpha := intensity * (1 - float64(layer)/float64(layers))
		color := glowBlend(56, 189, 248, alpha)
		pen, _, _ := procGlowPen.Call(0, 2, uintptr(color)) // PS_SOLID
		old, _, _ := procGlowSelect.Call(uintptr(hdc), pen)
		nullBrush, _, _ := procGlowBrush.Call(uintptr(0xFFFFFFFF)) // 只描边，不填充
		oldBrush, _, _ := procGlowSelect.Call(uintptr(hdc), nullBrush)
		_, _, _ = procGlowRoundRect.Call(uintptr(hdc), uintptr(inset), uintptr(inset),
			uintptr(width-inset), uintptr(height-inset), 18, 18)
		_, _, _ = procGlowSelect.Call(uintptr(hdc), oldBrush)
		_, _, _ = procGlowSelect.Call(uintptr(hdc), old)
		_, _, _ = procGlowDelete.Call(pen)
		_, _, _ = procGlowDelete.Call(nullBrush)
	}
}

// glowBlend 把颜色按 alpha 混到透明底上（分层窗口只支持 0/255 或 LWA_ALPHA，
// 这里用亮度近似代替透明度，保证不遮挡也能看见边缘）。
func glowBlend(r, g, b float64, alpha float64) uint32 {
	mix := func(v float64) uint32 {
		value := v * alpha
		if value < 0 {
			value = 0
		} else if value > 255 {
			value = 255
		}
		return uint32(value)
	}
	return mix(r) | mix(g)<<8 | mix(b)<<16
}

// glowEscHook 是常驻低级键盘钩子：只在光效亮着时处理用户亲手按的 Esc。
// 注入的键带 LLKHF_INJECTED，不算用户叫停。
func glowEscHook() {
	runtime.LockOSThread()
	glowHookState.Lock()
	if glowHookState.proc == 0 {
		glowHookState.proc = syscall.NewCallback(glowKeyboard)
	}
	proc := glowHookState.proc
	glowHookState.Unlock()
	instance, _, _ := procGlowModule.Call(0)
	const whKeyboardLL = 13
	hook, _, _ := procGlowHook.Call(whKeyboardLL, proc, instance, 0)
	if hook == 0 {
		return
	}
	defer func() { _, _, _ = procGlowUnhook.Call(hook) }()
	var message glowMsg
	for {
		result, _, _ := procGlowGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = procGlowTrans.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procGlowDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

var glowHookState struct {
	sync.Mutex
	proc uintptr
}

type glowKeyboardHook struct {
	VKCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

func glowKeyboard(code int32, wparam uintptr, event *glowKeyboardHook) uintptr {
	const (
		wmKeyDown     = 0x0100
		wmSysKeyDown  = 0x0104
		vkEscape      = 0x1B
		llkhfInjected = 0x10
		llkhfLowerIL  = 0x02
	)
	// 钩子回传的 lparam 就是 KBDLLHOOKSTRUCT 指针；按结构体指针接参数，只读不改。
	if code >= 0 && event != nil && (wparam == wmKeyDown || wparam == wmSysKeyDown) {
		// 只认物理键盘：没有注入标记、没有附加信息、扫描码就是 Esc 键本身。
		physical := event.Flags&(llkhfInjected|llkhfLowerIL) == 0 && event.DwExtraInfo == 0 && event.ScanCode == 0x01
		if event.VKCode == vkEscape && physical && glowLit() {
			appuseMarkEscaped()
			go appuseUserEscaped()
			return 1
		}
	}
	result, _, _ := procGlowNextHook.Call(0, uintptr(code), wparam, uintptr(unsafe.Pointer(event)))
	return result
}

// glowLit 报告光效此刻是否亮着（只有亮着时 Esc 才被当成叫停）。
func glowLit() bool {
	glowState.Lock()
	defer glowState.Unlock()
	return glowState.visible && !glowState.off
}

// appuseUserEscaped 由钩子调用：停掉正在用桌面的那个会话。
func appuseUserEscaped() {
	owner := appuseDesktopOwner()
	butterflyNotify("needs_review", "你按了 Esc 叫停操作电脑：本批剩余动作未执行，请核对屏幕上的实际结果")
	butterflyClearIfKind("running")
	if owner == "" {
		return
	}
	stopSessionFromClient(owner, "用户按 Esc 叫停了操作电脑")
}
