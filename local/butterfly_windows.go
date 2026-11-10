//go:build windows

package main

// 蝴蝶气泡：托盘旁的一块原生小窗，只在需要用户看一眼时出现（正在操作电脑、可能已部分执行）。
// 不用 WebView：这里只放一两行字是一句提示，点一下打开网页里的 BOT 会话。
// 外观照抄 Nova 数字员工的气泡卡（TaskbarBubble.css 的 .tb-card）：
// 同底色/描边/16px 圆角，头部是着色的蝴蝶 + 状态文字，正文在下方；状态色跟随任务栏浅深主题。

import (
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	butterflyClassName = "VegaButterflyBubble"
	butterflyShowMsg   = 0x0400 + 1 // WM_APP + 1
	butterflyHideMsg   = 0x0400 + 2
	butterflyCardWidth = 344
	butterflyPadding   = 16 // .tb-card 左右 16
	butterflyTop       = 14 // 上 14、下 12
	butterflyBottom    = 12
	butterflyGap       = 10 // 头部与正文的间距
	butterflyCorner    = 16 // 圆角 16
	butterflyIcon      = 16 // 头部蝴蝶的宽度
	butterflyHideAfter = 22000
)

const (
	butterflyDTWordBreak = 0x0010
	butterflyDTNoPrefix  = 0x0800
	butterflyDTCalcRect  = 0x0400
	butterflyDTSingle    = 0x0020
	butterflyDTVCenter   = 0x0004
)

var (
	butterflyWin32 = windows.NewLazySystemDLL("user32.dll")
	butterflyGDI32 = windows.NewLazySystemDLL("gdi32.dll")
	butterflyK32   = windows.NewLazySystemDLL("kernel32.dll")
	butterflyOle32 = windows.NewLazySystemDLL("ole32.dll")

	procButterflyRegister  = butterflyWin32.NewProc("RegisterClassExW")
	procButterflyCreate    = butterflyWin32.NewProc("CreateWindowExW")
	procButterflyDefProc   = butterflyWin32.NewProc("DefWindowProcW")
	procButterflyPost      = butterflyWin32.NewProc("PostMessageW")
	procButterflyGetMsg    = butterflyWin32.NewProc("GetMessageW")
	procButterflyTrans     = butterflyWin32.NewProc("TranslateMessage")
	procButterflyDispatch  = butterflyWin32.NewProc("DispatchMessageW")
	procButterflyBegin     = butterflyWin32.NewProc("BeginPaint")
	procButterflyEnd       = butterflyWin32.NewProc("EndPaint")
	procButterflyTimer     = butterflyWin32.NewProc("SetTimer")
	procButterflyUntimer   = butterflyWin32.NewProc("KillTimer")
	procButterflyRgn       = butterflyWin32.NewProc("SetWindowRgn")
	procButterflyDpi       = butterflyWin32.NewProc("GetDpiForSystem")
	procButterflyParams    = butterflyWin32.NewProc("SystemParametersInfoW")
	procButterflyMonitorPt = butterflyWin32.NewProc("MonitorFromPoint")
	procButterflyPlace     = butterflyWin32.NewProc("SetWindowPos")
	procButterflyInvalid   = butterflyWin32.NewProc("InvalidateRect")
	procButterflyGetStyle  = butterflyWin32.NewProc("GetWindowLongPtrW")
	procButterflySetStyle  = butterflyWin32.NewProc("SetWindowLongPtrW")
	procButterflyFind      = butterflyWin32.NewProc("FindWindowW")
	procButterflyCoInit    = butterflyOle32.NewProc("CoInitializeEx")
	procButterflyCoUninit  = butterflyOle32.NewProc("CoUninitialize")
	procButterflyGetDC     = butterflyWin32.NewProc("GetDC")
	procButterflyRelease   = butterflyWin32.NewProc("ReleaseDC")
	procButterflyModule    = butterflyK32.NewProc("GetModuleHandleW")

	procButterflyRoundRgn  = butterflyGDI32.NewProc("CreateRoundRectRgn")
	procButterflyBrush     = butterflyGDI32.NewProc("CreateSolidBrush")
	procButterflyPen       = butterflyGDI32.NewProc("CreatePen")
	procButterflySelect    = butterflyGDI32.NewProc("SelectObject")
	procButterflyDelete    = butterflyGDI32.NewProc("DeleteObject")
	procButterflyFont      = butterflyGDI32.NewProc("CreateFontW")
	procButterflyColor     = butterflyGDI32.NewProc("SetTextColor")
	procButterflyBkMode    = butterflyGDI32.NewProc("SetBkMode")
	procButterflyText      = butterflyWin32.NewProc("DrawTextW")
	procButterflyRoundRect = butterflyGDI32.NewProc("RoundRect")
)

