//go:build darwin && cgo

package main

// macOS 呼吸光效与物理 Esc 叫停：
//   - 为每块 NSScreen 创建透明、鼠标穿透、不入 Dock/Switcher 的置顶 NSWindow；
//   - 强制设置 NSWindowSharingNone + ScreenCaptureKit 排除，确保 AI 截图绝不拍到光效；
//   - 常驻 CGEventTap 监听 kCGEventKeyDown，严格过滤掉带 VEGA_INJECTED_EVENT_TAG 标记的注入 Esc。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework CoreGraphics -framework CoreFoundation
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdlib.h>

#define VEGA_INJECTED_EVENT_TAG ((int64_t)0x56454741)
#define VEGA_VK_ESCAPE ((int64_t)53)

extern void goVegaGlowRegisterWindow(uint32_t winID, int add);
extern int goVegaGlowShouldContinue(double *outIntensity);
extern void goVegaEscPressed(void);

@interface VegaGlowView : NSView
@property (nonatomic, assign) double intensity;
@end

@implementation VegaGlowView

- (BOOL)isOpaque {
	return NO;
}

- (void)drawRect:(NSRect)dirtyRect {
	[[NSColor clearColor] set];
	NSRectFill(self.bounds);

	NSRect b = self.bounds;
	CGFloat w = b.size.width;
	CGFloat h = b.size.height;
	if (w <= 0 || h <= 0) return;

	const int layers = 6;
	for (int layer = 0; layer < layers; layer++) {
		CGFloat inset = (CGFloat)(layer * 2 + 1);
		if (w - inset * 2 <= 0 || h - inset * 2 <= 0) break;
		double alpha = self.intensity * (1.0 - (double)layer / (double)layers);
		if (alpha < 0.0) alpha = 0.0;
		if (alpha > 1.0) alpha = 1.0;
		NSColor *stroke = [NSColor colorWithRed:56.0/255.0 green:189.0/255.0 blue:248.0/255.0 alpha:(CGFloat)alpha];
		[stroke setStroke];
		NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(inset, inset, w - inset * 2, h - inset * 2)
			xRadius:14.0 yRadius:14.0];
		[path setLineWidth:2.0];
		[path stroke];
	}
}

@end

@interface VegaGlowCoordinator : NSObject
@end

static NSMutableArray<NSWindow *> *gGlowWindows = nil;
static NSTimer *gGlowTimer = nil;
static VegaGlowCoordinator *gGlowCoordinator = nil;
static CFMachPortRef gEscTapPort = NULL;

static void vega_glow_teardown_windows(void) {
	if (gGlowTimer) {
		[gGlowTimer invalidate];
		gGlowTimer = nil;
	}
	if (gGlowWindows) {
		for (NSWindow *win in gGlowWindows) {
			goVegaGlowRegisterWindow((uint32_t)[win windowNumber], 0);
			[win orderOut:nil];
			[win close];
		}
		[gGlowWindows removeAllObjects];
	}
}

@implementation VegaGlowCoordinator

- (void)onTick:(NSTimer *)timer {
	double intensity = 0.0;
	if (!goVegaGlowShouldContinue(&intensity)) {
		vega_glow_teardown_windows();
		return;
	}
	for (NSWindow *win in gGlowWindows) {
		VegaGlowView *view = (VegaGlowView *)[win contentView];
		if ([view isKindOfClass:[VegaGlowView class]]) {
			view.intensity = intensity;
			[view setNeedsDisplay:YES];
		}
	}
}

@end

static void vega_glow_show(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			[NSApplication sharedApplication];
			if (!gGlowWindows) gGlowWindows = [NSMutableArray array];
			if (!gGlowCoordinator) gGlowCoordinator = [[VegaGlowCoordinator alloc] init];

			vega_glow_teardown_windows();

			double intensity = 0.5;
			if (!goVegaGlowShouldContinue(&intensity)) {
				return;
			}
			for (NSScreen *screen in [NSScreen screens]) {
				NSRect frame = [screen frame];
				NSWindow *win = [[NSWindow alloc] initWithContentRect:frame
					styleMask:NSWindowStyleMaskBorderless
					backing:NSBackingStoreBuffered
					defer:NO];
				[win setReleasedWhenClosed:NO];
				[win setOpaque:NO];
				[win setBackgroundColor:[NSColor clearColor]];
				[win setHasShadow:NO];
				[win setIgnoresMouseEvents:YES];
				[win setLevel:NSScreenSaverWindowLevel];
				[win setSharingType:NSWindowSharingNone];
				[win setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces |
					NSWindowCollectionBehaviorStationary |
					NSWindowCollectionBehaviorIgnoresCycle |
					NSWindowCollectionBehaviorFullScreenAuxiliary];

				VegaGlowView *view = [[VegaGlowView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
				view.intensity = intensity;
				[win setContentView:view];
				[win orderFrontRegardless];
				goVegaGlowRegisterWindow((uint32_t)[win windowNumber], 1);
				[gGlowWindows addObject:win];
			}
			gGlowTimer = [NSTimer scheduledTimerWithTimeInterval:(1.0 / 60.0)
				target:gGlowCoordinator
				selector:@selector(onTick:)
				userInfo:nil
				repeats:YES];
		}
	});
}

