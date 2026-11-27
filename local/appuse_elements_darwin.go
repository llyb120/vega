//go:build darwin && cgo

package main

/*
#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>

typedef struct {
	char *name;
	char *role;
	char *automationID;
	char *className;
	int enabled;
	double x;
	double y;
	double w;
	double h;
} VegaAXNode;

extern AXUIElementRef vega_ax_find_window(uint32_t pid, uint32_t windowID, double cgX, double cgY, double cgW, double cgH, const char *wantTitle);
extern void vega_ax_read_node(AXUIElementRef elem, VegaAXNode *out);
extern void vega_ax_free_node(VegaAXNode *node);
extern int vega_ax_children(AXUIElementRef elem, AXUIElementRef **outChildren, int *outCount);
extern void vega_ax_free_children(AXUIElementRef *children, int count);
extern AXUIElementRef vega_ax_element_at(uint32_t pid, double cgX, double cgY);
extern AXUIElementRef vega_ax_parent(AXUIElementRef elem);
extern uint32_t vega_cg_window_at_point(double cgX, double cgY);
*/
import "C"

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"
)

var appuseUIABusy atomic.Bool

func appuseWithAX(work func() (appuseControlTree, error)) (appuseControlTree, error) {
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
		tree, err := work()
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

func axNodeToControl(displays []darwinDisplay, node *C.VegaAXNode) appuseControl {
	rawRole := ""
	if node.role != nil {
		rawRole = C.GoString(node.role)
	}
	name := ""
	if node.name != nil {
		name = C.GoString(node.name)
	}
	autoID := ""
	if node.automationID != nil {
		autoID = C.GoString(node.automationID)
	}
	className := ""
	if node.className != nil {
		className = C.GoString(node.className)
	}
	px, py, pw, ph, _ := darwinCGRectToPhysical(displays, float64(node.x), float64(node.y), float64(node.w), float64(node.h))
	return appuseControl{
		Name:         name,
		Role:         axRoleNormalize(rawRole),
		AutomationID: autoID,
		ClassName:    className,
		Enabled:      node.enabled != 0,
		Rect:         appuseControlRect{X: int(px), Y: int(py), Width: int(pw), Height: int(ph)},
	}
}

func appuseQueryElements(windowID uint32, depth, limit int, filter string) (appuseControlTree, error) {
	win, err := appuseWindowInfo(windowID)
	if err != nil {
		return appuseControlTree{}, err
	}
	displays, _ := darwinDisplays()
	cx, cy := darwinPhysicalToCG(displays, win.X, win.Y)
	ex, ey := darwinPhysicalToCG(displays, win.X+int32(win.W), win.Y+int32(win.H))
	cgW, cgH := ex-cx, ey-cy

	return appuseWithAX(func() (appuseControlTree, error) {
		tree := appuseControlTree{Elements: []appuseControl{}}
		cTitle := C.CString(win.Title)
		defer C.free(unsafe.Pointer(cTitle))

		root := C.vega_ax_find_window(C.uint32_t(win.PID), C.uint32_t(windowID),
			C.double(cx), C.double(cy), C.double(cgW), C.double(cgH), cTitle)
		if root == 0 {
			return tree, fmt.Errorf("无法读取窗口控件树（请确认已在系统设置开启辅助功能权限）")
		}
		defer C.CFRelease(C.CFTypeRef(root))

		started := time.Now()
		filterLower := strings.ToLower(filter)
		truncate := func(reason string) {
			tree.Truncated = true
			if tree.TruncatedBy == "" {
				tree.TruncatedBy = reason
			}
		}

		var walk func(elem C.AXUIElementRef, level int) bool
		walk = func(elem C.AXUIElementRef, level int) bool {
			if tree.Visited >= 1200 {
				truncate("nodeLimit")
				return false
			}
			if time.Since(started) >= uiaBudget {
				truncate("timeBudget")
				return false
			}
			tree.Visited++

			var rawNode C.VegaAXNode
			C.vega_ax_read_node(elem, &rawNode)
			control := axNodeToControl(displays, &rawNode)
			C.vega_ax_free_node(&rawNode)

			if control.Rect.Width > 0 && control.Rect.Height > 0 &&
				(control.Name != "" || control.AutomationID != "") &&
				strings.Contains(strings.ToLower(control.Name+" "+control.AutomationID+" "+control.Role), filterLower) {
				if len(tree.Elements) >= limit {
					truncate("itemLimit")
					return false
				}
				tree.Elements = append(tree.Elements, control)
			}

			var children *C.AXUIElementRef
			var count C.int
			if C.vega_ax_children(elem, &children, &count) != 0 {
				truncate("providerError")
				return true
			}
			if count <= 0 || children == nil {
				return true
			}
			defer C.vega_ax_free_children(children, count)

			if level >= depth {
				truncate("depth")
				return true
			}
			slice := unsafe.Slice(children, int(count))
			for _, child := range slice {
				if child == 0 {
					continue
				}
				if !walk(child, level+1) {
					return false
				}
			}
			return true
		}

		walk(root, 0)
		return tree, nil
	})
}

func appuseWindowAtPoint(point appusePoint) (uint32, error) {
	displays, _ := darwinDisplays()
	cx, cy := darwinPhysicalToCG(displays, point.X, point.Y)
	wid := uint32(C.vega_cg_window_at_point(C.double(cx), C.double(cy)))
	if wid == 0 {
		return 0, fmt.Errorf("该坐标没有可查询窗口")
	}
	return wid, nil
}

func appuseCheckElement(windowID uint32, point appusePoint, expected appuseControl) error {
	wid, err := appuseWindowAtPoint(point)
	if err != nil {
		return err
	}
	if wid != windowID {
		return fmt.Errorf("控件被其它窗口遮挡；未输入，请重新观察")
	}
	win, err := appuseWindowInfo(windowID)
	if err != nil {
		return err
	}
	displays, _ := darwinDisplays()
	cx, cy := darwinPhysicalToCG(displays, point.X, point.Y)

	_, err = appuseWithAX(func() (appuseControlTree, error) {
		elem := C.vega_ax_element_at(C.uint32_t(win.PID), C.double(cx), C.double(cy))
		if elem == 0 {
			return appuseControlTree{}, fmt.Errorf("落点没有控件")
		}
		for level := 0; elem != 0 && level <= 20; level++ {
			var rawNode C.VegaAXNode
			C.vega_ax_read_node(elem, &rawNode)
			control := axNodeToControl(displays, &rawNode)
			C.vega_ax_free_node(&rawNode)
			if control == expected && control.Enabled {
				C.CFRelease(C.CFTypeRef(elem))
				return appuseControlTree{}, nil
			}
			parent := C.vega_ax_parent(elem)
			C.CFRelease(C.CFTypeRef(elem))
			elem = parent
		}
		if elem != 0 {
			C.CFRelease(C.CFTypeRef(elem))
		}
		return appuseControlTree{}, fmt.Errorf("落点控件与观察不符；未输入，请重新 elements 或截图")
	})
	return err
}
