//go:build darwin && cgo

package main

// macOS 蝴蝶悬浮提示与操作前确认卡：使用非激活透明 NSPanel 嵌入 WKWebView 复用 butterflyBubbleHTML。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdlib.h>

extern void goVegaBubbleMessage(char *msg);

static NSPanel *gBubblePanel = nil;
static WKWebView *gBubbleWebView = nil;
static NSTimer *gBubbleHideTimer = nil;
static BOOL gBubbleReady = NO;
static int gBubbleCSSHeight = 140;
static BOOL gBubbleClickThrough = NO;
static NSString *gBubblePendingJSON = nil;

static void vega_bubble_position_locked(void) {
	if (!gBubblePanel) return;
	NSPoint mouse = [NSEvent mouseLocation];
	NSScreen *target = [NSScreen mainScreen];
	for (NSScreen *s in [NSScreen screens]) {
		if (NSPointInRect(mouse, [s frame])) {
			target = s;
			break;
		}
	}
	NSRect vis = target ? [target visibleFrame] : NSMakeRect(0, 0, 1440, 900);
	CGFloat width = 360.0;
	CGFloat height = (CGFloat)(gBubbleCSSHeight > 0 ? gBubbleCSSHeight : 140);
	CGFloat x = NSMaxX(vis) - width - 8.0;
	CGFloat y = NSMaxY(vis) - height - 8.0;
	if (x < vis.origin.x + 8.0) x = vis.origin.x + 8.0;
	if (y < vis.origin.y + 8.0) y = vis.origin.y + 8.0;
	[gBubblePanel setFrame:NSMakeRect(x, y, width, height) display:YES];
}

@interface VegaBubbleHandler : NSObject <WKScriptMessageHandler>
@end

@implementation VegaBubbleHandler

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
	if (![message.name isEqualToString:@"vegaBubble"]) return;
	NSString *body = [message.body isKindOfClass:[NSString class]] ? (NSString *)message.body : [NSString stringWithFormat:@"%@", message.body];
	if (body) {
		goVegaBubbleMessage((char *)[body UTF8String]);
	}
}

- (void)onHideTimer:(NSTimer *)timer {
	gBubbleHideTimer = nil;
	if (gBubblePanel) {
		[gBubblePanel orderOut:nil];
	}
}

@end

static VegaBubbleHandler *gBubbleHandler = nil;

static void vega_bubble_schedule_hide(BOOL enableTimer) {
	if (gBubbleHideTimer) {
		[gBubbleHideTimer invalidate];
		gBubbleHideTimer = nil;
	}
	if (enableTimer && gBubbleHandler) {
		gBubbleHideTimer = [NSTimer scheduledTimerWithTimeInterval:22.0
			target:gBubbleHandler
			selector:@selector(onHideTimer:)
			userInfo:nil
			repeats:NO];
	}
}

static void vega_bubble_ensure_panel(const char *htmlStr) {
	if (gBubblePanel) return;
	[NSApplication sharedApplication];
	gBubbleHandler = [[VegaBubbleHandler alloc] init];

	NSRect frame = NSMakeRect(100, 100, 360, 140);
	gBubblePanel = [[NSPanel alloc] initWithContentRect:frame
		styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
		backing:NSBackingStoreBuffered
		defer:NO];
	[gBubblePanel setLevel:NSFloatingWindowLevel];
	[gBubblePanel setFloatingPanel:YES];
	[gBubblePanel setHidesOnDeactivate:NO];
	[gBubblePanel setOpaque:NO];
	[gBubblePanel setBackgroundColor:[NSColor clearColor]];
	[gBubblePanel setHasShadow:NO];
	[gBubblePanel setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorTransient];

	WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
	WKUserContentController *ucc = [[WKUserContentController alloc] init];
	[ucc addScriptMessageHandler:gBubbleHandler name:@"vegaBubble"];
	NSString *shim =
		@"window.chrome = window.chrome || {};"
		 "window.chrome.webview = {"
		 "  postMessage: function(msg) {"
		 "    try { window.webkit.messageHandlers.vegaBubble.postMessage(String(msg)); } catch (e) {}"
		 "  }"
		 "};";
	WKUserScript *script = [[WKUserScript alloc] initWithSource:shim
		injectionTime:WKUserScriptInjectionTimeAtDocumentStart
		forMainFrameOnly:YES];
	[ucc addUserScript:script];
	[config setUserContentController:ucc];

	gBubbleWebView = [[WKWebView alloc] initWithFrame:[[gBubblePanel contentView] bounds] configuration:config];
	[gBubbleWebView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
	[gBubbleWebView setValue:@(NO) forKey:@"drawsBackground"];
	[gBubblePanel setContentView:gBubbleWebView];

	NSString *html = htmlStr ? [NSString stringWithUTF8String:htmlStr] : @"";
	[gBubbleWebView loadHTMLString:html baseURL:[NSURL URLWithString:@"about:blank"]];
}

static void vega_bubble_apply_pending(void) {
	if (!gBubbleReady || !gBubbleWebView || !gBubblePendingJSON) return;
	NSString *js = [NSString stringWithFormat:@"window.butterflyBubble(%@);", gBubblePendingJSON];
	[gBubbleWebView evaluateJavaScript:js completionHandler:nil];
	vega_bubble_position_locked();
	[gBubblePanel setIgnoresMouseEvents:gBubbleClickThrough];
	[gBubblePanel orderFrontRegardless];
}

static void vega_bubble_push(const char *htmlStr, const char *jsonStr, int clickThrough, int autoHide) {
	NSString *htmlCopy = htmlStr ? [NSString stringWithUTF8String:htmlStr] : @"";
	NSString *jsonCopy = jsonStr ? [NSString stringWithUTF8String:jsonStr] : @"{}";
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			vega_bubble_ensure_panel([htmlCopy UTF8String]);
			gBubblePendingJSON = jsonCopy;
			gBubbleClickThrough = (clickThrough != 0);
			vega_bubble_schedule_hide(autoHide != 0);
			if (gBubbleReady) {
				vega_bubble_apply_pending();
			}
		}
	});
}