static void vega_glow_hide(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			vega_glow_teardown_windows();
		}
	});
}

static CGEventRef vega_esc_tap_callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
	if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
		if (gEscTapPort) {
			CGEventTapEnable(gEscTapPort, true);
		}
		return event;
	}
	if (type == kCGEventKeyDown && event != NULL) {
		int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
		int64_t userData = CGEventGetIntegerValueField(event, kCGEventSourceUserData);
		if (keycode == VEGA_VK_ESCAPE && userData != VEGA_INJECTED_EVENT_TAG) {
			goVegaEscPressed();
		}
	}
	return event;
}

static void vega_run_esc_tap(void) {
	@autoreleasepool {
		CGEventMask mask = CGEventMaskBit(kCGEventKeyDown);
		CFMachPortRef tap = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, vega_esc_tap_callback, NULL);
		if (!tap) {
			tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, vega_esc_tap_callback, NULL);
		}
		if (!tap) {
			return;
		}
		gEscTapPort = tap;
		CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
		if (source) {
			CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
			CGEventTapEnable(tap, true);
			CFRunLoopRun();
			CFRelease(source);
		}
		CFRelease(tap);
		gEscTapPort = NULL;
	}
}
*/
import "C"

import (
	"math"
	"sync"
	"time"
)

const (
	glowIdleCap           = 60 * time.Second
	vegaInjectedEventTagC = int64(0x56454741)
)

var glowState struct {
	sync.Mutex
	tapRunning bool
	visible    bool
	startedAt  time.Time
}

var glowEpoch = time.Now()

func isPhysicalEscEvent(keyCode int64, userData int64) bool {
	return keyCode == 53 && userData != vegaInjectedEventTagC
}

func handleDarwinGlowShouldContinue() (float64, bool) {
	if !glowWanted() {
		glowState.Lock()
		glowState.visible = false
		glowState.Unlock()
		return 0, false
	}
	t := time.Since(glowEpoch).Seconds()
	intensity := 0.35 + 0.65*(0.5+0.5*math.Sin(t*math.Pi*2/2.6))
	return intensity, true
}

func handleDarwinEscPressed() {
	if glowLit() {
		appuseMarkEscaped()
		go appuseUserEscaped()
	}
}

func glowEnsureEscTap() {
	glowState.Lock()
	if glowState.tapRunning {
		glowState.Unlock()
		return
	}
	glowState.tapRunning = true
	glowState.Unlock()
	go func() {
		C.vega_run_esc_tap()
		glowState.Lock()
		glowState.tapRunning = false
		glowState.Unlock()
	}()
}

func glowStart() {
	glowEnsureEscTap()
}

func glowHold() {
	glowEnsureEscTap()
	glowState.Lock()
	wasVisible := glowState.visible
	glowState.visible = true
	glowState.startedAt = time.Now()
	if !wasVisible {
		glowEpoch = time.Now()
	}
	glowState.Unlock()
	C.vega_glow_show()
}

func glowRelease() {
	appuseInput.Lock()
	busy := appuseInput.holder != ""
	last := appuseInput.last
	appuseInput.Unlock()
	if busy || time.Since(last) < glowIdleCap {
		return
	}
	glowHide()
}

func glowHide() {
	glowState.Lock()
	visible := glowState.visible
	glowState.visible = false
	glowState.Unlock()
	if !visible {
		return
	}
	C.vega_glow_hide()
}

func glowWanted() bool {
	glowState.Lock()
	if !glowState.visible {
		glowState.Unlock()
		return false
	}
	started := glowState.startedAt
	glowState.Unlock()
	busy, last := appuseInputActive()
	if busy {
		return true
	}
	if last.After(started) {
		return time.Since(last) < glowIdleCap
	}
	return time.Since(started) < glowIdleCap/4
}

func glowLit() bool {
	glowState.Lock()
	defer glowState.Unlock()
	return glowState.visible
}

func appuseUserEscaped() {
	owner := appuseDesktopOwner()
	butterflyNotify("needs_review", "你按了 Esc 叫停操作电脑：本批剩余动作未执行，请核对屏幕上的实际结果")
	butterflyClearIfKind("running")
	if owner == "" {
		return
	}
	stopSessionFromClient(owner, "用户按 Esc 叫停了操作电脑")
}
