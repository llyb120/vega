//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Batch-cached Windows UI Automation walker mirroring Nova's src-tauri/src/jianlai/uia.rs.
// Every tree walk uses IUIAutomationCacheRequest so each visited element pulls all needed
// properties in a single cross-process RPC instead of 5-10 property roundtrips per node.

const (
	uiaPropBoundingRectangle       = 30001
	uiaPropProcessID               = 30002
	uiaPropControlType             = 30003
	uiaPropLocalizedControlType    = 30004
	uiaPropName                    = 30005
	uiaPropIsKeyboardFocusable     = 30009
	uiaPropIsEnabled               = 30010
	uiaPropAutomationID            = 30011
	uiaPropIsPassword              = 30019
	uiaPropIsOffscreen             = 30022
	uiaPropValueValue              = 30045
	uiaPropValueIsReadOnly         = 30046
	uiaPropScrollVPercent          = 30055
	uiaPropScrollVViewSize         = 30056
	uiaPropScrollVScrollable       = 30058
	uiaPropSelectionItemIsSelected = 30079
	uiaPropToggleState             = 30086

	uiaSlotQueryInterface         = 0
	uiaSlotElementFromHandleBC    = 10 // IUIAutomation::ElementFromHandleBuildCache
	uiaSlotCreateCacheRequest     = 20 // IUIAutomation::CreateCacheRequest
	uiaSlotAuto2ConnTimeout       = 61 // IUIAutomation2::put_ConnectionTimeout
	uiaSlotAuto2TransTimeout      = 63 // IUIAutomation2::put_TransactionTimeout
	uiaSlotCacheAddProperty       = 3  // IUIAutomationCacheRequest::AddProperty
	uiaSlotWalkerFirstChildBC     = 10 // IUIAutomationTreeWalker::GetFirstChildElementBuildCache
	uiaSlotWalkerNextSiblingBC    = 12 // IUIAutomationTreeWalker::GetNextSiblingElementBuildCache
	uiaSlotElemGetCachedPropVal   = 12 // IUIAutomationElement::GetCachedPropertyValue
	uiaSlotElemCachedProcessID    = 52
	uiaSlotElemCachedControlType  = 53
	uiaSlotElemCachedLocalType    = 54
	uiaSlotElemCachedName         = 55
	uiaSlotElemCachedFocusable    = 59
	uiaSlotElemCachedEnabled      = 60
	uiaSlotElemCachedAutomationID = 61
	uiaSlotElemCachedIsPassword   = 67
	uiaSlotElemCachedIsOffscreen  = 70
	uiaSlotElemCachedRect         = 75
)

var (
	iidIUIAutomation2   = uiaGUID{0x34723AFF, 0x0C9D, 0x49D0, [8]byte{0x98, 0x96, 0x7A, 0xB5, 0x2D, 0xF8, 0xCD, 0x8A}}
	appuseVariantClearP = appuseOleAut.NewProc("VariantClear")
)

type oleVariant struct {
	VT   uint16
	Res1 uint16
	Res2 uint16
	Res3 uint16
	Data [16]byte
}

func appuseVariantClear(v *oleVariant) {
	if v != nil && v.VT != 0 {
		_, _, _ = appuseVariantClearP.Call(uintptr(unsafe.Pointer(v)))
	}
}

func appuseCachedPropString(elem unsafe.Pointer, propID int32) string {
	var v oleVariant
	if uiaFailed(comCall(elem, uiaSlotElemGetCachedPropVal, uintptr(propID), uintptr(unsafe.Pointer(&v)))) != nil {
		return ""
	}
	defer appuseVariantClear(&v)
	if v.VT != 8 { // VT_BSTR
		return ""
	}
	bstr := *(**uint16)(unsafe.Pointer(&v.Data[0]))
	if bstr == nil {
		return ""
	}
	length, _, _ := appuseSysStringLen.Call(uintptr(unsafe.Pointer(bstr)))
	if length > 2048 {
		length = 2048
	}
	return windows.UTF16ToString(unsafe.Slice(bstr, int(length)))
}