type butterflyBubble struct {
	sync.Mutex
	hwnd         windows.Handle
	threading    bool
	title        string
	body         string
	accent       uint32
	clickThrough bool
	height       int32
	width        int32
	textTop      int32
	headHeight   int32
	light        bool
	dpi          uint32
	titleFont    windows.Handle
	bodyFont     windows.Handle
	fontDPI      uint32
	procedure    uintptr
}

var butterflyBubbleState butterflyBubble

func butterflyUTF16(text string) *uint16 {
	pointer, err := windows.UTF16PtrFromString(text)
	if err != nil {
		pointer, _ = windows.UTF16PtrFromString("")
	}
	return pointer
}

func butterflyDPI() uint32 {
	if dpi, _, _ := procButterflyDpi.Call(); dpi >= 96 {
		return uint32(dpi)
	}
	return 96
}

func butterflyScale(value int32, dpi uint32) int32 { return value * int32(dpi) / 96 }

// butterflyCardShow 是 WebView2 不可用时的 GDI 卡片：同样的卡面与落点，不依赖浏览器运行时。
// butterflyShowNotice 弹一条提示：浮在任务栏蝴蝶上方（找不到蝴蝶时退到鼠标所在屏幕右下角）；
// 同一条内容只更新，不反复弹。
func butterflyCardShow(notice *butterflyNotice) {
	title, body, clickThrough := "蝴蝶助理", "", false
	signal := chipRunning
	if notice != nil && notice.Kind == "needs_review" {
		title, body, signal = "需要你核对", notice.Text, chipWaiting
	} else if notice != nil {
		// 正在被操作时气泡点不动，也绝不挡住 appuse 要点的位置。
		title, body, clickThrough = "正在操作这台电脑", notice.Text, true
	}
	// 状态色与浅深主题都取任务栏那套（Nova signal()/light 的 Windows 部分）。
	light := chipLightTheme()
	butterflyBubbleState.Lock()
	butterflyBubbleState.title, butterflyBubbleState.body = title, body
	butterflyBubbleState.accent, butterflyBubbleState.light = chipSignal(light, signal), light
	butterflyBubbleState.clickThrough = clickThrough
	started, hwnd := butterflyBubbleState.threading, butterflyBubbleState.hwnd
	butterflyBubbleState.threading = true
	butterflyBubbleState.Unlock()
	if hwnd != 0 {
		_, _, _ = procButterflyPost.Call(uintptr(hwnd), butterflyShowMsg, 0, 0)
		return
	}
	if !started {
		go butterflyThread()
	}
}

// butterflyCardHide 收起 GDI 卡片；托盘上的提示还在。
func butterflyCardHide() {
	butterflyBubbleState.Lock()
	hwnd := butterflyBubbleState.hwnd
	butterflyBubbleState.Unlock()
	if hwnd != 0 {
		_, _, _ = procButterflyPost.Call(uintptr(hwnd), butterflyHideMsg, 0, 0)
	}
}

