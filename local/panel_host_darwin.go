//go:build darwin && cgo

package main

// 面板自己的 Cocoa 窗口保留 Dock 最小化与缩放；Grok 对话页的无边框标题栏由 WKWebView 绘制。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdlib.h>

extern void goVegaPanelMessage(char *msg);
extern void goVegaPanelGeometryChanged(int x, int y, int w, int h);
extern void goVegaPanelNavigationFinished(void);

static NSWindow *gPanelWindow = nil;
static WKWebView *gPanelWebView = nil;
static NSEvent *gLastMouseDownEvent = nil;
static id gMouseMonitor = nil;
static BOOL gPanelGrokMode = NO;

static double vega_primary_screen_height(void) {
	NSArray<NSScreen *> *screens = [NSScreen screens];
	if ([screens count] > 0) {
		return [screens objectAtIndex:0].frame.size.height;
	}
	return 900.0;
}

static void vega_panel_emit_state(BOOL visible) {
	if (!gPanelWebView || !gPanelWindow || !gPanelGrokMode) {
		return;
	}
	BOOL zoomed = [gPanelWindow isZoomed];
	NSString *js = [NSString stringWithFormat:
		@"window.vegaPanelDpiScale=window.devicePixelRatio||1;"
		 "window.dispatchEvent(new CustomEvent('vega-window-state',{detail:{isMaximized:%s,visible:%s}}));",
		zoomed ? "true" : "false", visible ? "true" : "false"];
	[gPanelWebView evaluateJavaScript:js completionHandler:nil];
}

static void vega_panel_apply_chrome_locked(BOOL grokMode) {
	gPanelGrokMode = grokMode;
	if (!gPanelWindow) {
		return;
	}
	NSWindowStyleMask mask = [gPanelWindow styleMask];
	if (grokMode) {
		mask |= NSWindowStyleMaskFullSizeContentView;
		[gPanelWindow setStyleMask:mask];
		[gPanelWindow setTitlebarAppearsTransparent:YES];
		[gPanelWindow setTitleVisibility:NSWindowTitleHidden];
	} else {
		mask &= ~NSWindowStyleMaskFullSizeContentView;
		[gPanelWindow setStyleMask:mask];
		[gPanelWindow setTitlebarAppearsTransparent:NO];
		[gPanelWindow setTitleVisibility:NSWindowTitleVisible];
		[gPanelWindow setAppearance:nil];
		[gPanelWindow setBackgroundColor:[NSColor windowBackgroundColor]];
	}
	NSButton *closeBtn = [gPanelWindow standardWindowButton:NSWindowCloseButton];
	NSButton *minBtn = [gPanelWindow standardWindowButton:NSWindowMiniaturizeButton];
	NSButton *zoomBtn = [gPanelWindow standardWindowButton:NSWindowZoomButton];
	if (closeBtn) [closeBtn setHidden:grokMode];
	if (minBtn) [minBtn setHidden:grokMode];
	if (zoomBtn) [zoomBtn setHidden:grokMode];
}

static void vega_panel_save_geometry(void) {
	if (!gPanelWindow || [gPanelWindow isZoomed] || [gPanelWindow isMiniaturized]) {
		return;
	}
	NSRect frame = [gPanelWindow frame];
	double primaryH = vega_primary_screen_height();
	int topY = (int)llround(primaryH - (frame.origin.y + frame.size.height));
	goVegaPanelGeometryChanged((int)llround(frame.origin.x), topY, (int)llround(frame.size.width), (int)llround(frame.size.height));
}

@interface VegaPanelDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@end

@implementation VegaPanelDelegate

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
	if (![message.name isEqualToString:@"vega"]) {
		return;
	}
	NSString *body = nil;
	if ([message.body isKindOfClass:[NSString class]]) {
		body = (NSString *)message.body;
	} else if (message.body != nil) {
		body = [NSString stringWithFormat:@"%@", message.body];
	}
	if (body) {
		goVegaPanelMessage((char *)[body UTF8String]);
	}
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
	[sender orderOut:nil];
	vega_panel_emit_state(NO);
	return NO;
}

- (void)windowDidResize:(NSNotification *)notification {
	vega_panel_emit_state([gPanelWindow isVisible]);
}