func appuseCachedPropBool(elem unsafe.Pointer, propID int32) (bool, bool) {
	var v oleVariant
	if uiaFailed(comCall(elem, uiaSlotElemGetCachedPropVal, uintptr(propID), uintptr(unsafe.Pointer(&v)))) != nil {
		return false, false
	}
	defer appuseVariantClear(&v)
	if v.VT != 11 { // VT_BOOL
		return false, false
	}
	return binary.LittleEndian.Uint16(v.Data[:2]) != 0, true
}

func appuseCachedPropInt(elem unsafe.Pointer, propID int32) (int32, bool) {
	var v oleVariant
	if uiaFailed(comCall(elem, uiaSlotElemGetCachedPropVal, uintptr(propID), uintptr(unsafe.Pointer(&v)))) != nil {
		return 0, false
	}
	defer appuseVariantClear(&v)
	if v.VT != 3 { // VT_I4
		return 0, false
	}
	return int32(binary.LittleEndian.Uint32(v.Data[:4])), true
}

func appuseCachedPropFloat(elem unsafe.Pointer, propID int32) (float64, bool) {
	var v oleVariant
	if uiaFailed(comCall(elem, uiaSlotElemGetCachedPropVal, uintptr(propID), uintptr(unsafe.Pointer(&v)))) != nil {
		return 0, false
	}
	defer appuseVariantClear(&v)
	if v.VT != 5 { // VT_R8
		return 0, false
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(v.Data[:8])), true
}

func appuseCachedBSTR(elem unsafe.Pointer, slot int) string {
	var text *uint16
	if uiaFailed(comCall(elem, slot, uintptr(unsafe.Pointer(&text)))) != nil || text == nil {
		return ""
	}
	defer appuseSysFreeString.Call(uintptr(unsafe.Pointer(text)))
	length, _, _ := appuseSysStringLen.Call(uintptr(unsafe.Pointer(text)))
	if length > 2048 {
		length = 2048
	}
	return windows.UTF16ToString(unsafe.Slice(text, int(length)))
}

func appuseCachedRect(elem unsafe.Pointer) (appuseWinRect, error) {
	var rect appuseWinRect
	err := uiaFailed(comCall(elem, uiaSlotElemCachedRect, uintptr(unsafe.Pointer(&rect))))
	return rect, err
}

func appuseUIAInteractiveKind(kind int32) bool {
	switch kind {
	case 50000, 50001, 50002, 50003, 50004, 50005, 50007, 50009, 50011, 50013, 50015, 50016, 50019, 50024, 50029, 50031:
		return true
	}
	return false
}

func appuseUIABuildCacheRequest(automation unsafe.Pointer) (unsafe.Pointer, error) {
	var req unsafe.Pointer
	if err := uiaFailed(comCall(automation, uiaSlotCreateCacheRequest, uintptr(unsafe.Pointer(&req)))); err != nil || req == nil {
		return nil, fmt.Errorf("CreateCacheRequest 失败: %v", err)
	}
	props := []int32{
		uiaPropBoundingRectangle,
		uiaPropProcessID,
		uiaPropControlType,
		uiaPropLocalizedControlType,
		uiaPropName,
		uiaPropIsKeyboardFocusable,
		uiaPropIsEnabled,
		uiaPropAutomationID,
		uiaPropIsPassword,
		uiaPropIsOffscreen,
		uiaPropValueValue,
		uiaPropValueIsReadOnly,
		uiaPropScrollVPercent,
		uiaPropScrollVViewSize,
		uiaPropScrollVScrollable,
		uiaPropSelectionItemIsSelected,
		uiaPropToggleState,
	}
	for _, prop := range props {
		_ = comCall(req, uiaSlotCacheAddProperty, uintptr(prop))
	}
	return req, nil
}