func butterflyThread() {
	runtime.LockOSThread()
	instance, _, _ := procButterflyModule.Call(0)
	butterflyBubbleState.Lock()
	if butterflyBubbleState.procedure == 0 {
		butterflyBubbleState.procedure = syscall.NewCallback(butterflyProcedure)
	}
	procedure := butterflyBubbleState.procedure
	butterflyBubbleState.Unlock()
	class := struct {
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
		SmallIcon  windows.Handle
	}{Procedure: procedure, Instance: windows.Handle(instance), ClassName: butterflyUTF16(butterflyClassName)}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, _ := procButterflyRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return
	}
	const (
		popup      = 0x80000000
		topmost    = 0x00000008
		toolWindow = 0x00000080
		noActivate = 0x08000000
	)
	hwnd, _, _ := procButterflyCreate.Call(topmost|toolWindow|noActivate, uintptr(unsafe.Pointer(class.ClassName)), 0, popup, 0, 0, 1, 1, 0, 0, instance, 0)
	if hwnd == 0 {
		return
	}
	butterflyBubbleState.Lock()
	butterflyBubbleState.hwnd = windows.Handle(hwnd)
	butterflyBubbleState.Unlock()
	_, _, _ = procButterflyPost.Call(hwnd, butterflyShowMsg, 0, 0)
	var message struct {
		Hwnd     windows.Handle
		Message  uint32
		WParam   uintptr
		LParam   uintptr
		Time     uint32
		Pt       appuseWinPoint
		LPrivate uint32
	}
	for {
		result, _, _ := procButterflyGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = procButterflyTrans.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procButterflyDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func butterflyProcedure(hwnd windows.Handle, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case 0x000f: // WM_PAINT
		butterflyPaint(hwnd)
		return 0
	case butterflyShowMsg:
		butterflyPlace(hwnd)
		butterflyBubbleState.Lock()
		clickThrough := butterflyBubbleState.clickThrough
		butterflyBubbleState.Unlock()
		butterflyClickThrough(hwnd, clickThrough)
		_, _, _ = procShowWindow.Call(uintptr(hwnd), 4) // SW_SHOWNOACTIVATE
		_, _, _ = procButterflyTimer.Call(uintptr(hwnd), 1, butterflyHideAfter, 0)
		return 0
	case butterflyHideMsg:
		_, _, _ = procButterflyUntimer.Call(uintptr(hwnd), 1)
		_, _, _ = procShowWindow.Call(uintptr(hwnd), 0) // SW_HIDE
		return 0
	case 0x0113: // WM_TIMER
		_, _, _ = procShowWindow.Call(uintptr(hwnd), 0)
		_, _, _ = procButterflyUntimer.Call(uintptr(hwnd), 1)
		return 0
	case 0x0200: // WM_MOUSEMOVE：鼠标在上面时不自动消失，方便点进去
		_, _, _ = procButterflyTimer.Call(uintptr(hwnd), 1, butterflyHideAfter, 0)
		return 0
	case 0x0202: // WM_LBUTTONUP
		butterflyOpen()
		_, _, _ = procShowWindow.Call(uintptr(hwnd), 0)
		return 0
	case 0x0002: // WM_DESTROY
		return 0
	}
	result, _, _ := procButterflyDefProc.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
	return result
}

func butterflyFonts(dpi uint32) (windows.Handle, windows.Handle) {
	butterflyBubbleState.Lock()
	defer butterflyBubbleState.Unlock()
	if butterflyBubbleState.fontDPI != dpi || butterflyBubbleState.titleFont == 0 {
		if butterflyBubbleState.titleFont != 0 {
			_, _, _ = procButterflyDelete.Call(uintptr(butterflyBubbleState.titleFont))
		}
		if butterflyBubbleState.bodyFont != 0 {
			_, _, _ = procButterflyDelete.Call(uintptr(butterflyBubbleState.bodyFont))
		}
		// .tb-state 13.5px/600、正文 13px：GDI 取 14 与 13。
		butterflyBubbleState.titleFont = butterflyNewFont(butterflyScale(14, dpi), 600)
		butterflyBubbleState.bodyFont = butterflyNewFont(butterflyScale(13, dpi), 400)
		butterflyBubbleState.fontDPI = dpi
	}
	return butterflyBubbleState.titleFont, butterflyBubbleState.bodyFont
}

func butterflyNewFont(height int32, weight uintptr) windows.Handle {
	face := butterflyUTF16("Microsoft YaHei UI")
	// DEFAULT_CHARSET + CLEARTYPE_QUALITY + FF_SWISS（中英文都能显示的 UI 字体）。
	font, _, _ := procButterflyFont.Call(uintptr(-height), 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0x20, uintptr(unsafe.Pointer(face)))
	return windows.Handle(font)
}

