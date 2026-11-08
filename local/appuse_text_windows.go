//go:build windows

package main

// Windows 文本输入：整段粘贴一次，绝不逐字回放按键（与 Nova 的 jianlai/text_input.rs 一致）。
//
// 逐键输入会被正在运行的中文输入法改写/吞掉（丢“我/回”、，变 ,），所以这里刻意没有逐键回退。
// 文本以延迟渲染方式提供：目标真的来取才说明粘上了，取完之后才恢复用户原来的剪贴板。

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	textUser32   = windows.NewLazySystemDLL("user32.dll")
	textKernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procTextOpenClipboard  = textUser32.NewProc("OpenClipboard")
	procTextCloseClipboard = textUser32.NewProc("CloseClipboard")
	procTextEmpty          = textUser32.NewProc("EmptyClipboard")
	procTextSetClipboard   = textUser32.NewProc("SetClipboardData")
	procTextGetClipboard   = textUser32.NewProc("GetClipboardData")
	procTextEnumFormats    = textUser32.NewProc("EnumClipboardFormats")
	procTextRegisterFormat = textUser32.NewProc("RegisterClipboardFormatW")
	procTextIsFormatAvail  = textUser32.NewProc("IsClipboardFormatAvailable")
	procTextCreateWin      = textUser32.NewProc("CreateWindowExW")
	procTextDestroyWin     = textUser32.NewProc("DestroyWindow")
	procTextDefWindowProc  = textUser32.NewProc("DefWindowProcW")
	procTextRegisterClass  = textUser32.NewProc("RegisterClassExW")
	procTextGetMsg         = textUser32.NewProc("GetMessageW")
	procTextTranslate      = textUser32.NewProc("TranslateMessage")
	procTextDispatch       = textUser32.NewProc("DispatchMessageW")
	procTextPostMessage    = textUser32.NewProc("PostMessageW")
	procTextModule         = textKernel32.NewProc("GetModuleHandleW")

	procTextGlobalAlloc  = textKernel32.NewProc("GlobalAlloc")
	procTextGlobalFree   = textKernel32.NewProc("GlobalFree")
	procTextGlobalLock   = textKernel32.NewProc("GlobalLock")
	procTextGlobalUnlock = textKernel32.NewProc("GlobalUnlock")
	procTextGlobalSize   = textKernel32.NewProc("GlobalSize")
	// RtlMoveMemory 搬运字节：不让 Go 指针指到全局内存上（go vet 的 unsafeptr 规则）。
	procTextMoveMemory = textKernel32.NewProc("RtlMoveMemory")
)

const (
	clipFormatUnicodeText = 13
	clipFormatText        = 1
	gmemMoveable          = 0x0002
	wmRenderAllFormats    = 0x0300
	wmDestroyClipboard    = 0x0301
)

// textDelivery 是一段待粘贴文本的延迟渲染状态。
type textDelivery struct {
	mu       sync.Mutex
	pending  []uint16 // UTF-16，含结尾 0
	offered  int      // 已经提供过的格式数（决定是否还要继续提供）
	hwnd     windows.Handle
	windowUp bool
	owned    int // 本次是否由我们占用了剪贴板
}

var textState textDelivery

