//go:build windows

package main

// 蝴蝶提示卡：和 Nova 的 TaskbarBubble 一样用 WebView2 画（HTML/CSS：渐变底、阴影、圆角、拍翅），
// 窗口位置、显隐与鼠标穿透仍由 Go 管；WebView2 运行时不可用时退回 butterfly_windows.go 的 GDI 卡片。
//
// shortcut: 卡片与面板共用一个 WebView2 用户目录，靠 Edge 的跨进程共享把多份运行时并成一个；
// 如果现场发现起不来（Embed 失败只在日志里），提示卡就只剩 GDI 那版，界面不会因此变慢。

import (
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

const (
	butterflyBubbleClass = "VegaButterflyBubbleWeb"
	bubbleParkX          = -20000
	bubbleParkY          = -20000

	bubbleApplyMsg  = 0x8000 + 11 // WM_APP+11：按当前提示更新卡片
	bubbleParkMsg   = 0x8000 + 12 // WM_APP+12：收回屏幕外
	bubbleHeightMsg = 0x8000 + 13 // WM_APP+13：页面量好了高度，按它摆一次
)

var bubbleState struct {
	sync.Mutex
	hwnd         windows.Handle
	browser      *edge.Chromium
	started      bool
	failed       bool // WebView2 不可用：之后的提示直接走 GDI
	ready        bool // 页面已加载，可以 Eval
	card         bubbleCard
	hasCard      bool
	cssHeight    int32
	clickThrough bool
	procedure    uintptr
}

// butterflyShowNotice 优先用 WebView2 画提示卡（与 Nova 的 TaskbarBubble 同一套 HTML/CSS），
// WebView2 不可用时退回 GDI 卡片。
func butterflyShowNotice(notice *butterflyNotice) {
	if butterflyBubbleShow(notice) {
		return
	}
	butterflyCardShow(notice)
}

// butterflyHideNotice 收起提示卡；托盘与任务栏蝴蝶上的状态不受影响。
func butterflyHideNotice() {
	butterflyBubbleHide()
	butterflyCardHide()
}

// bubbleWebView 只查一次运行时：缺 WebView2 就一直走 GDI，不要每条提示都试一次。
var bubbleWebView struct {
	sync.Once
	ok bool
}

func bubbleWebViewReady() bool {
	bubbleWebView.Do(func() {
		version, err := webviewloader.GetInstalledVersion()
		bubbleWebView.ok = err == nil && version != ""
		if !bubbleWebView.ok {
			panelLog("WebView2 运行时不可用（%v），提示卡改回 GDI 画", err)
		}
	})
	return bubbleWebView.ok
}

// butterflyBubbleShow 用 WebView2 弹提示卡；WebView2 不可用时返回 false，调用方退回 GDI 卡片。
func butterflyBubbleShow(notice *butterflyNotice) bool {
	card := bubbleCard{Kind: "running", Title: "正在操作这台电脑", Light: chipLightTheme()}
	clickThrough := false
	if notice != nil {
		card.Body = notice.Text
		if notice.Kind == "needs_review" {
			card.Kind, card.Title = "needs_review", "需要你核对"
		} else {
			// 正在被操作时卡片点不动，也绝不挡住 appuse 要点的位置。
			clickThrough = true
		}
	} else {
		card.Title = "蝴蝶助理"
	}
	return butterflyBubblePush(card, clickThrough)
}

// butterflyConfirm 弹一张要用户作答的卡（现在接管 / 我在用）；没有 WebView2 就没有可点的按钮，
// 返回 false，调用方按「不拒绝默认视为同意」直接开始。
func butterflyConfirm() bool {
	if butterflyQuiet || butterflyDisabled() {
		return false
	}
	return butterflyBubblePush(bubbleCard{Kind: "confirm", Title: "要操作这台电脑了", Body: appuseConfirmText, Light: chipLightTheme()}, false)
}

// butterflyBubblePush 把这张卡交给 WebView2 画；WebView2 不可用时返回 false。
func butterflyBubblePush(card bubbleCard, clickThrough bool) bool {
	if !bubbleWebViewReady() {
		return false
	}
	bubbleState.Lock()
	if bubbleState.failed {
		bubbleState.Unlock()
		return false
	}
	bubbleState.card, bubbleState.hasCard = card, true
	bubbleState.clickThrough = clickThrough
	if !bubbleState.started {
		bubbleState.started = true
		go butterflyBubbleThread()
	}
	hwnd := bubbleState.hwnd
	bubbleState.Unlock()
	if hwnd != 0 {
		_, _, _ = procButterflyPost.Call(uintptr(hwnd), bubbleApplyMsg, 0, 0)
	}
	return true
}

// butterflyBubbleHide 收起提示卡；托盘与任务栏蝴蝶上的状态不受影响。
func butterflyBubbleHide() {
	bubbleState.Lock()
	hasCard := bubbleState.hasCard
	bubbleState.hasCard = false
	hwnd := bubbleState.hwnd
	bubbleState.Unlock()
	if hasCard && hwnd != 0 {
		_, _, _ = procButterflyPost.Call(uintptr(hwnd), bubbleParkMsg, 0, 0)
	}
}

func butterflyBubbleThread() {
	runtime.LockOSThread()
	if hr, _, _ := procButterflyCoInit.Call(0, 2); int32(hr) < 0 { // COINIT_APARTMENTTHREADED
		bubbleState.Lock()
		bubbleState.failed = true
		bubbleState.Unlock()
		panelLog("提示卡 CoInitializeEx 失败 hr=0x%x", uint32(hr))
		return
	}
	defer func() { _, _, _ = procButterflyCoUninit.Call() }()
	instance, _, _ := procButterflyModule.Call(0)
	bubbleState.Lock()
	if bubbleState.procedure == 0 {
		bubbleState.procedure = syscall.NewCallback(butterflyBubbleProcedure)
	}
	procedure := bubbleState.procedure
	bubbleState.Unlock()
	class := chipWindowClass{
		Procedure: procedure,
		Instance:  windows.Handle(instance),
		ClassName: butterflyUTF16(butterflyBubbleClass),
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, last := procChipRegister.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		panelLog("注册提示卡窗口类失败：%v", last)
		return
	}
	dpi := butterflyDPI()
	width := butterflyScale(bubbleCSSWidth, dpi)
	height := butterflyScale(120, dpi)
	const (
		wsPopup      = 0x80000000
		wsVisible    = 0x10000000
		exTopmost    = 0x00000008
		exTool       = 0x00000080
		exNoActivate = 0x08000000
		exNoRedraw   = 0x00200000
	)
	parkX, parkY := int32(bubbleParkX), int32(bubbleParkY)
	hwnd, _, last := procChipCreate.Call(
		exTopmost|exTool|exNoActivate|exNoRedraw,
		uintptr(unsafe.Pointer(butterflyUTF16(butterflyBubbleClass))),
		0,
		wsPopup|wsVisible,
		uintptr(parkX)&0xFFFFFFFF, uintptr(parkY)&0xFFFFFFFF,
		uintptr(width), uintptr(height),
		0, 0, instance, 0)
	if hwnd == 0 {
		panelLog("建提示卡窗口失败：%v", last)
		return
	}
	// 停在工作区外的窗口会被系统判成“被遮挡”，WebView2 会停画；关掉这类节流。
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding")
	chromium := edge.NewChromium()
	chromium.DataPath = butterflyPanelDataDir() + `\webview`
	chromium.MessageCallback = butterflyBubbleMessage
	bubbleState.Lock()
	bubbleState.hwnd = windows.Handle(hwnd)
	bubbleState.Unlock()
	if !chromium.Embed(hwnd) {
		panelLog("提示卡 WebView2 初始化失败")
		bubbleState.Lock()
		bubbleState.failed = true
		bubbleState.hwnd = 0
		bubbleState.Unlock()
		_, _, _ = procChipDestroy.Call(hwnd)
		return
	}
	// 透明背景：页面根是 background:transparent，卡片之外直接透出桌面（阴影就落在这圈透明边上）。
	if c := chromium.GetController(); c != nil {
		if c2 := c.GetICoreWebView2Controller2(); c2 != nil {
			_ = c2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{A: 0, R: 0, G: 0, B: 0})
		}
	}
	chromium.Resize()
	chromium.NavigateToString(butterflyBubbleHTML)
	bubbleState.Lock()
	bubbleState.browser = chromium
	bubbleState.Unlock()
	var message chipMsg
	for {
		result, _, _ := procChipGetMsg.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		_, _, _ = procChipTranslate.Call(uintptr(unsafe.Pointer(&message)))
		_, _, _ = procChipDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func butterflyBubbleProcedure(hwnd windows.Handle, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case 0x0005: // WM_SIZE
		bubbleState.Lock()
		browser := bubbleState.browser
		bubbleState.Unlock()
		if browser != nil {
			browser.Resize()
		}
		return 0
	case 0x0014: // WM_ERASEBKGND：别用系统背景刷，省得闪白
		return 1
	case bubbleApplyMsg:
		butterflyBubbleApply(hwnd)
		return 0
	case bubbleHeightMsg:
		butterflyBubblePlace(hwnd)
		return 0
	case bubbleParkMsg:
		butterflyBubblePark(hwnd)
		return 0
	case 0x0113: // WM_TIMER
		butterflyBubblePark(hwnd)
		return 0
	case 0x0010: // WM_CLOSE
		_, _, _ = procChipDestroy.Call(uintptr(hwnd))
		return 0
	case 0x0002: // WM_DESTROY
		_, _, _ = procPanelQuit.Call(0)
		return 0
	}
	result, _, _ := procChipDefProc.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
	return result
}

// butterflyBubbleMessage 收页面的消息：ready / h:高度 / open（点了卡片）/ answer:确认卡上的选择。
func butterflyBubbleMessage(text string) {
	hwnd := func() windows.Handle {
		bubbleState.Lock()
		defer bubbleState.Unlock()
		return bubbleState.hwnd
	}()
	if hwnd == 0 {
		return
	}
	switch {
	case text == "ready":
		bubbleState.Lock()
		bubbleState.ready = true
		bubbleState.Unlock()
		_, _, _ = procButterflyPost.Call(uintptr(hwnd), bubbleApplyMsg, 0, 0)
	case text == "open":
		_, _, _ = procButterflyPost.Call(uintptr(hwnd), bubbleParkMsg, 0, 0)
		butterflyOpen()
	case strings.HasPrefix(text, "answer:"):
		appuseConfirmAnswer(strings.TrimPrefix(text, "answer:"))
	case len(text) > 2 && text[:2] == "h:":
		if css, ok := atoi32(text[2:]); ok && css > 0 {
			bubbleState.Lock()
			bubbleState.cssHeight = css
			bubbleState.Unlock()
			_, _, _ = procButterflyPost.Call(uintptr(hwnd), bubbleHeightMsg, 0, 0)
		}
	}
}

// atoi32 只解析页面报上来的小整数（免得为一行转换引入 strconv 的错值路径）。
func atoi32(text string) (int32, bool) {
	if text == "" {
		return 0, false
	}
	value := int32(0)
	for _, r := range text {
		if r < '0' || r > '9' || value > 100000 {
			return 0, false
		}
		value = value*10 + int32(r-'0')
	}
	return value, true
}

// butterflyBubbleApply 把当前提示推给页面；高度有记录就先摆出来，没有就等页面量完再摆。
func butterflyBubbleApply(hwnd windows.Handle) {
	bubbleState.Lock()
	card, hasCard, ready, cssHeight := bubbleState.card, bubbleState.hasCard, bubbleState.ready, bubbleState.cssHeight
	browser := bubbleState.browser
	bubbleState.Unlock()
	if !hasCard || browser == nil {
		butterflyBubblePark(hwnd)
		return
	}
	if !ready {
		return // 页面还在加载：ready 那条消息会再进来一次
	}
	payload, err := json.Marshal(card)
	if err != nil {
		return
	}
	browser.Eval("butterflyBubble(" + string(payload) + ")")
	if cssHeight > 0 {
		butterflyBubblePlace(hwnd)
	}
}

// butterflyBubblePlace 摆在任务栏蝴蝶上方，并重新开始自动收起计时（跨屏、缩放的偏差都在这里重算）。
func butterflyBubblePlace(hwnd windows.Handle) {
	bubbleState.Lock()
	cssHeight, clickThrough, browser := bubbleState.cssHeight, bubbleState.clickThrough, bubbleState.browser
	bubbleState.Unlock()
	if browser == nil {
		return
	}
	anchor, work, dpi := butterflyAnchorWork()
	width := butterflyScale(bubbleCSSWidth, dpi)
	height := butterflyScale(240, dpi)
	if cssHeight > 0 {
		height = butterflyScale(cssHeight, dpi)
	}
	// 窗口自带 8px 透明边（放阴影），所以直接贴工作区边就是 Nova 的 8px 视觉间距。
	x, y := butterflyBubbleFrame(anchor, work, width, height, 0, butterflyScale(bubbleCSSEdge, dpi))
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), ^uintptr(0), uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0x0040|0x0010|0x0004) // SHOWWINDOW|NOACTIVATE|NOZORDER
	butterflyBubbleClickThrough(hwnd, clickThrough)
	_, _, _ = procChipTimer.Call(uintptr(hwnd), 1, butterflyHideAfter, 0)
}