func appuseSetUIATimeouts(automation unsafe.Pointer) {
	var auto2 unsafe.Pointer
	if uiaFailed(comCall(automation, uiaSlotQueryInterface, uintptr(unsafe.Pointer(&iidIUIAutomation2)), uintptr(unsafe.Pointer(&auto2)))) == nil && auto2 != nil {
		_, _, _ = uintptr(0), uintptr(0), uintptr(0)
		_ = comCall(auto2, uiaSlotAuto2ConnTimeout, 400)
		_ = comCall(auto2, uiaSlotAuto2TransTimeout, 400)
		comRelease(auto2)
	}
}

func appuseWalkCachedTree(windowID uint32, maxDepth, maxNodes int, timeBudget time.Duration, outerTimeout time.Duration, selfRects []appuseControlRect, fastOnly bool) (appuseUIAExtract, error) {
	out := appuseUIAExtract{WindowID: windowID}
	if !appuseUIABusy.CompareAndSwap(false, true) {
		return out, fmt.Errorf("上一次控件查询仍在等待系统，不重复启动")
	}
	type answer struct {
		extract appuseUIAExtract
		err     error
	}
	done := make(chan answer, 1)
	go func() {
		defer appuseUIABusy.Store(false)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		result, _, _ := procUIACoInit.Call(0, uiaCoInitMTA)
		if err := uiaFailed(result); err != nil {
			done <- answer{extract: out, err: err}
			return
		}
		defer procUIACoUninit.Call()
		automation, err := uiaCreate()
		if err != nil {
			done <- answer{extract: out, err: err}
			return
		}
		defer comRelease(automation)
		appuseSetUIATimeouts(automation)

		cacheReq, err := appuseUIABuildCacheRequest(automation)
		if err != nil {
			done <- answer{extract: out, err: err}
			return
		}
		defer comRelease(cacheReq)

		var root, walker unsafe.Pointer
		if err := uiaFailed(comCall(automation, uiaSlotElementFromHandleBC, uintptr(windowID), uintptr(cacheReq), uintptr(unsafe.Pointer(&root)))); err != nil || root == nil {
			done <- answer{extract: out, err: fmt.Errorf("窗口没有 UIA 根节点")}
			return
		}
		defer comRelease(root)
		if err := uiaFailed(comCall(automation, slotUIAControlViewWalker, uintptr(unsafe.Pointer(&walker)))); err != nil || walker == nil {
			done <- answer{extract: out, err: fmt.Errorf("系统没有控件树遍历器")}
			return
		}
		defer comRelease(walker)

		extract := appuseUIAExtract{WindowID: windowID}
		ownPID := uint32(os.Getpid())
		if rootPID, err := uiaInt(root, uiaSlotElemCachedProcessID); err == nil {
			extract.PID = uint32(rootPID)
		}
		var winRect appuseControlRect
		if rr, err := appuseCachedRect(root); err == nil && rr.Right > rr.Left && rr.Bottom > rr.Top {
			winRect = appuseControlRect{X: int(rr.Left), Y: int(rr.Top), Width: int(rr.Right - rr.Left), Height: int(rr.Bottom - rr.Top)}
		}

		started := time.Now()
		bestScrollArea := 0
		truncate := func(reason string) {
			extract.Truncated = true
			if extract.TruncatedBy == "" {
				extract.TruncatedBy = reason
			}
		}

		isSelfRect := func(cx, cy int) bool {
			for _, sr := range selfRects {
				if sr.contains(cx, cy) {
					return true
				}
			}
			return false
		}

		var bestOverlay *appuseOverlayInfo
		var walk func(elem unsafe.Pointer, level int, inOverlay bool) bool
		walk = func(elem unsafe.Pointer, level int, inOverlay bool) bool {
			if extract.Visited >= maxNodes {
				truncate("nodeLimit")
				return false
			}
			if time.Since(started) >= timeBudget {
				truncate("timeBudget")
				return false
			}
			extract.Visited++

			pid, _ := uiaInt(elem, uiaSlotElemCachedProcessID)
			if uint32(pid) == ownPID {
				return true
			}
			offscreen, err := uiaBool(elem, uiaSlotElemCachedIsOffscreen)
			if err == nil && offscreen {
				return true
			}
			rect, rectErr := appuseCachedRect(elem)
			if rectErr != nil || rect.Right <= rect.Left || rect.Bottom <= rect.Top {
				return true
			}
			w := int(rect.Right - rect.Left)
			h := int(rect.Bottom - rect.Top)
			cRect := appuseControlRect{X: int(rect.Left), Y: int(rect.Top), Width: w, Height: h}
			cx, cy := cRect.X+w/2, cRect.Y+h/2
			if isSelfRect(cx, cy) {
				return true
			}

			kind, _ := uiaInt(elem, uiaSlotElemCachedControlType)
			role := appuseUIARole(kind)
			enabled, _ := uiaBool(elem, uiaSlotElemCachedEnabled)
			focusable, _ := uiaBool(elem, uiaSlotElemCachedFocusable)
			isPassword, _ := uiaBool(elem, uiaSlotElemCachedIsPassword)
			name := strings.TrimSpace(appuseCachedBSTR(elem, uiaSlotElemCachedName))
			autoID := strings.TrimSpace(appuseCachedBSTR(elem, uiaSlotElemCachedAutomationID))
			localType := strings.TrimSpace(appuseCachedBSTR(elem, uiaSlotElemCachedLocalType))

			var value string
			if !isPassword {
				value = strings.TrimSpace(appuseCachedPropString(elem, uiaPropValueValue))
				if len([]rune(value)) > 80 {
					r := []rune(value)
					value = string(r[:80]) + "…"
				}
			}
			states := []string{}
			if !enabled {
				states = append(states, "disabled")
			}
			if sel, ok := appuseCachedPropBool(elem, uiaPropSelectionItemIsSelected); ok && sel {
				states = append(states, "selected")
			}
			if toggle, ok := appuseCachedPropInt(elem, uiaPropToggleState); ok {
				switch toggle {
				case 1:
					states = append(states, "checked")
				case 2:
					states = append(states, "indeterminate")
				}
			}
			if ro, ok := appuseCachedPropBool(elem, uiaPropValueIsReadOnly); ok && ro && (kind == 50004 || kind == 50030) {
				states = append(states, "readonly")
			}
			stateStr := strings.Join(states, ",")

			// Detect open menu / popup overlay inside window tree.
			nodeIsOverlay := inOverlay || kind == 50009 || (kind == 50032 && level > 0 && w < winRect.Width)
			if kind == 50009 && level > 0 && bestOverlay == nil && w >= 40 && h >= 24 {
				bestOverlay = &appuseOverlayInfo{
					Kind:       "menu",
					Role:       role,
					Name:       name,
					ScreenRect: cRect,
				}
			}

			// Detect primary scrollable container.
			elemScrollable := false
			if scrollable, ok := appuseCachedPropBool(elem, uiaPropScrollVScrollable); ok && scrollable && w >= 80 && h >= 80 {
				elemScrollable = true
				area := w * h
				if area > bestScrollArea {
					bestScrollArea = area
					var pctPtr, viewPtr *int
					var atTop, atBottom bool
					if pct, ok := appuseCachedPropFloat(elem, uiaPropScrollVPercent); ok && pct >= 0 && pct <= 100 {
						p := int(math.Round(pct))
						pctPtr = &p
						atTop = pct <= 1.0
						atBottom = pct >= 99.0
					}
					if vs, ok := appuseCachedPropFloat(elem, uiaPropScrollVViewSize); ok && vs >= 0 && vs <= 100 {
						v := int(math.Round(vs))
						viewPtr = &v
					}
					extract.PrimaryScroll = &appuseScrollInfo{
						Scrollable: true,
						Direction:  "vertical",
						Percent:    pctPtr,
						ViewSize:   viewPtr,
						AtTop:      atTop,
						AtBottom:   atBottom,
					}
				}
			}

			// Keep candidate controls.
			isLargeContainer := (kind == 50025 || kind == 50033 || kind == 50032 || kind == 50030) &&
				winRect.Width > 0 && winRect.Height > 0 &&
				float64(w*h) > float64(winRect.Width*winRect.Height)*0.55
			interactive := appuseUIAInteractiveKind(kind) || (focusable && !isLargeContainer && (name != "" || autoID != "" || value != ""))
			hasText := name != "" || autoID != "" || value != "" || localType != ""
			keep := (interactive || (!fastOnly && hasText)) && level > 0 && w >= 4 && h >= 4

			if keep && (!fastOnly || enabled) {
				if fastOnly && len(name) == 0 && len(autoID) == 0 && len(value) == 0 && localType != "" {
					name = localType
				}
				if !fastOnly || (interactive && (name != "" || autoID != "" || value != "")) {
					extract.Nodes = append(extract.Nodes, appuseUIANode{
						Role:         role,
						Name:         name,
						AutomationID: autoID,
						Value:        value,
						State:        stateStr,
						Enabled:      enabled,
						Interactive:  interactive,
						Overlay:      nodeIsOverlay,
						Scrollable:   elemScrollable,
						Rect:         cRect,
						Depth:        level,
						Order:        len(extract.Nodes),
					})
				}
			}

			if level >= maxDepth {
				return true
			}
			var child unsafe.Pointer
			if uiaFailed(comCall(walker, uiaSlotWalkerFirstChildBC, uintptr(elem), uintptr(cacheReq), uintptr(unsafe.Pointer(&child)))) != nil {
				truncate("providerError")
				return true
			}
			for child != nil {
				more := walk(child, level+1, nodeIsOverlay)
				if !more {
					comRelease(child)
					return false
				}
				var next unsafe.Pointer
				hr := comCall(walker, uiaSlotWalkerNextSiblingBC, uintptr(child), uintptr(cacheReq), uintptr(unsafe.Pointer(&next)))
				comRelease(child)
				if uiaFailed(hr) != nil {
					truncate("providerError")
					return true
				}
				child = next
			}
			return true
		}

		walk(root, 0, false)
		if bestOverlay != nil {
			bestOverlay.OutsidePoint = appuseComputeOutsidePoint(bestOverlay.ScreenRect, winRect)
			extract.Overlay = bestOverlay
		}
		done <- answer{extract: extract}
	}()

	timer := time.NewTimer(outerTimeout)
	defer timer.Stop()
	select {
	case res := <-done:
		return res.extract, res.err
	case <-timer.C:
		out.Truncated = true
		out.TruncatedBy = "timeBudget"
		return out, fmt.Errorf("控件查询超时，未发送输入；请改用截图，不重复查询")
	}
}