- (void)windowDidMiniaturize:(NSNotification *)notification {
	vega_panel_emit_state(NO);
}

- (void)windowDidDeminiaturize:(NSNotification *)notification {
	vega_panel_emit_state(YES);
}

- (void)windowDidMove:(NSNotification *)notification {
	vega_panel_save_geometry();
}

- (void)windowDidEndLiveResize:(NSNotification *)notification {
	vega_panel_save_geometry();
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
	goVegaPanelNavigationFinished();
	vega_panel_emit_state([gPanelWindow isVisible] && ![gPanelWindow isMiniaturized]);
}

static BOOL vega_is_local_url(NSURL *url) {
	if (!url) return NO;
	NSString *abs = [url absoluteString];
	if ([abs isEqualToString:@"about:blank"]) return YES;
	return [url.scheme isEqualToString:@"http"] && [url.host isEqualToString:@"127.0.0.1"];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
	NSURL *url = navigationAction.request.URL;
	if (vega_is_local_url(url)) {
		decisionHandler(WKNavigationActionPolicyAllow);
		return;
	}
	if ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) {
		[[NSWorkspace sharedWorkspace] openURL:url];
	}
	decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
	NSURL *url = navigationAction.request.URL;
	if (vega_is_local_url(url)) {
		[webView loadRequest:navigationAction.request];
	} else if ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) {
		[[NSWorkspace sharedWorkspace] openURL:url];
	}
	return nil;
}

@end

static VegaPanelDelegate *gPanelDelegate = nil;

