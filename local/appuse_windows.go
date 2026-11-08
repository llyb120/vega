//go:build windows

package main

// appuse 的 Windows 实现：一次性进入物理像素坐标模式，窗口枚举、截图、指针与键盘都用同一套桌面坐标。

import (
	"encoding/binary"
	"fmt"
	"image"
	"strings"
	"sync"
	"unsafe"

	"github.com/kbinani/screenshot"
	"golang.org/x/sys/windows"
)

type appuseKey struct{ VK uint16 }

type appuseWinRect struct{ Left, Top, Right, Bottom int32 }

type appuseWinPoint struct{ X, Y int32 }

var (
	appuseUser32   = windows.NewLazySystemDLL("user32.dll")
	appuseKernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procDpiContext      = appuseUser32.NewProc("SetProcessDpiAwarenessContext")
	procDpiAware        = appuseUser32.NewProc("SetProcessDPIAware")
	procEnumWindows     = appuseUser32.NewProc("EnumWindows")
	procWindowVisible   = appuseUser32.NewProc("IsWindowVisible")
	procWindowIconic    = appuseUser32.NewProc("IsIconic")
	procWindowText      = appuseUser32.NewProc("GetWindowTextW")
	procWindowTextLen   = appuseUser32.NewProc("GetWindowTextLengthW")
	procClassName       = appuseUser32.NewProc("GetClassNameW")
	procWindowThreadPID = appuseUser32.NewProc("GetWindowThreadProcessId")
	procWindowRect      = appuseUser32.NewProc("GetWindowRect")
	procForeground      = appuseUser32.NewProc("GetForegroundWindow")
	procSetForeground   = appuseUser32.NewProc("SetForegroundWindow")
	procBringToTop      = appuseUser32.NewProc("BringWindowToTop")
	procShowWindow      = appuseUser32.NewProc("ShowWindow")
	procAttachInput     = appuseUser32.NewProc("AttachThreadInput")
	procGetCursorPos    = appuseUser32.NewProc("GetCursorPos")
	procSetCursorPos    = appuseUser32.NewProc("SetCursorPos")
	procSendInput       = appuseUser32.NewProc("SendInput")
	procMonitorOfWindow = appuseUser32.NewProc("MonitorFromWindow")
	procMonitorInfo     = appuseUser32.NewProc("GetMonitorInfoW")
	procSystemMetrics   = appuseUser32.NewProc("GetSystemMetrics")
	procCurrentThread   = appuseKernel32.NewProc("GetCurrentThreadId")
	procOpenProcess     = appuseKernel32.NewProc("OpenProcess")
	procProcessImage    = appuseKernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle     = appuseKernel32.NewProc("CloseHandle")
)

var appuseDPI sync.Once

// appuseInit 让后续所有枚举、截图、落点都在物理像素坐标里（阻塞线程池可能继承别的 DPI 上下文）。
func appuseInit() {
	appuseDPI.Do(func() {
		const perMonitorAwareV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
		if result, _, _ := procDpiContext.Call(perMonitorAwareV2); result != 0 {
			return
		}
		_, _, _ = procDpiAware.Call()
	})
}

func appuseMonitors() ([]appuseSurface, error) {
	count := screenshot.NumActiveDisplays()
	if count <= 0 {
		return nil, fmt.Errorf("没有可截图的显示器")
	}
	monitors := make([]appuseSurface, 0, count)
	for index := 0; index < count; index++ {
		bounds := screenshot.GetDisplayBounds(index)
		monitors = append(monitors, appuseSurface{
			ID: uint32(index), X: int32(bounds.Min.X), Y: int32(bounds.Min.Y),
			W: uint32(bounds.Dx()), H: uint32(bounds.Dy()),
		})
	}
	return monitors, nil
}

func appuseCaptureMonitor(surface appuseSurface) (*image.RGBA, error) {
	// 优先 DXGI（GPU 合成后的整帧）；任何失败都回退到 GDI，并保留原错误供诊断。
	if grab, err := dxgiGrab(surface); err == nil {
		return grab, nil
	}
	return gdiGrab(surface)
}