static void vega_bubble_ready(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			gBubbleReady = YES;
			vega_bubble_apply_pending();
		}
	});
}

static void vega_bubble_set_height(int cssHeight) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			if (cssHeight > 0) {
				gBubbleCSSHeight = cssHeight;
				if (gBubblePanel && [gBubblePanel isVisible]) {
					vega_bubble_position_locked();
				}
			}
		}
	});
}

static void vega_bubble_hide(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			vega_bubble_schedule_hide(NO);
			gBubblePendingJSON = nil;
			if (gBubblePanel) {
				[gBubblePanel orderOut:nil];
			}
		}
	});
}

static int vega_is_light_appearance(void) {
	NSString *style = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleInterfaceStyle"];
	return (style && [style caseInsensitiveCompare:@"Dark"] == NSOrderedSame) ? 0 : 1;
}

static void vega_active_screen_work_area(int *outL, int *outT, int *outR, int *outB) {
	__block int l = 0, t = 25, r = 1440, b = 900;
	void (^query)(void) = ^{
		@autoreleasepool {
			NSArray<NSScreen *> *screens = [NSScreen screens];
			if ([screens count] == 0) return;
			double primaryH = [screens objectAtIndex:0].frame.size.height;
			NSPoint mouse = [NSEvent mouseLocation];
			NSScreen *target = [NSScreen mainScreen];
			for (NSScreen *s in screens) {
				if (NSPointInRect(mouse, [s frame])) {
					target = s;
					break;
				}
			}
			if (!target) target = [screens objectAtIndex:0];
			NSRect vis = [target visibleFrame];
			l = (int)llround(vis.origin.x);
			r = (int)llround(vis.origin.x + vis.size.width);
			t = (int)llround(primaryH - (vis.origin.y + vis.size.height));
			b = (int)llround(primaryH - vis.origin.y);
		}
	};
	if ([NSThread isMainThread]) {
		query();
	} else {
		dispatch_sync(dispatch_get_main_queue(), query);
	}
	*outL = l; *outT = t; *outR = r; *outB = b;
}
*/
import "C"

import (
	"encoding/json"
	"strconv"
	"strings"
	"unsafe"
)

func butterflyAnchorWork() (appuseWinRect, appuseWinRect, uint32) {
	var l, t, r, b C.int
	C.vega_active_screen_work_area(&l, &t, &r, &b)
	return appuseWinRect{}, appuseWinRect{Left: int32(l), Top: int32(t), Right: int32(r), Bottom: int32(b)}, 96
}

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
			y = work.Top + gap
		} else if above >= work.Top+margin && above < y {
			y = above
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

func handleDarwinBubbleMessage(text string) {
	switch {
	case text == "ready":
		C.vega_bubble_ready()
	case text == "open":
		C.vega_bubble_hide()
		go butterflyOpen()
	case strings.HasPrefix(text, "answer:"):
		C.vega_bubble_hide()
		appuseConfirmAnswer(strings.TrimPrefix(text, "answer:"))
	case strings.HasPrefix(text, "h:"):
		if h, err := strconv.Atoi(strings.TrimPrefix(text, "h:")); err == nil && h > 0 {
			C.vega_bubble_set_height(C.int(h))
		}
	}
}

func butterflyBubblePush(card bubbleCard, clickThrough, autoHide bool) bool {
	payload, err := json.Marshal(card)
	if err != nil {
		return false
	}
	cHTML := C.CString(butterflyBubbleHTML)
	cJSON := C.CString(string(payload))
	defer C.free(unsafe.Pointer(cHTML))
	defer C.free(unsafe.Pointer(cJSON))
	ct, ah := C.int(0), C.int(0)
	if clickThrough {
		ct = 1
	}
	if autoHide {
		ah = 1
	}
	C.vega_bubble_push(cHTML, cJSON, ct, ah)
	return true
}

func butterflyShowNotice(notice *butterflyNotice) {
	light := C.vega_is_light_appearance() != 0
	card := bubbleCard{Kind: "running", Title: "正在操作这台电脑", Light: light}
	clickThrough := false
	if notice != nil {
		card.Body = notice.Text
		if notice.Kind == "needs_review" {
			card.Kind, card.Title = "needs_review", "需要你核对"
		} else {
			clickThrough = true
		}
	} else {
		card.Title = "蝴蝶助理"
	}
	butterflyBubblePush(card, clickThrough, true)
}

func butterflyHideNotice() {
	C.vega_bubble_hide()
}

func butterflyConfirm() bool {
	if butterflyQuiet || butterflyDisabled() {
		return false
	}
	light := C.vega_is_light_appearance() != 0
	return butterflyBubblePush(bubbleCard{Kind: "confirm", Title: "要操作这台电脑了", Body: appuseConfirmText, Light: light}, false, false)
}