static void vega_panel_install_menu(void) {
	NSMenu *menubar = [[NSMenu alloc] init];
	NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
	[menubar addItem:appMenuItem];
	NSMenu *appMenu = [[NSMenu alloc] init];
	[appMenu addItemWithTitle:@"隐藏" action:@selector(hide:) keyEquivalent:@"h"];
	[appMenu addItemWithTitle:@"关闭窗口" action:@selector(performClose:) keyEquivalent:@"w"];
	[appMenuItem setSubmenu:appMenu];

	NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
	[menubar addItem:editMenuItem];
	NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
	[editMenu addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
	[editMenu addItemWithTitle:@"重做" action:@selector(redo:) keyEquivalent:@"Z"];
	[editMenu addItem:[NSMenuItem separatorItem]];
	[editMenu addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
	[editMenu addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
	[editMenu addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
	[editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
	[editMenuItem setSubmenu:editMenu];

	[NSApp setMainMenu:menubar];
}

static void vega_panel_start(const char *urlStr, int x, int y, int w, int h, int minW, int minH, int grokMode) {
	[NSApplication sharedApplication];
	[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
	vega_panel_install_menu();

	gPanelDelegate = [[VegaPanelDelegate alloc] init];
	[NSApp setDelegate:gPanelDelegate];

	double primaryH = vega_primary_screen_height();
	NSRect frame = NSMakeRect((CGFloat)x, (CGFloat)(primaryH - (double)y - (double)h), (CGFloat)w, (CGFloat)h);

	NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
		NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
	if (grokMode) {
		style |= NSWindowStyleMaskFullSizeContentView;
	}
	gPanelWindow = [[NSWindow alloc] initWithContentRect:frame
		styleMask:style
		backing:NSBackingStoreBuffered
		defer:NO];
	[gPanelWindow setTitle:@"牵牛星"];
	[gPanelWindow setMinSize:NSMakeSize((CGFloat)minW, (CGFloat)minH)];
	[gPanelWindow setReleasedWhenClosed:NO];
	[gPanelWindow setDelegate:gPanelDelegate];

	WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
	[config setWebsiteDataStore:[WKWebsiteDataStore defaultDataStore]];
	WKUserContentController *ucc = [[WKUserContentController alloc] init];
	[ucc addScriptMessageHandler:gPanelDelegate name:@"vega"];

	NSString *shim =
		@"window.vegaPanelDpiScale = window.devicePixelRatio || 1;"
		 "window.chrome = window.chrome || {};"
		 "window.chrome.webview = {"
		 "  postMessage: function(msg) {"
		 "    try { window.webkit.messageHandlers.vega.postMessage(String(msg)); } catch (e) {}"
		 "  }"
		 "};";
	WKUserScript *script = [[WKUserScript alloc] initWithSource:shim
		injectionTime:WKUserScriptInjectionTimeAtDocumentStart
		forMainFrameOnly:YES];
	[ucc addUserScript:script];
	[config setUserContentController:ucc];

	gPanelWebView = [[WKWebView alloc] initWithFrame:[[gPanelWindow contentView] bounds] configuration:config];
	[gPanelWebView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
	[gPanelWebView setValue:@(NO) forKey:@"drawsBackground"];
	[gPanelWebView setNavigationDelegate:gPanelDelegate];
	[gPanelWebView setUIDelegate:gPanelDelegate];
	[gPanelWindow setContentView:gPanelWebView];

	vega_panel_apply_chrome_locked(grokMode ? YES : NO);

	gMouseMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
		handler:^NSEvent *(NSEvent *event) {
			if ([event window] == gPanelWindow) {
				gLastMouseDownEvent = event;
			}
			return event;
		}];

	NSURL *nsURL = [NSURL URLWithString:[NSString stringWithUTF8String:urlStr]];
	if (nsURL) {
		[gPanelWebView loadRequest:[NSURLRequest requestWithURL:nsURL]];
	}
	[gPanelWindow makeKeyAndOrderFront:nil];
	[NSApp activateIgnoringOtherApps:YES];
	[NSApp run];
}

static void vega_panel_navigate(const char *urlStr, int grokMode) {
	NSString *target = urlStr ? [NSString stringWithUTF8String:urlStr] : nil;
	dispatch_async(dispatch_get_main_queue(), ^{
		vega_panel_apply_chrome_locked(grokMode ? YES : NO);
		if (target && gPanelWebView) {
			NSURL *nsURL = [NSURL URLWithString:target];
			if (nsURL) {
				[gPanelWebView loadRequest:[NSURLRequest requestWithURL:nsURL]];
			}
		}
	});
}

static void vega_panel_set_chrome(int grokMode) {
	dispatch_async(dispatch_get_main_queue(), ^{
		vega_panel_apply_chrome_locked(grokMode ? YES : NO);
		if (grokMode && gPanelWindow) {
			vega_panel_emit_state([gPanelWindow isVisible] && ![gPanelWindow isMiniaturized]);
		}
	});
}

static void vega_panel_show(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (!gPanelWindow) return;
		if ([gPanelWindow isMiniaturized]) {
			[gPanelWindow deminiaturize:nil];
		}
		[gPanelWindow makeKeyAndOrderFront:nil];
		[NSApp activateIgnoringOtherApps:YES];
		vega_panel_emit_state(YES);
	});
}

static void vega_panel_park(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (!gPanelWindow) return;
		[gPanelWindow orderOut:nil];
		vega_panel_emit_state(NO);
	});
}

static void vega_panel_shutdown(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		[NSApp stop:nil];
		NSEvent *ev = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
			location:NSMakePoint(0, 0)
			modifierFlags:0
			timestamp:0
			windowNumber:0
			context:nil
			subtype:0
			data1:0
			data2:0];
		[NSApp postEvent:ev atStart:YES];
	});
}

static void vega_panel_cmd(const char *cmd) {
	NSString *action = cmd ? [NSString stringWithUTF8String:cmd] : @"";
	dispatch_async(dispatch_get_main_queue(), ^{
		if (!gPanelWindow) return;
		if ([action isEqualToString:@"vega-window:minimize"]) {
			[gPanelWindow miniaturize:nil];
		} else if ([action isEqualToString:@"vega-window:toggle-maximize"]) {
			[gPanelWindow zoom:nil];
		} else if ([action isEqualToString:@"vega-window:close"]) {
			[gPanelWindow orderOut:nil];
			vega_panel_emit_state(NO);
		} else if ([action isEqualToString:@"vega-window:drag"]) {
			NSEvent *ev = gLastMouseDownEvent;
			if (!ev || [ev window] != gPanelWindow || [ev type] != NSEventTypeLeftMouseDown) {
				NSPoint screenPt = [NSEvent mouseLocation];
				NSRect winRect = [gPanelWindow convertRectFromScreen:NSMakeRect(screenPt.x, screenPt.y, 0, 0)];
				ev = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
					location:winRect.origin
					modifierFlags:0
					timestamp:[[NSProcessInfo processInfo] systemUptime]
					windowNumber:[gPanelWindow windowNumber]
					context:nil
					eventNumber:0
					clickCount:1
					pressure:1.0];
			}
			if (ev) {
				gLastMouseDownEvent = nil;
				[gPanelWindow performWindowDragWithEvent:ev];
			}
		} else if ([action isEqualToString:@"vega-window:theme-dark"]) {
			[gPanelWindow setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
			[gPanelWindow setBackgroundColor:[NSColor colorWithRed:24.0/255.0 green:24.0/255.0 blue:24.0/255.0 alpha:1.0]];
		} else if ([action isEqualToString:@"vega-window:theme-light"]) {
			[gPanelWindow setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameAqua]];
			[gPanelWindow setBackgroundColor:[NSColor whiteColor]];
		}
	});
}
*/
import "C"