// appusePasteText 用剪贴板粘贴整段文字；返回是否真的被目标取用。
func appusePasteText(text string) error {
	if text == "" {
		return nil
	}
	units := windows.StringToUTF16(text)
	textState.mu.Lock()
	textState.pending = units
	textState.offered = 0
	textState.mu.Unlock()
	if err := textEnsureWindow(); err != nil {
		return err
	}
	if err := textOffer(); err != nil {
		return err
	}
	// 先记下用户剪贴板，等目标取走之后才恢复（现在还不能恢复：数据是延迟提供的）。
	saved := textSaveClipboard()
	if err := appusePressCombo("ctrl+v"); err != nil {
		textRestoreClipboard(saved)
		return err
	}
	// 等目标来取：拿到后延迟渲染结束，再恢复用户剪贴板。
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		textState.mu.Lock()
		done := len(textState.pending) == 0
		textState.mu.Unlock()
		if done {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	textState.mu.Lock()
	consumed := len(textState.pending) == 0
	textState.mu.Unlock()
	// 无论取没取走都要交还剪贴板，并把延迟渲染收回去。
	textFinish()
	textRestoreClipboard(saved)
	if !consumed {
		return fmt.Errorf("粘贴未能确认送达（目标未取用剪贴板）；可能输入框未获得焦点，请核对焦点后重试，不要重放整批")
	}
	return nil
}

// textEnsureWindow 建一个隐藏的剪贴板消息窗口：延迟渲染与 WM_RENDERALLFORMATS 都发给它。
func textEnsureWindow() error {
	textState.mu.Lock()
	if textState.windowUp {
		textState.mu.Unlock()
		return nil
	}
	textState.mu.Unlock()
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		instance, _, _ := procTextModule.Call(0)
		name := butterflyUTF16("VegaClipboardRender")
		procedure := syscall.NewCallback(func(hwnd windows.Handle, message uint32, wparam, lparam uintptr) uintptr {
			switch message {
			case wmRenderAllFormats:
				textRenderAll()
				return 0
			case wmDestroyClipboard:
				textState.mu.Lock()
				textState.pending = nil
				textState.owned = 0
				textState.mu.Unlock()
				return 0
			}
			value, _, _ := procTextDefWindowProc.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
			return value
		})
		class := chipWindowClass{Procedure: procedure, Instance: windows.Handle(instance), ClassName: name}
		class.Size = uint32(unsafe.Sizeof(class))
		if atom, _, _ := procTextRegisterClass.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
			result <- fmt.Errorf("无法注册剪贴板窗口类")
			return
		}
		hwnd, _, _ := procTextCreateWin.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, 0, 0, 0, instance, 0)
		if hwnd == 0 {
			result <- fmt.Errorf("无法创建剪贴板窗口")
			return
		}
		textState.mu.Lock()
		textState.hwnd, textState.windowUp = windows.Handle(hwnd), true
		textState.mu.Unlock()
		result <- nil
		var message glowMsg
		for {
			value, _, _ := procTextGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
			if int32(value) <= 0 {
				return
			}
			_, _, _ = procTextTranslate.Call(uintptr(unsafe.Pointer(&message)))
			_, _, _ = procTextDispatch.Call(uintptr(unsafe.Pointer(&message)))
		}
	}()
	select {
	case err := <-result:
		return err
	case <-time.After(2 * time.Second):
		return fmt.Errorf("剪贴板窗口启动超时")
	}
}

// textOffer 以延迟渲染方式占住剪贴板：文本在目标真正索取时才生成。
func textOffer() error {
	textState.mu.Lock()
	hwnd := textState.hwnd
	textState.mu.Unlock()
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(hwnd)); opened == 0 {
		return fmt.Errorf("无法打开剪贴板（可能被其它程序占用）")
	}
	if emptied, _, _ := procTextEmpty.Call(); emptied == 0 {
		_, _, _ = procTextCloseClipboard.Call()
		return fmt.Errorf("无法清空剪贴板")
	}
	// NULL 句柄 = 延迟渲染：由我们持有数据，目标来取时再给。
	_, _, _ = procTextSetClipboard.Call(clipFormatUnicodeText, 0)
	_, _, _ = procTextSetClipboard.Call(clipFormatText, 0)
	_, _, _ = procTextCloseClipboard.Call()
	textState.mu.Lock()
	textState.owned = 1
	textState.mu.Unlock()
	return nil
}

// textRenderAll 在 WM_RENDERALLFORMATS 里交出全部格式（控制权即将离开本进程时的兜底）。
func textRenderAll() {
	textState.mu.Lock()
	hwnd := textState.hwnd
	pending := append([]uint16{}, textState.pending...)
	textState.pending = nil
	textState.mu.Unlock()
	if len(pending) == 0 {
		return
	}
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(hwnd)); opened == 0 {
		return
	}
	defer func() { _, _, _ = procTextCloseClipboard.Call() }()
	_, _, _ = procTextEmpty.Call()
	if handle := textGlobal(pending); handle != 0 {
		_, _, _ = procTextSetClipboard.Call(clipFormatUnicodeText, handle)
	}
	textState.mu.Lock()
	textState.owned = 0
	textState.mu.Unlock()
}

// textGlobal 把 UTF-16 复制进可移动全局内存（SetClipboardData 之后所有权归系统）。
func textGlobal(units []uint16) uintptr {
	size := uintptr(len(units) * 2)
	handle, _, _ := procTextGlobalAlloc.Call(gmemMoveable, size)
	if handle == 0 {
		return 0
	}
	pointer, _, _ := procTextGlobalLock.Call(handle)
	if pointer == 0 {
		_, _, _ = procTextGlobalFree.Call(handle)
		return 0
	}
	_, _, _ = procTextMoveMemory.Call(pointer, uintptr(unsafe.Pointer(&units[0])), size)
	_, _, _ = procTextGlobalUnlock.Call(handle)
	return handle
}

