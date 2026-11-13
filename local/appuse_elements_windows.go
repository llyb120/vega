//go:build windows

package main

import (
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var appuseUIABusy atomic.Bool
var appuseOleAut = windows.NewLazySystemDLL("oleaut32.dll")
var appuseSysFreeString = appuseOleAut.NewProc("SysFreeString")
var appuseSysStringLen = appuseOleAut.NewProc("SysStringLen")
var appuseWindowFromPointProc = windows.NewLazySystemDLL("user32.dll").NewProc("WindowFromPoint")
var appuseGetAncestorProc = windows.NewLazySystemDLL("user32.dll").NewProc("GetAncestor")

// UIA providers can hang inside one COM call: at most one bounded query remains in flight, never pile up threads.
func appuseWithUIA(work func(unsafe.Pointer) (appuseControlTree, error)) (appuseControlTree, error) {
	if !appuseUIABusy.CompareAndSwap(false, true) {
		return appuseControlTree{}, fmt.Errorf("上一次控件查询仍在等待系统，不重复启动")
	}
	type answer struct {
		tree appuseControlTree
		err  error
	}
	done := make(chan answer, 1)
	go func() {
		defer appuseUIABusy.Store(false)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		result, _, _ := procUIACoInit.Call(0, uiaCoInitMTA)
		if err := uiaFailed(result); err != nil {
			done <- answer{err: err}
			return
		}
		defer procUIACoUninit.Call()
		automation, err := uiaCreate()
		if err != nil {
			done <- answer{err: err}
			return
		}
		defer comRelease(automation)
		tree, err := work(automation)
		done <- answer{tree: tree, err: err}
	}()
	timer := time.NewTimer(4 * time.Second)
	defer timer.Stop()
	select {
	case result := <-done:
		return result.tree, result.err
	case <-timer.C:
		return appuseControlTree{}, fmt.Errorf("控件查询超时，未发送输入；请改用截图，不重复查询")
	}
}
func appuseUIAString(element unsafe.Pointer, slot int) string {
	var text *uint16
	if uiaFailed(comCall(element, slot, uintptr(unsafe.Pointer(&text)))) != nil || text == nil {
		return ""
	}
	defer appuseSysFreeString.Call(uintptr(unsafe.Pointer(text)))
	length, _, _ := appuseSysStringLen.Call(uintptr(unsafe.Pointer(text)))
	if length > 4096 {
		length = 4096
	}
	return windows.UTF16ToString(unsafe.Slice(text, int(length)))
}
func appuseUIAControl(element unsafe.Pointer) (appuseControl, error) {
	r, err := uiaRect(element)
	if err != nil {
		return appuseControl{}, err
	}
	kind, err := uiaInt(element, slotUIACurrentType)
	if err != nil {
		return appuseControl{}, err
	}
	enabled, err := uiaBool(element, 28)
	if err != nil {
		return appuseControl{}, err
	}
	return appuseControl{Name: appuseUIAString(element, 23), AutomationID: appuseUIAString(element, 29), ClassName: appuseUIAString(element, 30),
		ControlType: kind, Role: appuseUIARole(kind), Enabled: enabled,
		Rect: appuseControlRect{X: int(r.Left), Y: int(r.Top), Width: int(r.Right - r.Left), Height: int(r.Bottom - r.Top)}}, nil
}
func appuseUIARole(kind int32) string {
	roles := map[int32]string{50000: "button", 50001: "calendar", 50002: "checkbox", 50003: "combobox", 50004: "textbox", 50005: "link", 50006: "image", 50007: "listitem", 50008: "list", 50009: "menu", 50010: "menubar", 50011: "menuitem", 50012: "progressbar", 50013: "radiobutton", 50014: "scrollbar", 50015: "slider", 50016: "spinbutton", 50017: "statusbar", 50018: "tablist", 50019: "tab", 50020: "text", 50021: "toolbar", 50022: "tooltip", 50023: "tree", 50024: "treeitem", 50025: "custom", 50026: "group", 50027: "thumb", 50028: "datagrid", 50029: "dataitem", 50030: "document", 50031: "splitbutton", 50032: "window", 50033: "pane", 50034: "header", 50035: "headeritem", 50036: "table", 50037: "titlebar", 50038: "separator"}
	if role := roles[kind]; role != "" {
		return role
	}
	return fmt.Sprintf("control-%d", kind)
}
func appuseQueryElements(windowID uint32, depth, limit int, filter string) (appuseControlTree, error) {
	return appuseWithUIA(func(automation unsafe.Pointer) (appuseControlTree, error) {
		tree := appuseControlTree{Elements: []appuseControl{}}
		var root, walker unsafe.Pointer
		if err := uiaFailed(comCall(automation, slotUIAElementFromHandle, uintptr(windowID), uintptr(unsafe.Pointer(&root)))); err != nil {
			return tree, err
		}
		if root == nil {
			return tree, fmt.Errorf("窗口没有 UIA 根节点")
		}
		defer comRelease(root)
		if err := uiaFailed(comCall(automation, slotUIAControlViewWalker, uintptr(unsafe.Pointer(&walker)))); err != nil {
			return tree, err
		}
		if walker == nil {
			return tree, fmt.Errorf("系统没有控件树遍历器")
		}
		defer comRelease(walker)
		started := time.Now()
		filter = strings.ToLower(filter)
		truncate := func(reason string) {
			tree.Truncated = true
			if tree.TruncatedBy == "" {
				tree.TruncatedBy = reason
			}
		}
		var walk func(unsafe.Pointer, int) bool
		walk = func(element unsafe.Pointer, level int) bool {
			if tree.Visited >= 1200 {
				truncate("nodeLimit")
				return false
			}
			if time.Since(started) >= uiaBudget {
				truncate("timeBudget")
				return false
			}
			tree.Visited++
			offscreen, err := uiaBool(element, slotUIACurrentOffscreen)
			if err != nil {
				truncate("providerError")
				return true
			}
			if offscreen {
				return true
			}
			control, err := appuseUIAControl(element)
			if err != nil {
				truncate("providerError")
				return true
			}
			if control.Rect.Width > 0 && control.Rect.Height > 0 && (control.Name != "" || control.AutomationID != "") && strings.Contains(strings.ToLower(control.Name+" "+control.AutomationID+" "+control.Role), filter) {
				if len(tree.Elements) >= limit {
					truncate("itemLimit")
					return false
				}
				tree.Elements = append(tree.Elements, control)
			}
			child, err := uiaRelative(walker, element, true)
			if err != nil {
				truncate("providerError")
				return true
			}
			if level >= depth {
				if child != nil {
					truncate("depth")
					comRelease(child)
				}
				return true
			}
			for child != nil {
				more := walk(child, level+1)
				if !more {
					comRelease(child)
					return false
				}
				next, err := uiaRelative(walker, child, false)
				comRelease(child)
				if err != nil {
					truncate("providerError")
					return true
				}
				child = next
			}
			return true
		}
		walk(root, 0)
		return tree, nil
	})
}
func appusePointArgs(point appusePoint) []uintptr {
	if unsafe.Sizeof(uintptr(0)) == 4 {
		return []uintptr{uintptr(uint32(point.X)), uintptr(uint32(point.Y))}
	}
	return []uintptr{uintptr(uint64(uint32(point.X)) | uint64(uint32(point.Y))<<32)}
}
func appuseWindowAtPoint(point appusePoint) (uint32, error) {
	hwnd, _, _ := appuseWindowFromPointProc.Call(appusePointArgs(point)...)
	if hwnd == 0 {
		return 0, fmt.Errorf("该坐标没有可查询窗口")
	}
	root, _, _ := appuseGetAncestorProc.Call(hwnd, 2)
	if root == 0 {
		return 0, fmt.Errorf("无法确认目标窗口")
	}
	return uint32(root), nil
}
func appuseCheckElement(windowID uint32, point appusePoint, expected appuseControl) error {
	window, err := appuseWindowAtPoint(point)
	if err != nil {
		return err
	}
	if window != windowID {
		return fmt.Errorf("控件被其它窗口遮挡；未输入，请重新观察")
	}
	_, err = appuseWithUIA(func(automation unsafe.Pointer) (appuseControlTree, error) {
		var element, walker unsafe.Pointer
		args := append(appusePointArgs(point), uintptr(unsafe.Pointer(&element)))
		if err := uiaFailed(comCall(automation, 7, args...)); err != nil {
			return appuseControlTree{}, err
		}
		if element == nil {
			return appuseControlTree{}, fmt.Errorf("落点没有控件")
		}
		if err := uiaFailed(comCall(automation, slotUIAControlViewWalker, uintptr(unsafe.Pointer(&walker)))); err != nil {
			comRelease(element)
			return appuseControlTree{}, err
		}
		if walker == nil {
			comRelease(element)
			return appuseControlTree{}, fmt.Errorf("控件遍历器不可用")
		}
		defer comRelease(walker)
		for level := 0; element != nil && level <= 20; level++ {
			control, readErr := appuseUIAControl(element)
			if readErr == nil && control == expected && control.Enabled {
				comRelease(element)
				return appuseControlTree{}, nil
			}
			var parent unsafe.Pointer
			hr := comCall(walker, 3, uintptr(element), uintptr(unsafe.Pointer(&parent)))
			comRelease(element)
			element = parent
			if uiaFailed(hr) != nil {
				break
			}
		}
		comRelease(element)
		return appuseControlTree{}, fmt.Errorf("落点控件与观察不符；未输入，请重新 elements 或截图")
	})
	return err
}