// butterflyBubblePark 收回屏幕外（页面和 WebView2 都留着，下次还是热的）。
func butterflyBubblePark(hwnd windows.Handle) {
	parkX, parkY := int32(bubbleParkX), int32(bubbleParkY)
	_, _, _ = procChipUntimer.Call(uintptr(hwnd), 1)
	_, _, _ = procPanelPlace.Call(uintptr(hwnd), 0,
		uintptr(parkX)&0xFFFFFFFF, uintptr(parkY)&0xFFFFFFFF, 0, 0,
		0x0010|0x0004|0x0001|0x0200) // NOACTIVATE|NOZORDER|NOSIZE|NOOWNERZORDER
}

// butterflyBubbleClickThrough 让整张卡（含 WebView2 的子窗口）不接收鼠标：
// 正在操作电脑时绝不能挡住 appuse 要点的位置。
func butterflyBubbleClickThrough(hwnd windows.Handle, on bool) {
	const (
		gwlExStyle    = ^uintptr(19) // GWL_EXSTYLE = -20
		exTransparent = 0x00000020   // WS_EX_TRANSPARENT
	)
	set := func(target uintptr) {
		current, _, _ := procButterflyGetStyle.Call(target, gwlExStyle)
		next := current
		if on {
			next |= exTransparent
		} else {
			next &^= exTransparent
		}
		if next != current {
			_, _, _ = procButterflySetStyle.Call(target, gwlExStyle, next)
		}
	}
	set(uintptr(hwnd))
	_, _, _ = procChipEnumChild.Call(uintptr(hwnd), bubbleEnumTransparent, 0)
}

var bubbleEnumTransparent = syscall.NewCallback(func(child uintptr, _ uintptr) uintptr {
	style, _, _ := procButterflyGetStyle.Call(child, ^uintptr(19))
	const exTransparent = 0x00000020
	if style&exTransparent == 0 {
		_, _, _ = procButterflySetStyle.Call(child, ^uintptr(19), style|exTransparent)
	}
	return 1
})
