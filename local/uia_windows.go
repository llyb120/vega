//go:build windows

package main

// 任务栏上“哪里已经被图标占了”只有 UI Automation 知道：Win11 的图标是 XAML 画的，不是子窗口，
// 任务栏里也没有 MSTaskListWClass 之类的工具条可以问。
// 照 Nova 的做法：在一个独立的 MTA 线程上查（500ms 一次，单次预算 900ms），
// 结果只是几个矩形；任务栏那个子窗口的线程从不去碰 COM，免得把 Explorer 一起拖住。

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	uiaInterval    = time.Second
	uiaBudget      = 2500 * time.Millisecond
	uiaMaxDepth    = 12
	uiaMaxNodes    = 512
	uiaRectsMaxAge = 3 * time.Second
	uiaCoInitMTA   = 0x0
	uiaCLSCTXInProc = 0x1
)

// UIA 控件类型（UIAutomationClient.h 的 UIA_*ControlTypeId）。
const (
	uiaButtonType      = 50000
	uiaListItemType    = 50007
	uiaListType        = 50008
	uiaMenuItemType    = 50011
	uiaTabType         = 50018
	uiaTabItemType     = 50019
	uiaToolBarType     = 50021
	uiaCustomType      = 50025
	uiaGroupType       = 50026
	uiaSplitButtonType = 50031
	uiaWindowType      = 50032
	uiaPaneType        = 50033
)

type uiaGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	uiaOle32 = windows.NewLazySystemDLL("ole32.dll")

	procUIACoCreate = uiaOle32.NewProc("CoCreateInstance")
	procUIACoInit   = uiaOle32.NewProc("CoInitializeEx")
	procUIACoUninit = uiaOle32.NewProc("CoUninitialize")

	// CLSID_CUIAutomation / CLSID_CUIAutomation8，IID_IUIAutomation。
	clsUIAutomation  = uiaGUID{0xFF48DBA4, 0x60EF, 0x4201, [8]byte{0xAA, 0x87, 0x54, 0x10, 0x3E, 0xEF, 0x59, 0x4E}}
	clsUIAutomation8 = uiaGUID{0xE22AD333, 0xB25F, 0x460C, [8]byte{0x83, 0xD0, 0x05, 0x81, 0x10, 0x73, 0x95, 0xC9}}
	iidIUIAutomation = uiaGUID{0x30CBE57D, 0xD9D0, 0x452A, [8]byte{0xAB, 0x13, 0x7A, 0xC5, 0xAC, 0x48, 0x25, 0xEE}}

	// 槽位：IUnknown 占 0..2，之后按 UIAutomationClient.h 的声明顺序
	// （用 windows crate 的生成代码核过，cfg 成对的只算一个槽）。
	slotUIAElementFromHandle = 6  // IUIAutomation::ElementFromHandle
	slotUIAControlViewWalker = 14 // IUIAutomation::get_ControlViewWalker（前面还有 CreateTreeWalker）
	slotUIAFirstChild        = 4  // IUIAutomationTreeWalker::GetFirstChildElement
	slotUIANextSibling       = 6  // IUIAutomationTreeWalker::GetNextSiblingElement
	slotUIACurrentProcessID  = 20 // IUIAutomationElement::get_CurrentProcessId
	slotUIACurrentType       = 21 // IUIAutomationElement::get_CurrentControlType
	slotUIACurrentFocusable  = 27 // IUIAutomationElement::get_CurrentIsKeyboardFocusable
	slotUIACurrentOffscreen  = 38 // IUIAutomationElement::get_CurrentIsOffscreen
	slotUIACurrentRect       = 43 // IUIAutomationElement::get_CurrentBoundingRectangle
)

// chipLayout 是 UI Automation 线程算好的“任务栏已占用矩形”，蝴蝶线程只读它。
var chipLayout struct {
	sync.Mutex
	rects   []appuseWinRect
	taskbar appuseWinRect
	at      time.Time
}

func uiaFailed(result uintptr) error {
	if int32(result) < 0 {
		return fmt.Errorf("hr=0x%x", uint32(result))
	}
	return nil
}

func uiaCreate() (unsafe.Pointer, error) {
	for _, class := range []*uiaGUID{&clsUIAutomation8, &clsUIAutomation} {
		var automation unsafe.Pointer
		result, _, _ := procUIACoCreate.Call(
			uintptr(unsafe.Pointer(class)), 0, uiaCLSCTXInProc,
			uintptr(unsafe.Pointer(&iidIUIAutomation)), uintptr(unsafe.Pointer(&automation)))
		if int32(result) >= 0 && automation != nil {
			return automation, nil
		}
	}
	return nil, errors.New("CoCreateInstance(CUIAutomation) 失败")
}