// appuseComputeOutsidePoint 找到遮挡菜单/弹层外的一处安全点击坐标，供 dismiss 动作优先使用。
func appuseComputeOutsidePoint(overlay, bounds appuseControlRect) *appusePoint {
	if overlay.Width <= 0 || overlay.Height <= 0 || bounds.Width <= 0 || bounds.Height <= 0 {
		return nil
	}
	const margin = 24
	const edgePad = 20
	// Prefer bottom, left, bottom-right, or top-left (avoid top-right close button!).
	candidates := [][2]int{
		{overlay.X + overlay.Width/2, overlay.Y + overlay.Height + margin},
		{overlay.X - margin, overlay.Y + overlay.Height/2},
		{overlay.X + overlay.Width + margin, overlay.Y + overlay.Height/2},
		{overlay.X + edgePad, overlay.Y - margin},
	}
	minX := bounds.X + edgePad
	maxX := bounds.X + bounds.Width - edgePad
	minY := bounds.Y + edgePad
	maxY := bounds.Y + bounds.Height - edgePad
	for _, pt := range candidates {
		px, py := pt[0], pt[1]
		if px < minX || px > maxX || py < minY || py > maxY {
			continue
		}
		if px >= overlay.X-8 && px <= overlay.X+overlay.Width+8 && py >= overlay.Y-8 && py <= overlay.Y+overlay.Height+8 {
			continue
		}
		return &appusePoint{X: int32(px), Y: int32(py)}
	}
	return nil
}

