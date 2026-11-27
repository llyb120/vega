//go:build darwin && cgo

// macOS menu bar tray: connection status, five-tier task status, settings and Quit.
package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

extern void goVegaTrayAction(int action);
extern void goVegaTrayDidFinishLaunching(void);

static NSStatusItem *gStatusItem = nil;
static NSMenuItem *gStatusTextItem = nil;
static NSMenuItem *gChipTextItem = nil;
static NSImage *gTrayIconDefault = nil;
static NSImage *gTrayIconConnected = nil;

@interface VegaTrayDelegate : NSObject <NSApplicationDelegate>
@end

@implementation VegaTrayDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
	goVegaTrayDidFinishLaunching();
}

- (void)onOpen:(id)sender {
	goVegaTrayAction(1);
}

- (void)onConfigure:(id)sender {
	goVegaTrayAction(2);
}

- (void)onQuit:(id)sender {
	goVegaTrayAction(3);
}

@end

static VegaTrayDelegate *gTrayDelegate = nil;

static NSImage *vega_make_fallback_icon(BOOL connected) {
	NSSize sz = NSMakeSize(18, 18);
	NSImage *img = [[NSImage alloc] initWithSize:sz];
	[img lockFocus];
	NSColor *color = connected ? [NSColor systemBlueColor] : [NSColor labelColor];
	[color setFill];
	NSBezierPath *wingL = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(2, 5, 6.5, 9)];
	NSBezierPath *wingR = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(9.5, 5, 6.5, 9)];
	NSBezierPath *body = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(8.1, 3.5, 1.8, 11) xRadius:0.9 yRadius:0.9];
	[wingL fill];
	[wingR fill];
	[body fill];
	[img unlockFocus];
	[img setTemplate:!connected];
	return img;
}

static NSImage *vega_load_icon_data(const void *bytes, int length, BOOL connected) {
	if (bytes && length > 0) {
		NSData *data = [NSData dataWithBytes:bytes length:(NSUInteger)length];
		NSImage *img = [[NSImage alloc] initWithData:data];
		if (img && [img isValid]) {
			[img setSize:NSMakeSize(18, 18)];
			[img setTemplate:!connected];
			return img;
		}
	}
	return vega_make_fallback_icon(connected);
}

static void vega_tray_init(const void *iconBytes, int iconLen, const void *connBytes, int connLen) {
	@autoreleasepool {
		[NSApplication sharedApplication];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
		gTrayDelegate = [[VegaTrayDelegate alloc] init];
		[NSApp setDelegate:gTrayDelegate];

		gTrayIconDefault = vega_load_icon_data(iconBytes, iconLen, NO);
		gTrayIconConnected = vega_load_icon_data(connBytes, connLen, YES);

		gStatusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
		if (gStatusItem.button) {
			[gStatusItem.button setImage:gTrayIconDefault];
			[gStatusItem.button setImagePosition:NSImageLeft];
			[gStatusItem.button setToolTip:@"牵牛星 · 未连接"];
		}

		NSMenu *menu = [[NSMenu alloc] init];
		[menu setAutoenablesItems:NO];

		gStatusTextItem = [[NSMenuItem alloc] initWithTitle:@"牵牛星 · 未连接" action:nil keyEquivalent:@""];
		[gStatusTextItem setEnabled:NO];
		[menu addItem:gStatusTextItem];

		gChipTextItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
		[gChipTextItem setEnabled:NO];
		[gChipTextItem setHidden:YES];
		[menu addItem:gChipTextItem];

		[menu addItem:[NSMenuItem separatorItem]];

		NSMenuItem *openItem = [[NSMenuItem alloc] initWithTitle:@"打开牵牛星" action:@selector(onOpen:) keyEquivalent:@""];
		[openItem setTarget:gTrayDelegate];
		[menu addItem:openItem];

		NSMenuItem *cfgItem = [[NSMenuItem alloc] initWithTitle:@"设置" action:@selector(onConfigure:) keyEquivalent:@""];
		[cfgItem setTarget:gTrayDelegate];
		[menu addItem:cfgItem];

		[menu addItem:[NSMenuItem separatorItem]];

		NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"退出" action:@selector(onQuit:) keyEquivalent:@""];
		[quitItem setTarget:gTrayDelegate];
		[menu addItem:quitItem];

		[gStatusItem setMenu:menu];
	}
}

static void vega_tray_run_loop(void) {
	@autoreleasepool {
		[NSApp run];
	}
}

static void vega_tray_stop_loop(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
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
		}
	});
}