// textFinish 收回延迟渲染（目标没取走时也别让它悬着）。
func textFinish() {
	textState.mu.Lock()
	hwnd := textState.hwnd
	owned := textState.owned
	textState.pending = nil
	textState.mu.Unlock()
	if owned == 0 {
		return
	}
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(hwnd)); opened != 0 {
		_, _, _ = procTextEmpty.Call()
		_, _, _ = procTextCloseClipboard.Call()
	}
	textState.mu.Lock()
	textState.owned = 0
	textState.mu.Unlock()
}

// savedClipboard 是用户原来的剪贴板快照（只保存文本，够用且不碰图片/文件）。
type savedClipboard struct {
	units []uint16
	valid bool
}

func textSaveClipboard() savedClipboard {
	if available, _, _ := procTextIsFormatAvail.Call(clipFormatUnicodeText); available == 0 {
		return savedClipboard{}
	}
	hwnd := textState.hwnd
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(hwnd)); opened == 0 {
		return savedClipboard{}
	}
	defer func() { _, _, _ = procTextCloseClipboard.Call() }()
	handle, _, _ := procTextGetClipboard.Call(clipFormatUnicodeText)
	if handle == 0 {
		return savedClipboard{}
	}
	size, _, _ := procTextGlobalSize.Call(handle)
	pointer, _, _ := procTextGlobalLock.Call(handle)
	if pointer == 0 || size == 0 {
		return savedClipboard{}
	}
	defer func() { _, _, _ = procTextGlobalUnlock.Call(handle) }()
	count := int(size / 2)
	units := make([]uint16, count)
	if count > 0 {
		_, _, _ = procTextMoveMemory.Call(uintptr(unsafe.Pointer(&units[0])), pointer, size)
	}
	for len(units) > 0 && units[len(units)-1] == 0 {
		units = units[:len(units)-1]
	}
	return savedClipboard{units: units, valid: true}
}

func textRestoreClipboard(saved savedClipboard) {
	if !saved.valid {
		return
	}
	units := append(append([]uint16{}, saved.units...), 0)
	hwnd := textState.hwnd
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(hwnd)); opened == 0 {
		return
	}
	defer func() { _, _, _ = procTextCloseClipboard.Call() }()
	_, _, _ = procTextEmpty.Call()
	if handle := textGlobal(units); handle != 0 {
		_, _, _ = procTextSetClipboard.Call(clipFormatUnicodeText, handle)
	}
}

// appuseSetClipboardText 直接写入剪贴板（给需要显式回读的调用方用）。
func appuseSetClipboardText(text string) error {
	units := append(windows.StringToUTF16(text), 0)
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(textState.hwnd)); opened == 0 {
		return fmt.Errorf("无法打开剪贴板")
	}
	defer func() { _, _, _ = procTextCloseClipboard.Call() }()
	_, _, _ = procTextEmpty.Call()
	if handle := textGlobal(units); handle == 0 {
		return fmt.Errorf("无法写入剪贴板")
	} else if ok, _, _ := procTextSetClipboard.Call(clipFormatUnicodeText, handle); ok == 0 {
		_, _, _ = procTextGlobalFree.Call(handle)
		return fmt.Errorf("无法写入剪贴板")
	}
	return nil
}

// appuseClipboardText 读出剪贴板文本（用于回读校验输入是否真的进去）。
func appuseClipboardText() (string, bool) {
	if available, _, _ := procTextIsFormatAvail.Call(clipFormatUnicodeText); available == 0 {
		return "", false
	}
	if opened, _, _ := procTextOpenClipboard.Call(uintptr(textState.hwnd)); opened == 0 {
		return "", false
	}
	defer func() { _, _, _ = procTextCloseClipboard.Call() }()
	handle, _, _ := procTextGetClipboard.Call(clipFormatUnicodeText)
	if handle == 0 {
		return "", false
	}
	pointer, _, _ := procTextGlobalLock.Call(handle)
	if pointer == 0 {
		return "", false
	}
	defer func() { _, _, _ = procTextGlobalUnlock.Call(handle) }()
	size, _, _ := procTextGlobalSize.Call(handle)
	if size < 2 || size > 1<<21 {
		return "", false
	}
	units := make([]uint16, size/2)
	_, _, _ = procTextMoveMemory.Call(uintptr(unsafe.Pointer(&units[0])), pointer, size)
	for len(units) > 0 && units[len(units)-1] == 0 {
		units = units[:len(units)-1]
	}
	return windows.UTF16ToString(units), true
}