// appuseCollectFastUIA 随截图并行顺手抓取轻量 UIA（140ms / 420 节点）；永不阻塞或失败整次截图。
func appuseCollectFastUIA(windowID uint32, selfRects []appuseControlRect) appuseUIAExtract {
	if windowID == 0 {
		return appuseUIAExtract{}
	}
	extract, _ := appuseWalkCachedTree(windowID, 12, 420, 140*time.Millisecond, 260*time.Millisecond, selfRects, true)
	if len(extract.Nodes) > 0 {
		// Sort reading order with overlay elements prioritized or keep visual order top-to-bottom, left-to-right.
		sort.SliceStable(extract.Nodes, func(i, j int) bool {
			a, b := extract.Nodes[i], extract.Nodes[j]
			if a.Overlay != b.Overlay {
				return a.Overlay
			}
			dy := a.Rect.Y - b.Rect.Y
			if dy > 8 || dy < -8 {
				return a.Rect.Y < b.Rect.Y
			}
			return a.Rect.X < b.Rect.X
		})
		// Deduplicate overlapping identical centers and assign sequential IDs 1..N (cap 80).
		filtered := make([]appuseUIANode, 0, minInt(80, len(extract.Nodes)))
		for _, node := range extract.Nodes {
			cx, cy := node.Rect.X+node.Rect.Width/2, node.Rect.Y+node.Rect.Height/2
			dup := false
			for _, prev := range filtered {
				px, py := prev.Rect.X+prev.Rect.Width/2, prev.Rect.Y+prev.Rect.Height/2
				if absInt(cx-px) <= 6 && absInt(cy-py) <= 6 {
					dup = true
					break
				}
			}
			if dup {
				continue
			}
			node.ID = len(filtered) + 1
			filtered = append(filtered, node)
			if len(filtered) >= 80 {
				break
			}
		}
		extract.Nodes = filtered
	}
	return extract
}