// gdiGrab 是 GDI BitBlt 抓屏：DXGI 不可用时的回退路径，也是自检的参照基准。
func gdiGrab(surface appuseSurface) (*image.RGBA, error) {
	bounds := image.Rect(int(surface.X), int(surface.Y), int(surface.X+int32(surface.W)), int(surface.Y+int32(surface.H)))
	grab, err := screenshot.CaptureRect(bounds)
	if err != nil {
		return nil, fmt.Errorf("截图失败：%w", err)
	}
	return grab, nil
}

func appuseListWindows() ([]appuseWindow, error) {
	monitors, _ := appuseMonitors()
	rows := []appuseWindow{}
	callback := windows.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if visible, _, _ := procWindowVisible.Call(hwnd); visible == 0 {
			return 1
		}
		title := appuseWindowText(uintptr(hwnd))
		if strings.TrimSpace(title) == "" {
			return 1
		}
		var rect appuseWinRect
		if ok, _, _ := procWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); ok == 0 {
			return 1
		}
		width, height := rect.Right-rect.Left, rect.Bottom-rect.Top
		if width <= 0 || height <= 0 {
			return 1
		}
		var pid uint32
		_, _, _ = procWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		minimized, _, _ := procWindowIconic.Call(hwnd)
		focused := uintptr(0)
		if fg, _, _ := procForeground.Call(); fg == hwnd {
			focused = 1
		}
		rows = append(rows, appuseWindow{
			ID: uint32(hwnd), PID: pid, App: appuseProcessName(pid), Title: title,
			X: rect.Left, Y: rect.Top, W: uint32(width), H: uint32(height),
			Monitor: appuseMonitorID(monitors, uintptr(hwnd)),
			Focused: focused == 1, Minimized: minimized != 0,
		})
		return 1
	})
	if result, _, err := procEnumWindows.Call(callback, 0); result == 0 {
		return nil, fmt.Errorf("无法枚举窗口：%v", err)
	}
	return rows, nil
}

func appuseWindowInfo(id uint32) (appuseWindow, error) {
	windows, err := appuseListWindows()
	if err != nil {
		return appuseWindow{}, err
	}
	for _, window := range windows {
		if window.ID == id {
			return window, nil
		}
	}
	return appuseWindow{}, fmt.Errorf("程序窗口已关闭，请重新 windows")
}

// appuseMonitorID 把窗口所在的显示器映射成本地列表里的那个（窗口跨屏时取最近的）。
func appuseMonitorID(monitors []appuseSurface, hwnd uintptr) uint32 {
	const monitorDefaultToNearest = 2
	handle, _, _ := procMonitorOfWindow.Call(hwnd, monitorDefaultToNearest)
	var info struct {
		Size    uint32
		Monitor appuseWinRect
		Work    appuseWinRect
		Flags   uint32
	}
	info.Size = uint32(unsafe.Sizeof(info))
	if handle != 0 {
		if ok, _, _ := procMonitorInfo.Call(handle, uintptr(unsafe.Pointer(&info))); ok != 0 {
			for _, monitor := range monitors {
				if int32(monitor.X) == info.Monitor.Left && int32(monitor.Y) == info.Monitor.Top &&
					int32(monitor.W) == info.Monitor.Right-info.Monitor.Left &&
					int32(monitor.H) == info.Monitor.Bottom-info.Monitor.Top {
					return monitor.ID
				}
			}
		}
	}
	return 0
}

func appuseWindowText(hwnd uintptr) string {
	length, _, _ := procWindowTextLen.Call(hwnd)
	if length == 0 {
		return ""
	}
	buffer := make([]uint16, length+1)
	procWindowText.Call(hwnd, uintptr(unsafe.Pointer(&buffer[0])), length+1)
	return windows.UTF16ToString(buffer)
}

// appuseProcessName 给出窗口所属进程的可执行文件名；取不到就退回窗口类名。
func appuseProcessName(pid uint32) string {
	if pid != 0 {
		const queryLimitedInformation = 0x1000
		handle, _, _ := procOpenProcess.Call(queryLimitedInformation, 0, uintptr(pid))
		if handle != 0 {
			defer procCloseHandle.Call(handle)
			buffer := make([]uint16, windows.MAX_PATH)
			size := uint32(len(buffer))
			if ok, _, _ := procProcessImage.Call(handle, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size))); ok != 0 {
				path := windows.UTF16ToString(buffer[:size])
				if index := strings.LastIndexAny(path, `\/`); index >= 0 {
					path = path[index+1:]
				}
				if path != "" {
					return path
				}
			}
		}
	}
	return ""
}