// butterflyClickThrough 在“正在操作电脑”时让气泡不接收鼠标，避免挡住 appuse 的点击。
func butterflyClickThrough(hwnd windows.Handle, clickThrough bool) {
	gwlExStyle := ^uintptr(19)       // GWL_EXSTYLE = -20
	const exTransparent = 0x00000020 // WS_EX_TRANSPARENT
	style, _, _ := procButterflyGetStyle.Call(uintptr(hwnd), gwlExStyle)
	next := style
	if clickThrough {
		next |= exTransparent
	} else {
		next &^= exTransparent
	}
	if next != style {
		_, _, _ = procButterflySetStyle.Call(uintptr(hwnd), gwlExStyle, next)
	}
}

func butterflyMeasure(hdc uintptr, text string, font windows.Handle, width int32, single bool) int32 {
	if text == "" {
		return 0
	}
	rect := appuseWinRect{Right: width, Bottom: 4000}
	flags := uintptr(butterflyDTNoPrefix | butterflyDTCalcRect)
	if single {
		flags |= butterflyDTSingle
	} else {
		flags |= butterflyDTWordBreak
	}
	previous, _, _ := procButterflySelect.Call(hdc, uintptr(font))
	_, _, _ = procButterflyText.Call(hdc, uintptr(unsafe.Pointer(butterflyUTF16(text))), ^uintptr(0), uintptr(unsafe.Pointer(&rect)), flags)
	_, _, _ = procButterflySelect.Call(hdc, previous)
	return rect.Bottom
}

// butterflyAnchor 找任务栏上的蝴蝶；找不到就是空矩形，调用方退回鼠标所在屏幕右下角。
func butterflyAnchor() (appuseWinRect, uintptr) {
	anchor := appuseWinRect{}
	// 任务栏蝴蝶是 Shell_TrayWnd 的子窗口，FindWindowW 找顶层窗口，得用 FindWindowExW。
	if taskbar, _, _ := procPanelFind.Call(uintptr(unsafe.Pointer(butterflyUTF16("Shell_TrayWnd"))), 0); taskbar != 0 {
		if child, _, _ := procPanelFindChild.Call(taskbar, 0, uintptr(unsafe.Pointer(butterflyUTF16(butterflyChipClass))), 0); child != 0 {
			_, _, _ = procWindowRect.Call(child, uintptr(unsafe.Pointer(&anchor)))
			return anchor, child
		}
	}
	return anchor, 0
}

// butterflyBubbleFrame 气泡落点：对齐 Nova 的 ask 小气泡（bubble::frame），
// 居中在蝴蝶上、贴住工作区边，始终夹在工作区内（不压任务栏、不出屏）。
func butterflyBubbleFrame(anchor, work appuseWinRect, width, height, gap, margin int32) (int32, int32) {
	x, y := work.Right-width-margin, work.Bottom-height-gap
	if anchor.Right > anchor.Left {
		x = (anchor.Left+anchor.Right)/2 - width/2
		if x < work.Left+margin {
			x = work.Left + margin
		}
		if x+width > work.Right-margin {
			x = work.Right - margin - width
		}
		if above := anchor.Top - height - gap; anchor.Top+anchor.Bottom < work.Top+work.Bottom {
			y = work.Top + gap // 任务栏在上边
		} else if above >= work.Top+margin && above < y {
			y = above // 任务栏自动隐藏时贴着蝴蝶上沿
		}
	}
	if y < work.Top+margin {
		y = work.Top + margin
	}
	if y+height > work.Bottom-gap {
		y = work.Bottom - gap - height
	}
	return x, y
}