// appuseCollectFullUIA 供 appuse_view(screenshot=false) 与观察校验使用（750ms / 900 节点，depth 1..6）。
func appuseCollectFullUIA(windowID uint32, depth, limit int, filter string) (appuseUIAExtract, error) {
	if depth <= 0 {
		depth = 5
	}
	if depth > 6 {
		depth = 6
	}
	if limit <= 0 {
		limit = 40
	}
	if limit > 120 {
		limit = 120
	}
	extract, err := appuseWalkCachedTree(windowID, depth, 900, 750*time.Millisecond, 1500*time.Millisecond, nil, false)
	if err != nil && len(extract.Nodes) == 0 {
		return extract, err
	}
	needle := strings.ToLower(strings.TrimSpace(filter))
	kept := make([]appuseUIANode, 0, minInt(limit, len(extract.Nodes)))
	for _, node := range extract.Nodes {
		if needle != "" {
			hay := strings.ToLower(node.Name + " " + node.AutomationID + " " + node.Role + " " + node.Value)
			if !strings.Contains(hay, needle) {
				continue
			}
		}
		if len(kept) >= limit {
			extract.Truncated = true
			if extract.TruncatedBy == "" {
				extract.TruncatedBy = "itemLimit"
			}
			break
		}
		node.ID = len(kept) + 1
		kept = append(kept, node)
	}
	extract.Nodes = kept
	return extract, nil
}