func uiaInt(element unsafe.Pointer, slot int) (int32, error) {
	var value int32
	if err := uiaFailed(comCall(element, slot, uintptr(unsafe.Pointer(&value)))); err != nil {
		return 0, err
	}
	return value, nil
}

func uiaBool(element unsafe.Pointer, slot int) (bool, error) {
	value, err := uiaInt(element, slot)
	return value != 0, err
}

func uiaRect(element unsafe.Pointer) (appuseWinRect, error) {
	rect := appuseWinRect{}
	err := uiaFailed(comCall(element, slotUIACurrentRect, uintptr(unsafe.Pointer(&rect))))
	return rect, err
}

// uiaRelative 取第一个子元素 / 下一个兄弟；返回 nil 表示到头了。
func uiaRelative(walker, element unsafe.Pointer, first bool) (unsafe.Pointer, error) {
	slot := slotUIANextSibling
	if first {
		slot = slotUIAFirstChild
	}
	var child unsafe.Pointer
	err := uiaFailed(comCall(walker, slot, uintptr(element), uintptr(unsafe.Pointer(&child))))
	return child, err
}

// uiaOccupies 见 Nova 的同名判定：不透明的叶子整块都算占位，容器本身不算。
func uiaOccupies(kind int32, leaf bool) bool {
	container := kind == uiaPaneType || kind == uiaGroupType || kind == uiaToolBarType || kind == uiaListType ||
		kind == uiaTabType || kind == uiaWindowType || kind == uiaCustomType
	return leaf || (!container && (kind == uiaButtonType || kind == uiaSplitButtonType ||
		kind == uiaListItemType || kind == uiaMenuItemType || kind == uiaTabItemType))
}

// uiaCollect 递归收矩形；超深度/超节点/超时都算失败（宁可不动，也不猜空档）。
// 每个元素只碰两次属性（矩形 + 控件类型），加上一次 pid：跨进程调用很贵（约 1ms/次）。
func uiaCollect(walker, element unsafe.Pointer, depth int, remaining *int, started time.Time, out *[]appuseWinRect) error {
	if depth > uiaMaxDepth || *remaining <= 0 || time.Since(started) > uiaBudget {
		return fmt.Errorf("UIA 树太大或太慢：depth=%d 剩 %d 个节点，已用 %v", depth, *remaining, time.Since(started).Round(time.Millisecond))
	}
	*remaining--
	child, err := uiaRelative(walker, element, true)
	if err != nil {
		return err
	}
	if depth != 0 {
		rect, err := uiaRect(element)
		if err != nil {
			return err
		}
		if rect.Right > rect.Left && rect.Bottom > rect.Top {
			pid, err := uiaInt(element, slotUIACurrentProcessID)
			if err != nil {
				return err
			}
			if uint32(pid) == uint32(os.Getpid()) {
				return nil // 自己的蝴蝶不算占位
			}
			kind, err := uiaInt(element, slotUIACurrentType)
			if err != nil {
				return err
			}
			if uiaOccupies(kind, child == nil) {
				*out = append(*out, rect)
			}
		}
	}
	for child != nil {
		next, err := uiaRelative(walker, child, false)
		if err != nil {
			comRelease(child)
			return err
		}
		err = uiaCollect(walker, child, depth+1, remaining, started, out)
		comRelease(child) // 每个元素都要还回去，否则每秒漏几十个 COM 引用（会算在 Explorer 头上）
		if err != nil {
			return err
		}
		child = next
	}
	return nil
}

// uiaOccupied 问一次任务栏：被图标/托盘占住的矩形。
func uiaOccupied(taskbar uintptr) ([]appuseWinRect, error) {
	automation, err := uiaCreate()
	if err != nil {
		return nil, err
	}
	defer comRelease(automation)
	var root unsafe.Pointer
	if err := uiaFailed(comCall(automation, slotUIAElementFromHandle, taskbar, uintptr(unsafe.Pointer(&root)))); err != nil {
		return nil, err
	}
	if root == nil {
		return nil, errors.New("任务栏没有 UIA 元素")
	}
	defer comRelease(root)
	var walker unsafe.Pointer
	if err := uiaFailed(comCall(automation, slotUIAControlViewWalker, uintptr(unsafe.Pointer(&walker)))); err != nil {
		return nil, err
	}
	if walker == nil {
		return nil, errors.New("拿不到 ControlViewWalker")
	}
	defer comRelease(walker)
	remaining := uiaMaxNodes
	rects := make([]appuseWinRect, 0, 32)
	if err := uiaCollect(walker, root, 0, &remaining, time.Now(), &rects); err != nil {
		return nil, err
	}
	// 空/残缺的可及树不能当“任务栏是空的”。
	if len(rects) < 2 {
		return nil, fmt.Errorf("只收到 %d 个占位矩形", len(rects))
	}
	return rects, nil
}