// butterflyAnchorWork 找蝴蝶、它所在显示器的工作区和缩放；找不到蝴蝶就用鼠标所在屏幕。
func butterflyAnchorWork() (appuseWinRect, appuseWinRect, uint32) {
	anchor, chip := butterflyAnchor()
	var point appuseWinPoint
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	dpi := butterflyDPI()
	if anchor.Right > anchor.Left {
		point = appuseWinPoint{X: (anchor.Left + anchor.Right) / 2, Y: anchor.Top}
		// 蝴蝶在哪块屏、什么缩放，卡片就跟到哪，不跨屏幕串缩放。
		if scaled, _, _ := procPanelDpi.Call(chip); scaled >= 96 {
			dpi = uint32(scaled)
		}
	}
	work := appuseWinRect{}
	// MonitorFromPoint 的 POINT 是按值传的：x64 下两个 int32 拼进一个寄存器，传指针会拿到错的显示器。
	packed := uintptr(uint32(point.X)) | uintptr(uint32(point.Y))<<32
	if monitor, _, _ := procButterflyMonitorPt.Call(packed, 2); monitor != 0 { // MONITOR_DEFAULTTONEAREST
		info := struct {
			Size    uint32
			Monitor appuseWinRect
			Work    appuseWinRect
			Flags   uint32
		}{}
		info.Size = uint32(unsafe.Sizeof(info))
		if ok, _, _ := procMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); ok != 0 {
			work = info.Work
		}
	}
	if work.Right == 0 && work.Bottom == 0 {
		_, _, _ = procButterflyParams.Call(0x0030, 0, uintptr(unsafe.Pointer(&work)), 0) // SPI_GETWORKAREA
	}
	return anchor, work, dpi
}

// butterflyPlace 量出高度，浮在任务栏蝴蝶上方（对齐 Nova 的 ask 小气泡：居中在蝴蝶上、贴住工作区边）；
// 找不到蝴蝶就退到鼠标所在屏幕的右下角。
func butterflyPlace(hwnd windows.Handle) {
	butterflyBubbleState.Lock()
	title, body := butterflyBubbleState.title, butterflyBubbleState.body
	butterflyBubbleState.Unlock()
	anchor, work, dpi := butterflyAnchorWork()
	width := butterflyScale(butterflyCardWidth, dpi)
	padding := butterflyScale(butterflyPadding, dpi)
	top, bottom := butterflyScale(butterflyTop, dpi), butterflyScale(butterflyBottom, dpi)
	headGap, icon := butterflyScale(butterflyGap, dpi), butterflyScale(butterflyIcon, dpi)
	titleFont, bodyFont := butterflyFonts(dpi)
	hdc, _, _ := procButterflyGetDC.Call(uintptr(hwnd))
	titleHeight := butterflyMeasure(hdc, title, titleFont, width-padding*2-icon-headGap, true)
	bodyHeight := butterflyMeasure(hdc, body, bodyFont, width-padding*2, false)
	_, _, _ = procButterflyRelease.Call(uintptr(hwnd), hdc)
	if bodyHeight <= 0 {
		bodyHeight = butterflyScale(18, dpi)
	}
	// 头部高度至少容得下蝴蝶；正文从头部下方 headGap 处开始。
	headHeight := max32(titleHeight, icon)
	textTop := top + headHeight + headGap
	height := textTop + bodyHeight + bottom
	butterflyBubbleState.Lock()
	butterflyBubbleState.width, butterflyBubbleState.height = width, height
	butterflyBubbleState.textTop, butterflyBubbleState.headHeight = textTop, headHeight
	butterflyBubbleState.dpi = dpi
	butterflyBubbleState.Unlock()
	region, _, _ := procButterflyRoundRgn.Call(0, 0, uintptr(width+1), uintptr(height+1), butterflyCorner*2, butterflyCorner*2)
	_, _, _ = procButterflyRgn.Call(uintptr(hwnd), region, 1)
	// 离任务栏/工作区边 8dp（Nova 的 ask 气泡是窗口自带 8px 透明边，这里直接当间距）。
	gap, margin := butterflyScale(8, dpi), butterflyScale(8, dpi)
	x, y := butterflyBubbleFrame(anchor, work, width, height, gap, margin)
	_, _, _ = procButterflyPlace.Call(uintptr(hwnd), ^uintptr(0), uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0x0010|0x0040)
	_, _, _ = procButterflyInvalid.Call(uintptr(hwnd), 0, 1)
}