func appuseForegroundWindow() *uint32 {
	handle, _, _ := procForeground.Call()
	if handle == 0 {
		return nil
	}
	id := uint32(handle)
	return &id
}

func appuseActivate(id uint32) error {
	hwnd := uintptr(id)
	const swRestore = 9
	if minimized, _, _ := procWindowIconic.Call(hwnd); minimized != 0 {
		procShowWindow.Call(hwnd, swRestore)
	}
	if ok, _, _ := procSetForeground.Call(hwnd); ok != 0 {
		return nil
	}
	// 无人值守时前台锁会拒绝后台调用方：临时共享前台线程的输入队列再切，不注入按键。
	fg, _, _ := procForeground.Call()
	me, _, _ := procCurrentThread.Call()
	target, _, _ := procWindowThreadPID.Call(fg, 0)
	if fg != 0 && target != 0 && target != me {
		if attached, _, _ := procAttachInput.Call(me, target, 1); attached != 0 {
			procBringToTop.Call(hwnd)
			procSetForeground.Call(hwnd)
			procAttachInput.Call(me, target, 0)
		}
	}
	if current := appuseForegroundWindow(); current == nil || *current != id {
		return fmt.Errorf("系统未允许激活该窗口；请观察当前桌面，不要重复激活或发送按键")
	}
	return nil
}

func appuseCursor() (appusePoint, bool) {
	var point appuseWinPoint
	if ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&point))); ok == 0 {
		return appusePoint{}, false
	}
	return appusePoint{X: point.X, Y: point.Y}, true
}

func appuseSystemMetric(index int) int32 {
	value, _, _ := procSystemMetrics.Call(uintptr(index))
	return int32(int64(value))
}

// appuseVirtualDesk 把桌面像素换算成 VIRTUALDESK 归一化值（含负坐标的副屏）；向上取整，落回正好是那个像素。
func appuseVirtualDesk(position, origin, size int32) int32 {
	if size <= 0 {
		return 0
	}
	value := (int64(position)-int64(origin))*65536 + int64(size) - 1
	value = value / int64(size)
	if value < 0 {
		return 0
	}
	if value > 65535 {
		return 65535
	}
	return int32(value)
}

const appuseInputSize = 40

func appuseSend(inputs []byte, count int) error {
	if count == 0 {
		return nil
	}
	sent, _, err := procSendInput.Call(uintptr(count), uintptr(unsafe.Pointer(&inputs[0])), appuseInputSize)
	if int(sent) != count {
		return fmt.Errorf("系统拒绝注入输入：%v", err)
	}
	return nil
}

func appuseMouseInput(flags uint32, dx, dy, data int32) []byte {
	buffer := make([]byte, appuseInputSize)
	const inputMouse = 0
	binary.LittleEndian.PutUint32(buffer[0:], inputMouse)
	binary.LittleEndian.PutUint32(buffer[8:], uint32(dx))
	binary.LittleEndian.PutUint32(buffer[12:], uint32(dy))
	binary.LittleEndian.PutUint32(buffer[16:], uint32(data))
	binary.LittleEndian.PutUint32(buffer[20:], flags)
	return buffer
}

func appuseKeyInput(vk uint16, scan uint16, flags uint32) []byte {
	buffer := make([]byte, appuseInputSize)
	const inputKeyboard = 1
	binary.LittleEndian.PutUint32(buffer[0:], inputKeyboard)
	binary.LittleEndian.PutUint16(buffer[8:], vk)
	binary.LittleEndian.PutUint16(buffer[10:], scan)
	binary.LittleEndian.PutUint32(buffer[12:], flags)
	return buffer
}

func appuseMovePointer(x, y int32, inputEvent bool) error {
	if inputEvent {
		const (
			mouseMove   = 0x0001
			absolute    = 0x8000
			virtualDesk = 0x4000
			smXVirtual  = 76
			smYVirtual  = 77
			smCxVirtual = 78
			smCyVirtual = 79
		)
		dx := appuseVirtualDesk(x, appuseSystemMetric(smXVirtual), appuseSystemMetric(smCxVirtual))
		dy := appuseVirtualDesk(y, appuseSystemMetric(smYVirtual), appuseSystemMetric(smCyVirtual))
		if err := appuseSend(appuseMouseInput(mouseMove|absolute|virtualDesk, dx, dy, 0), 1); err != nil {
			return err
		}
	}
	if ok, _, err := procSetCursorPos.Call(uintptr(x), uintptr(y)); ok == 0 {
		return fmt.Errorf("无法移动指针：%v", err)
	}
	return nil
}