static void vega_tray_update(int connected, const char *tooltip, const char *chipLabel) {
	NSString *tip = tooltip ? [NSString stringWithUTF8String:tooltip] : @"牵牛星";
	NSString *chip = chipLabel ? [NSString stringWithUTF8String:chipLabel] : @"";
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			if (!gStatusItem) return;
			if (gStatusItem.button) {
				[gStatusItem.button setImage:(connected ? gTrayIconConnected : gTrayIconDefault)];
				[gStatusItem.button setToolTip:tip];
				if ([chip length] > 0) {
					[gStatusItem.button setTitle:[@" " stringByAppendingString:chip]];
				} else {
					[gStatusItem.button setTitle:@""];
				}
			}
			if (gStatusTextItem) {
				[gStatusTextItem setTitle:tip];
			}
			if (gChipTextItem) {
				if ([chip length] > 0) {
					[gChipTextItem setTitle:chip];
					[gChipTextItem setHidden:NO];
				} else {
					[gChipTextItem setHidden:YES];
				}
			}
		}
	});
}

static void vega_preview_app_init(void) {
	@autoreleasepool {
		[NSApplication sharedApplication];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
	}
}
*/
import "C"

import (
	_ "embed"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

//go:embed icon.ico
var iconData []byte

//go:embed icon-connected.ico
var iconConnectedData []byte

func init() {
	// Keep main() locked to macOS OS Thread 0 so NSApplication/NSWindow/NSPanel always run safely.
	runtime.LockOSThread()
}

var (
	trayConfigureFn func()
	trayLaunchOnce  sync.Once
)

func handleDarwinTrayDidFinishLaunching() {
	trayLaunchOnce.Do(func() {
		go butterflyOpen()
	})
}

func handleDarwinTrayAction(action int) {
	switch action {
	case 1:
		go butterflyOpen()
	case 2:
		if trayConfigureFn != nil {
			go trayConfigureFn()
		}
	case 3:
		C.vega_tray_stop_loop()
	}
}

func previewMain(fn func()) {
	runtime.LockOSThread()
	C.vega_preview_app_init()
	go func() {
		defer C.vega_tray_stop_loop()
		fn()
	}()
	C.vega_tray_run_loop()
}

func systrayRun(configure, onQuit func()) {
	runtime.LockOSThread()
	trayConfigureFn = configure

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	stopCh := make(chan struct{})
	defer close(stopCh)
	go func() {
		select {
		case <-sig:
			C.vega_tray_stop_loop()
		case <-stopCh:
		}
	}()

	var pIcon, pConn unsafe.Pointer
	if len(iconData) > 0 {
		pIcon = unsafe.Pointer(&iconData[0])
	}
	if len(iconConnectedData) > 0 {
		pConn = unsafe.Pointer(&iconConnectedData[0])
	}
	C.vega_tray_init(pIcon, C.int(len(iconData)), pConn, C.int(len(iconConnectedData)))

	trayState.Lock()
	trayState.ready = true
	applyTrayAppearance(trayState.connected)
	trayState.Unlock()

	C.vega_tray_run_loop()
	if onQuit != nil {
		onQuit()
	}
}

var trayState struct {
	sync.Mutex
	ready     bool
	connected bool
	site      string
	// 蝴蝶提示："" 无、running 正在操作电脑、needs_review 待用户核对。
	notice     string
	noticeText string
	chipLabel  string
}

// setSiteLabel 让托盘标题带上站点，多个站点的客户端一眼能分。
func setSiteLabel(site string) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.site = site
	if trayState.ready {
		applyTrayAppearance(trayState.connected)
	}
}

func connectionTooltip(connected bool) string {
	base := "牵牛星"
	if trayState.site != "" {
		base += " · " + trayState.site
	}
	if connected {
		return base + " · 已连接"
	}
	return base + " · 未连接"
}

// trayTooltip 把蝴蝶提示叠在连接状态上，鼠标停在托盘图标上就能看到。
func trayTooltip(connected bool, notice, text string) string {
	switch notice {
	case "needs_review":
		return "牵牛星 · 需要你核对：" + truncateRunes(text, 80)
	case "running":
		return "牵牛星 · 正在操作这台电脑"
	}
	return connectionTooltip(connected)
}

func applyTrayAppearance(connected bool) {
	tip := trayTooltip(connected, trayState.notice, trayState.noticeText)
	chip := trayState.chipLabel
	cTip := C.CString(tip)
	cChip := C.CString(chip)
	defer C.free(unsafe.Pointer(cTip))
	defer C.free(unsafe.Pointer(cChip))
	connFlag := C.int(0)
	if connected {
		connFlag = 1
	}
	C.vega_tray_update(connFlag, cTip, cChip)
}

func traySetChipLabel(label string) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.chipLabel = label
	if trayState.ready {
		applyTrayAppearance(trayState.connected)
	}
}

func butterflyTrayNotice(notice *butterflyNotice) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.notice, trayState.noticeText = "", ""
	if notice != nil {
		trayState.notice, trayState.noticeText = notice.Kind, notice.Text
	}
	if trayState.ready {
		applyTrayAppearance(trayState.connected)
	}
}

func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

func setState(connected bool) {
	trayState.Lock()
	defer trayState.Unlock()
	trayState.connected = connected
	if trayState.ready {
		applyTrayAppearance(connected)
	}
}