import (
	"os"
	"strings"
	"sync"
	"unsafe"
)

var (
	panelURLMu      sync.Mutex
	panelCurrentURL string
)

func panelUsesGrok(url string) bool {
	return strings.HasPrefix(url, "http://"+localAddress+"/assistant/") && strings.HasSuffix(url, "/"+assistantGrokPath)
}

func handleDarwinPanelNavigationFinished() {
	panelURLMu.Lock()
	url := panelCurrentURL
	panelURLMu.Unlock()
	if panelUsesGrok(url) {
		C.vega_panel_set_chrome(1)
	} else {
		C.vega_panel_set_chrome(0)
	}
}

func panelWindowMessage(text string) {
	if text == "vega-window:chat-ready" {
		panelURLMu.Lock()
		if token, ok := strings.CutPrefix(panelCurrentURL, "http://"+localAddress+"/config/"); ok {
			token, _, _ = strings.Cut(token, "?")
			panelCurrentURL = "http://" + localAddress + "/assistant/" + token + "/" + assistantGrokPath
		}
		grok := panelUsesGrok(panelCurrentURL)
		panelURLMu.Unlock()
		if grok {
			C.vega_panel_set_chrome(1)
		}
		return
	}
	panelURLMu.Lock()
	grok := panelUsesGrok(panelCurrentURL)
	panelURLMu.Unlock()
	if !grok {
		return
	}
	switch text {
	case "vega-window:minimize", "vega-window:toggle-maximize", "vega-window:close",
		"vega-window:drag", "vega-window:theme-dark", "vega-window:theme-light":
		cCmd := C.CString(text)
		C.vega_panel_cmd(cCmd)
		C.free(unsafe.Pointer(cCmd))
	}
}

func panelNavigateIfNeeded() {
	target := panelTarget()
	if target == "" {
		return
	}
	panelURLMu.Lock()
	changed := target != panelCurrentURL
	if changed {
		panelCurrentURL = target
	}
	panelURLMu.Unlock()
	if changed {
		cURL := C.CString(target)
		defer C.free(unsafe.Pointer(cURL))
		grok := C.int(0)
		if panelUsesGrok(target) {
			grok = 1
		}
		C.vega_panel_navigate(cURL, grok)
	}
}

func panelHostStart(url string) bool {
	if target := panelTarget(); target != "" {
		url = target
	}
	panelURLMu.Lock()
	panelCurrentURL = url
	panelURLMu.Unlock()

	x, y, width, height := panelInitialFrame()
	lis := panelStartIPC(
		func() {
			panelNavigateIfNeeded()
			C.vega_panel_show()
		},
		func() {
			C.vega_panel_park()
		},
		func() {
			C.vega_panel_shutdown()
		},
	)
	if lis != nil {
		defer func() {
			_ = lis.Close()
			_ = os.Remove(butterflyPanelSocketPath())
		}()
	}

	cURL := C.CString(url)
	defer C.free(unsafe.Pointer(cURL))
	grok := C.int(0)
	if panelUsesGrok(url) {
		grok = 1
	}
	C.vega_panel_start(cURL, C.int(x), C.int(y), C.int(width), C.int(height),
		C.int(butterflyPanelMinWidth), C.int(butterflyPanelMinHeight), grok)
	return true
}