// uiaLayoutLoop 探任务栏的占用情况（独立线程 + MTA，绝不占用任务栏子窗口的线程）。
func uiaLayoutLoop() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// 同线程重复初始化返回 S_FALSE（1），也算成功。
	if result, _, _ := procUIACoInit.Call(0, uiaCoInitMTA); int32(result) < 0 {
		chipDebug("uia-init", fmt.Errorf("CoInitializeEx hr=0x%x", uint32(result)))
		return
	}
	defer func() { _, _, _ = procUIACoUninit.Call() }()
	var logged []appuseWinRect
	for {
		taskbar, _, _ := procChipFindWindow.Call(uintptr(unsafe.Pointer(butterflyUTF16("Shell_TrayWnd"))), 0)
		if taskbar == 0 || chipHwnd() == 0 {
			time.Sleep(uiaInterval)
			continue
		}
		bar := appuseWinRect{}
		_, _, _ = procWindowRect.Call(taskbar, uintptr(unsafe.Pointer(&bar)))
		rects, err := uiaOccupied(taskbar)
		chipLayout.Lock()
		if err == nil && bar.Right > bar.Left {
			chipLayout.rects, chipLayout.taskbar, chipLayout.at = rects, bar, time.Now()
		} else {
			chipLayout.rects, chipLayout.at = nil, time.Time{}
		}
		chipLayout.Unlock()
		switch {
		case err != nil:
			chipDebug("uia", err)
		case !sameRects(logged, rects):
			// 只在布局变了时落日志，别每 500ms 刷一遍。
			logged = rects
			chipLog("任务栏占位 %d 个，任务栏 %d,%d-%d,%d", len(rects), bar.Left, bar.Top, bar.Right, bar.Bottom)
			for _, rect := range rects {
				chipLog("  占位 %d,%d-%d,%d", rect.Left, rect.Top, rect.Right, rect.Bottom)
			}
		}
		time.Sleep(uiaInterval)
	}
}

func sameRects(a, b []appuseWinRect) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// chipOccupied 给蝴蝶线程读的占位矩形；任务栏尺寸变了或数据太旧就不用。
func chipOccupied(taskbar appuseWinRect) ([]appuseWinRect, bool) {
	chipLayout.Lock()
	defer chipLayout.Unlock()
	if len(chipLayout.rects) == 0 || time.Since(chipLayout.at) > uiaRectsMaxAge || chipLayout.taskbar != taskbar {
		return nil, false
	}
	return chipLayout.rects, true
}

// chipGapSlot 完全照 Nova 的 free_slot + pill_slot：在占位矩形之间找一段够宽的空档
// （宽度上限 300dp，两侧各让出 6dp），找不到就按 160/96/34 退档；高度收到 28dp 居中。
// 优先靠右的那一段：同一档里最后一个够宽的。
func chipGapSlot(taskbar appuseWinRect, occupied []appuseWinRect, dpi uint32) (appuseWinRect, bool) {
	if taskbar.Right <= taskbar.Left || taskbar.Bottom <= taskbar.Top {
		return appuseWinRect{}, false
	}
	gap := chipScale(chipSlotGap, dpi)
	desired := chipScale(chipSlotDesired, dpi)
	start, end := taskbar.Left+gap, taskbar.Right-gap
	top, bottom := taskbar.Top+gap, taskbar.Bottom-gap
	if start >= end || top >= bottom {
		return appuseWinRect{}, false
	}
	type span struct{ left, right int32 }
	spans := make([]span, 0, len(occupied)+1)
	for _, rect := range occupied {
		if rect.Top >= taskbar.Bottom || rect.Bottom <= taskbar.Top || rect.Left >= rect.Right {
			continue
		}
		left, right := rect.Left-gap, rect.Right+gap
		if left < start {
			left = start
		}
		if right > end {
			right = end
		}
		if left < right {
			spans = append(spans, span{left, right})
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].left < spans[j].left })
	spans = append(spans, span{end, end})
	slot := appuseWinRect{}
	found := false
	for _, want := range []int32{chipIdealWidth, chipMinWidth, chipIconWidth} {
		minimum := chipScale(want, dpi)
		cursor := start
		found = false
		for _, span := range spans {
			width := span.left - cursor
			if width > desired {
				width = desired
			}
			if width >= minimum {
				slot = appuseWinRect{Left: span.left - width, Top: top, Right: span.left, Bottom: bottom}
				found = true
			}
			if span.right > cursor {
				cursor = span.right
			}
		}
		if found {
			break
		}
	}
	if !found {
		return appuseWinRect{}, false
	}
	height := chipScale(chipPillHeight, dpi)
	if height > slot.Bottom-slot.Top {
		height = slot.Bottom - slot.Top
	}
	slot.Top += (slot.Bottom - slot.Top - height) / 2
	slot.Bottom = slot.Top + height
	return slot, true
}