func appuseMouseButton(button string, down bool) error {
	flag := uint32(0)
	switch button {
	case "right":
		if down {
			flag = 0x0008
		} else {
			flag = 0x0010
		}
	case "middle":
		if down {
			flag = 0x0020
		} else {
			flag = 0x0040
		}
	default:
		if down {
			flag = 0x0002
		} else {
			flag = 0x0004
		}
	}
	return appuseSend(appuseMouseInput(flag, 0, 0, 0), 1)
}

func appuseClick(button string) error {
	// 一次成功的快速路径保持按下/抬起成对；失败也要抬起，但绝不重放。
	if err := appuseMouseButton(button, true); err != nil {
		_ = appuseMouseButton(button, false)
		return err
	}
	return appuseMouseButton(button, false)
}

func appuseWheel(axis string, delta int32) error {
	const (
		wheel     = 0x0800
		hwheel    = 0x1000
		wheelStep = 120
	)
	flag := uint32(wheel)
	if axis == "horizontal" {
		flag = hwheel
	}
	return appuseSend(appuseMouseInput(flag, 0, 0, delta*wheelStep), 1)
}

func appuseKeyPress(keys []appuseKey) error {
	for _, key := range keys {
		if err := appuseSend(appuseKeyInput(key.VK, 0, 0), 1); err != nil {
			return err
		}
	}
	return nil
}

func appuseKeyRelease(keys []appuseKey) error {
	const keyUp = 0x0002
	var failure error
	for index := len(keys) - 1; index >= 0; index-- {
		if err := appuseSend(appuseKeyInput(keys[index].VK, 0, keyUp), 1); err != nil && failure == nil {
			failure = err
		}
	}
	return failure
}

// appuseTypeText 用 KEYEVENTF_UNICODE 逐字符注入：不经过剪贴板，中文、emoji 都不受输入法影响。
func appuseTypeText(text string) error {
	const (
		keyUp   = 0x0002
		unicode = 0x0004
	)
	units := windows.StringToUTF16(text)
	batch := make([]byte, 0, appuseInputSize*len(units)*2)
	for _, unit := range units {
		if unit == 0 {
			continue
		}
		batch = append(batch, appuseKeyInput(0, unit, unicode)...)
		batch = append(batch, appuseKeyInput(0, unit, unicode|keyUp)...)
	}
	return appuseSend(batch, len(batch)/appuseInputSize)
}

var appuseKeyTable = map[string]uint16{
	"ctrl": 0x11, "control": 0x11, "alt": 0x12, "option": 0x12, "shift": 0x10,
	"meta": 0x5B, "super": 0x5B, "cmd": 0x5B, "win": 0x5B,
	"enter": 0x0D, "return": 0x0D, "tab": 0x09, "escape": 0x1B, "esc": 0x1B,
	"space": 0x20, "backspace": 0x08, "delete": 0x2E,
	"left": 0x25, "arrowleft": 0x25, "up": 0x26, "arrowup": 0x26,
	"right": 0x27, "arrowright": 0x27, "down": 0x28, "arrowdown": 0x28,
	"home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
}

func appuseKeyOf(name string) (appuseKey, error) {
	if vk, ok := appuseKeyTable[name]; ok {
		return appuseKey{VK: vk}, nil
	}
	if len(name) >= 2 && name[0] == 'f' {
		var number int
		if _, err := fmt.Sscanf(name[1:], "%d", &number); err == nil && number >= 1 && number <= 24 {
			return appuseKey{VK: uint16(0x6F + number)}, nil
		}
	}
	if len(name) == 1 {
		char := name[0]
		switch {
		case char >= 'a' && char <= 'z':
			return appuseKey{VK: uint16(char - 'a' + 'A')}, nil
		case char >= '0' && char <= '9':
			return appuseKey{VK: uint16(char)}, nil
		}
	}
	return appuseKey{}, fmt.Errorf("不支持的按键：%s", name)
}