// butterflyPaper 是 Nova 气泡卡的底色/描边/文字色：浅色 #f8f9fc，深色 #202128。
func butterflyPaper(light bool) (background, border, ink, body uint32) {
	if light {
		return chipRGB(248, 249, 252), chipRGB(226, 227, 230), chipRGB(0, 0, 0), chipRGB(66, 66, 66)
	}
	return chipRGB(32, 33, 40), chipRGB(52, 53, 60), chipRGB(255, 255, 255), chipRGB(199, 199, 204)
}

func butterflyPaint(hwnd windows.Handle) {
	var paint struct {
		Hdc       windows.Handle
		Erase     int32
		Rect      appuseWinRect
		Restore   int32
		IncUpdate int32
		Reserved  [32]byte
	}
	hdc, _, _ := procButterflyBegin.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return
	}
	defer func() { _, _, _ = procButterflyEnd.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&paint))) }()
	butterflyBubbleState.Lock()
	title, body, accent, light := butterflyBubbleState.title, butterflyBubbleState.body, butterflyBubbleState.accent, butterflyBubbleState.light
	width, height := butterflyBubbleState.width, butterflyBubbleState.height
	textTop, headHeight := butterflyBubbleState.textTop, butterflyBubbleState.headHeight
	titleFont, bodyFont := butterflyBubbleState.titleFont, butterflyBubbleState.bodyFont
	dpi := butterflyBubbleState.dpi
	butterflyBubbleState.Unlock()
	if dpi < 96 {
		dpi = butterflyDPI()
	}
	padding := butterflyScale(butterflyPadding, dpi)
	top, bottom := butterflyScale(butterflyTop, dpi), butterflyScale(butterflyBottom, dpi)
	gap, icon := butterflyScale(butterflyGap, dpi), butterflyScale(butterflyIcon, dpi)
	background, border, ink, muted := butterflyPaper(light)
	// 卡片：底色 + 1px 描边 + 16px 圆角（.tb-card）。
	brush, _, _ := procButterflyBrush.Call(uintptr(background))
	pen, _, _ := procButterflyPen.Call(0, 1, uintptr(border))
	previousBrush, _, _ := procButterflySelect.Call(hdc, brush)
	previousPen, _, _ := procButterflySelect.Call(hdc, pen)
	_, _, _ = procButterflyRoundRect.Call(hdc, 0, 0, uintptr(width), uintptr(height), butterflyCorner*2, butterflyCorner*2)
	// 头部：状态色的蝴蝶（与任务栏胶囊同一只）+ 状态文字，正文在下。
	chipButterfly(hdc, padding+icon/2, top+headHeight/2, float64(icon)/float64(butterflyIcon),
		chipPoseAt(0, false, false), accent, background, ink, false)
	_, _, _ = procButterflyBkMode.Call(hdc, 1) // 透明背景
	_, _, _ = procButterflyColor.Call(hdc, uintptr(ink))
	_, _, _ = procButterflySelect.Call(hdc, uintptr(titleFont))
	titleRect := appuseWinRect{Left: padding + icon + gap, Top: top, Right: width - padding, Bottom: top + headHeight}
	_, _, _ = procButterflyText.Call(hdc, uintptr(unsafe.Pointer(butterflyUTF16(title))), ^uintptr(0), uintptr(unsafe.Pointer(&titleRect)), butterflyDTNoPrefix|butterflyDTSingle|butterflyDTVCenter)
	_, _, _ = procButterflyColor.Call(hdc, uintptr(muted))
	_, _, _ = procButterflySelect.Call(hdc, uintptr(bodyFont))
	bodyRect := appuseWinRect{Left: padding, Top: textTop, Right: width - padding, Bottom: height - bottom}
	_, _, _ = procButterflyText.Call(hdc, uintptr(unsafe.Pointer(butterflyUTF16(body))), ^uintptr(0), uintptr(unsafe.Pointer(&bodyRect)), butterflyDTNoPrefix|butterflyDTWordBreak)
	_, _, _ = procButterflySelect.Call(hdc, previousBrush)
	_, _, _ = procButterflySelect.Call(hdc, previousPen)
	for _, object := range []uintptr{brush, pen} {
		_, _, _ = procButterflyDelete.Call(object)
	}
}
