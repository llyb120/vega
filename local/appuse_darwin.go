//go:build darwin && cgo

package main

// appuse 的 macOS 原生实现：ScreenCaptureKit 截图 + CoreGraphics 多屏物理像素换算 + CGEvent 键鼠注入。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework ApplicationServices -framework AppKit -framework ScreenCaptureKit
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

typedef CGImageRef (*vega_cg_display_create_image_fn)(CGDirectDisplayID);
typedef CGImageRef (*vega_cg_window_list_create_image_fn)(CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption);

static void *vega_cg_framework_handle(void) {
	static void *handle = NULL;
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY);
	});
	return handle;
}

#define VEGA_INJECTED_EVENT_TAG ((int64_t)0x56454741)

typedef struct {
	uint32_t displayID;
	double cgX;
	double cgY;
	double cgW;
	double cgH;
	uint32_t pixelsW;
	uint32_t pixelsH;
	double scale;
} VegaDisplayInfo;

typedef struct {
	uint32_t id;
	uint32_t pid;
	double cgX;
	double cgY;
	double cgW;
	double cgH;
	char *app;
	char *title;
	int focused;
} VegaWindowInfo;

static int vega_list_displays(VegaDisplayInfo **outDisplays, int *outCount) {
	*outDisplays = NULL;
	*outCount = 0;
	uint32_t count = 0;
	if (CGGetActiveDisplayList(0, NULL, &count) != kCGErrorSuccess || count == 0) {
		return -1;
	}
	if (count > 16) count = 16;
	CGDirectDisplayID *ids = (CGDirectDisplayID *)calloc(count, sizeof(CGDirectDisplayID));
	if (!ids) return -1;
	if (CGGetActiveDisplayList(count, ids, &count) != kCGErrorSuccess || count == 0) {
		free(ids);
		return -1;
	}
	VegaDisplayInfo *list = (VegaDisplayInfo *)calloc(count, sizeof(VegaDisplayInfo));
	if (!list) {
		free(ids);
		return -1;
	}
	for (uint32_t i = 0; i < count; i++) {
		CGDirectDisplayID did = ids[i];
		CGRect bounds = CGDisplayBounds(did);
		size_t pw = CGDisplayPixelsWide(did);
		size_t ph = CGDisplayPixelsHigh(did);
		CGDisplayModeRef mode = CGDisplayCopyDisplayMode(did);
		if (mode) {
			size_t mw = CGDisplayModeGetPixelWidth(mode);
			size_t mh = CGDisplayModeGetPixelHeight(mode);
			if (mw > 0 && mh > 0) {
				pw = mw;
				ph = mh;
			}
			CGDisplayModeRelease(mode);
		}
		double scale = (bounds.size.width > 0 && pw > 0) ? ((double)pw / bounds.size.width) : 1.0;
		if (scale < 0.5) scale = 1.0;
		list[i].displayID = (uint32_t)did;
		list[i].cgX = bounds.origin.x;
		list[i].cgY = bounds.origin.y;
		list[i].cgW = bounds.size.width;
		list[i].cgH = bounds.size.height;
		list[i].pixelsW = (uint32_t)(pw > 0 ? pw : (size_t)bounds.size.width);
		list[i].pixelsH = (uint32_t)(ph > 0 ? ph : (size_t)bounds.size.height);
		list[i].scale = scale;
	}
	free(ids);
	*outDisplays = list;
	*outCount = (int)count;
	return 0;
}

static uint8_t *vega_cgimage_to_rgba(CGImageRef img, int *outW, int *outH) {
	if (!img) return NULL;
	size_t w = CGImageGetWidth(img);
	size_t h = CGImageGetHeight(img);
	if (w == 0 || h == 0) return NULL;
	size_t byteCount = w * h * 4;
	uint8_t *buf = (uint8_t *)malloc(byteCount);
	if (!buf) return NULL;
	CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
	if (!cs) cs = CGColorSpaceCreateDeviceRGB();
	CGContextRef ctx = CGBitmapContextCreate(buf, w, h, 8, w * 4, cs, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
	if (cs) CGColorSpaceRelease(cs);
	if (!ctx) {
		free(buf);
		return NULL;
	}
	CGContextDrawImage(ctx, CGRectMake(0, 0, (CGFloat)w, (CGFloat)h), img);
	CGContextRelease(ctx);
	for (size_t i = 3; i < byteCount; i += 4) {
		buf[i] = 255;
	}
	*outW = (int)w;
	*outH = (int)h;
	return buf;
}

static uint8_t *vega_capture_display_rgba(uint32_t displayID, uint32_t reqW, uint32_t reqH, const uint32_t *excludeWinIDs, int excludeCount, int *outW, int *outH, char **outErr) {
	*outW = 0;
	*outH = 0;
	*outErr = NULL;
	@autoreleasepool {
		if (@available(macOS 14.0, *)) {
			__block SCShareableContent *content = nil;
			__block NSError *contentErr = nil;
			dispatch_semaphore_t sem1 = dispatch_semaphore_create(0);
			[SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *sc, NSError *err) {
				content = sc;
				contentErr = err;
				dispatch_semaphore_signal(sem1);
			}];
			if (dispatch_semaphore_wait(sem1, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0) {
				*outErr = strdup("获取屏幕内容超时，请检查屏幕录制权限");
				return NULL;
			}
			if (contentErr || !content) {
				NSString *msg = contentErr ? [contentErr localizedDescription] : @"无法访问屏幕录制接口";
				*outErr = strdup([msg UTF8String]);
				return NULL;
			}
			SCDisplay *target = nil;
			for (SCDisplay *d in content.displays) {
				if (d.displayID == (CGDirectDisplayID)displayID) {
					target = d;
					break;
				}
			}
			if (!target) {
				*outErr = strdup("找不到指定显示器");
				return NULL;
			}
			NSMutableArray<SCWindow *> *excluded = [NSMutableArray array];
			if (excludeWinIDs && excludeCount > 0) {
				for (SCWindow *w in content.windows) {
					for (int i = 0; i < excludeCount; i++) {
						if (w.windowID == (CGWindowID)excludeWinIDs[i]) {
							[excluded addObject:w];
							break;
						}
					}
				}
			}
			SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:target excludingWindows:excluded];
			SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
			cfg.width = reqW > 0 ? reqW : (size_t)target.width;
			cfg.height = reqH > 0 ? reqH : (size_t)target.height;
			cfg.pixelFormat = 'BGRA';
			cfg.showsCursor = NO;
			cfg.capturesAudio = NO;
			cfg.captureResolution = SCCaptureResolutionBest;

			__block CGImageRef captured = NULL;
			__block NSError *capErr = nil;
			dispatch_semaphore_t sem2 = dispatch_semaphore_create(0);
			[SCScreenshotManager captureImageWithFilter:filter configuration:cfg completionHandler:^(CGImageRef img, NSError *err) {
				if (img) captured = CGImageRetain(img);
				capErr = err;
				dispatch_semaphore_signal(sem2);
			}];
			if (dispatch_semaphore_wait(sem2, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0) {
				if (captured) CGImageRelease(captured);
				*outErr = strdup("屏幕截图超时");
				return NULL;
			}
			if (capErr || !captured) {
				if (captured) CGImageRelease(captured);
				NSString *msg = capErr ? [capErr localizedDescription] : @"截图失败，请在系统设置开启屏幕录制权限";
				*outErr = strdup([msg UTF8String]);
				return NULL;
			}
			uint8_t *rgba = vega_cgimage_to_rgba(captured, outW, outH);
			CGImageRelease(captured);
			if (!rgba) {
				*outErr = strdup("屏幕图像转换失败");
			}
			return rgba;
		}
		void *cg = vega_cg_framework_handle();
		vega_cg_display_create_image_fn fn = cg ? (vega_cg_display_create_image_fn)dlsym(cg, "CGDisplayCreateImage") : NULL;
		if (!fn) {
			*outErr = strdup("当前系统不支持屏幕截图接口");
			return NULL;
		}
		CGImageRef captured = fn((CGDirectDisplayID)displayID);
		if (!captured) {
			*outErr = strdup("截图失败，请在系统设置开启屏幕录制权限");
			return NULL;
		}
		uint8_t *rgba = vega_cgimage_to_rgba(captured, outW, outH);
		CGImageRelease(captured);
		if (!rgba) {
			*outErr = strdup("屏幕图像转换失败");
		}
		return rgba;
	}
}

static uint8_t *vega_capture_window_rgba(uint32_t windowID, uint32_t reqW, uint32_t reqH, int *outW, int *outH, char **outErr) {
	*outW = 0;
	*outH = 0;
	*outErr = NULL;
	@autoreleasepool {
		if (@available(macOS 14.0, *)) {
			__block SCShareableContent *content = nil;
			__block NSError *contentErr = nil;
			dispatch_semaphore_t sem1 = dispatch_semaphore_create(0);
			[SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *sc, NSError *err) {
				content = sc;
				contentErr = err;
				dispatch_semaphore_signal(sem1);
			}];
			if (dispatch_semaphore_wait(sem1, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0 || contentErr || !content) {
				*outErr = strdup("获取窗口列表失败");
				return NULL;
			}
			SCWindow *target = nil;
			for (SCWindow *w in content.windows) {
				if (w.windowID == (CGWindowID)windowID) {
					target = w;
					break;
				}
			}
			if (!target) {
				*outErr = strdup("找不到目标窗口");
				return NULL;
			}
			SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
			SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
			if (reqW > 0 && reqH > 0) {
				cfg.width = reqW;
				cfg.height = reqH;
			}
			cfg.pixelFormat = 'BGRA';
			cfg.showsCursor = NO;
			cfg.capturesAudio = NO;
			cfg.ignoreShadowsSingleWindow = YES;
			cfg.captureResolution = SCCaptureResolutionBest;

			__block CGImageRef captured = NULL;
			__block NSError *capErr = nil;
			dispatch_semaphore_t sem2 = dispatch_semaphore_create(0);
			[SCScreenshotManager captureImageWithFilter:filter configuration:cfg completionHandler:^(CGImageRef img, NSError *err) {
				if (img) captured = CGImageRetain(img);
				capErr = err;
				dispatch_semaphore_signal(sem2);
			}];
			if (dispatch_semaphore_wait(sem2, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0 || capErr || !captured) {
				if (captured) CGImageRelease(captured);
				*outErr = strdup("窗口截图失败");
				return NULL;
			}
			uint8_t *rgba = vega_cgimage_to_rgba(captured, outW, outH);
			CGImageRelease(captured);
			if (!rgba) *outErr = strdup("窗口图像转换失败");
			return rgba;
		}
		void *cg = vega_cg_framework_handle();
		vega_cg_window_list_create_image_fn fn = cg ? (vega_cg_window_list_create_image_fn)dlsym(cg, "CGWindowListCreateImage") : NULL;
		if (!fn) {
			*outErr = strdup("当前系统不支持窗口截图接口");
			return NULL;
		}
		CGImageRef captured = fn(CGRectNull, kCGWindowListOptionIncludingWindow, (CGWindowID)windowID,
			kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution);
		if (!captured) {
			*outErr = strdup("窗口截图失败");
			return NULL;
		}
		uint8_t *rgba = vega_cgimage_to_rgba(captured, outW, outH);
		CGImageRelease(captured);
		if (!rgba) *outErr = strdup("窗口图像转换失败");
		return rgba;
	}
}

static void vega_request_permissions(void) {
	@autoreleasepool {
		NSDictionary *opts = @{ (__bridge id)kAXTrustedCheckOptionPrompt : @YES };
		AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
		if (!CGPreflightScreenCaptureAccess()) {
			CGRequestScreenCaptureAccess();
		}
	}
}

static int vega_list_windows(VegaWindowInfo **outWins, int *outCount) {
	*outWins = NULL;
	*outCount = 0;
	@autoreleasepool {
		CFArrayRef arr = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
		if (!arr) return -1;
		NSArray *list = CFBridgingRelease(arr);
		pid_t frontPID = 0;
		NSRunningApplication *frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
		if (frontApp) frontPID = [frontApp processIdentifier];
		pid_t selfPID = getpid();
		BOOL axTrusted = AXIsProcessTrusted();

		NSUInteger maxCount = [list count];
		VegaWindowInfo *buf = (VegaWindowInfo *)calloc(maxCount > 0 ? maxCount : 1, sizeof(VegaWindowInfo));
		if (!buf) return -1;
		int n = 0;
		BOOL markedFocused = NO;

		for (NSDictionary *dict in list) {
			NSNumber *layerNum = dict[(id)kCGWindowLayer];
			if (!layerNum || [layerNum intValue] != 0) continue;
			NSNumber *pidNum = dict[(id)kCGWindowOwnerPID];
			NSNumber *winNum = dict[(id)kCGWindowNumber];
			if (!pidNum || !winNum) continue;
			pid_t pid = (pid_t)[pidNum intValue];
			if (pid == selfPID) {
				// Keep Vega's own chat panel if titled, skip auxiliary windows.
			}
			NSDictionary *boundsDict = dict[(id)kCGWindowBounds];
			CGRect bounds = CGRectZero;
			if (!boundsDict || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsDict, &bounds)) continue;
			if (bounds.size.width <= 0 || bounds.size.height <= 0) continue;

			NSString *appName = dict[(id)kCGWindowOwnerName] ?: @"";
			NSString *title = dict[(id)kCGWindowName] ?: @"";
			if ([title length] == 0 && axTrusted) {
				AXUIElementRef appRef = AXUIElementCreateApplication(pid);
				if (appRef) {
					CFTypeRef axWindowsRef = NULL;
					if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &axWindowsRef) == kAXErrorSuccess && axWindowsRef) {
						NSArray *axWins = CFBridgingRelease(axWindowsRef);
						for (id wObj in axWins) {
							AXUIElementRef wRef = (__bridge AXUIElementRef)wObj;
							CFTypeRef posVal = NULL, sizeVal = NULL;
							CGPoint pt = CGPointZero; CGSize sz = CGSizeZero;
							if (AXUIElementCopyAttributeValue(wRef, kAXPositionAttribute, &posVal) == kAXErrorSuccess && posVal) {
								AXValueGetValue((AXValueRef)posVal, kAXValueCGPointType, &pt);
								CFRelease(posVal);
							}
							if (AXUIElementCopyAttributeValue(wRef, kAXSizeAttribute, &sizeVal) == kAXErrorSuccess && sizeVal) {
								AXValueGetValue((AXValueRef)sizeVal, kAXValueCGSizeType, &sz);
								CFRelease(sizeVal);
							}
							if (fabs(pt.x - bounds.origin.x) <= 2.0 && fabs(pt.y - bounds.origin.y) <= 2.0 &&
								fabs(sz.width - bounds.size.width) <= 2.0 && fabs(sz.height - bounds.size.height) <= 2.0) {
								CFTypeRef titleRef = NULL;
								if (AXUIElementCopyAttributeValue(wRef, kAXTitleAttribute, &titleRef) == kAXErrorSuccess && titleRef) {
									NSString *axTitle = CFBridgingRelease(titleRef);
									if ([axTitle isKindOfClass:[NSString class]] && [axTitle length] > 0) {
										title = axTitle;
									}
								}
								break;
							}
						}
					}
					CFRelease(appRef);
				}
			}
			if ([[title stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0) {
				continue;
			}
			buf[n].id = [winNum unsignedIntValue];
			buf[n].pid = (uint32_t)pid;
			buf[n].cgX = bounds.origin.x;
			buf[n].cgY = bounds.origin.y;
			buf[n].cgW = bounds.size.width;
			buf[n].cgH = bounds.size.height;
			buf[n].app = strdup([appName UTF8String]);
			buf[n].title = strdup([title UTF8String]);
			if (!markedFocused && frontPID > 0 && pid == frontPID) {
				buf[n].focused = 1;
				markedFocused = YES;
			}
			n++;
		}
		*outWins = buf;
		*outCount = n;
		return 0;
	}
}

static void vega_free_windows(VegaWindowInfo *wins, int count) {
	if (!wins) return;
	for (int i = 0; i < count; i++) {
		free(wins[i].app);
		free(wins[i].title);
	}
	free(wins);
}

extern AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *identifier) __attribute__((weak_import));

static int vega_activate_window(uint32_t windowID, uint32_t pid, double cgX, double cgY, double cgW, double cgH, const char *titleStr) {
	@autoreleasepool {
		NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
		if (!app) return -1;
		if ([app isHidden]) {
			[app unhide];
		}
		[app activateWithOptions:NSApplicationActivateAllWindows];

		if (AXIsProcessTrusted()) {
			AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)pid);
			if (appRef) {
				CFTypeRef axWindowsRef = NULL;
				if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &axWindowsRef) == kAXErrorSuccess && axWindowsRef) {
					NSArray *axWins = CFBridgingRelease(axWindowsRef);
					NSString *wantTitle = titleStr ? [NSString stringWithUTF8String:titleStr] : @"";
					AXUIElementRef matched = NULL;
					for (id wObj in axWins) {
						AXUIElementRef wRef = (__bridge AXUIElementRef)wObj;
						if (_AXUIElementGetWindow != NULL) {
							CGWindowID wid = 0;
							if (_AXUIElementGetWindow(wRef, &wid) == kAXErrorSuccess && wid == (CGWindowID)windowID) {
								matched = wRef;
								break;
							}
						}
						CFTypeRef posVal = NULL, sizeVal = NULL;
						CGPoint pt = CGPointZero; CGSize sz = CGSizeZero;
						if (AXUIElementCopyAttributeValue(wRef, kAXPositionAttribute, &posVal) == kAXErrorSuccess && posVal) {
							AXValueGetValue((AXValueRef)posVal, kAXValueCGPointType, &pt);
							CFRelease(posVal);
						}
						if (AXUIElementCopyAttributeValue(wRef, kAXSizeAttribute, &sizeVal) == kAXErrorSuccess && sizeVal) {
							AXValueGetValue((AXValueRef)sizeVal, kAXValueCGSizeType, &sz);
							CFRelease(sizeVal);
						}
						if (fabs(pt.x - cgX) <= 3.0 && fabs(pt.y - cgY) <= 3.0 &&
							fabs(sz.width - cgW) <= 3.0 && fabs(sz.height - cgH) <= 3.0) {
							matched = wRef;
							break;
						}
						CFTypeRef tRef = NULL;
						if (AXUIElementCopyAttributeValue(wRef, kAXTitleAttribute, &tRef) == kAXErrorSuccess && tRef) {
							NSString *t = CFBridgingRelease(tRef);
							if ([t isKindOfClass:[NSString class]] && [wantTitle length] > 0 && [t isEqualToString:wantTitle]) {
								matched = wRef;
							}
						}
					}
					if (matched) {
						AXUIElementSetAttributeValue(matched, kAXMainAttribute, kCFBooleanTrue);
						AXUIElementPerformAction(matched, kAXRaiseAction);
					}
				}
				CFRelease(appRef);
			}
		}
		return 0;
	}
}

static int vega_cursor_pos(double *outX, double *outY) {
	CGEventRef ev = CGEventCreate(NULL);
	if (!ev) return -1;
	CGPoint pt = CGEventGetLocation(ev);
	CFRelease(ev);
	*outX = pt.x;
	*outY = pt.y;
	return 0;
}

static void vega_move_pointer(double x, double y, int inputEvent, int heldBtn) {
	CGPoint pt = CGPointMake(x, y);
	if (inputEvent) {
		CGEventType evType = kCGEventMouseMoved;
		CGMouseButton mb = kCGMouseButtonLeft;
		if (heldBtn == 1) {
			evType = kCGEventLeftMouseDragged;
			mb = kCGMouseButtonLeft;
		} else if (heldBtn == 2) {
			evType = kCGEventRightMouseDragged;
			mb = kCGMouseButtonRight;
		} else if (heldBtn == 3) {
			evType = kCGEventOtherMouseDragged;
			mb = kCGMouseButtonCenter;
		}
		CGEventRef ev = CGEventCreateMouseEvent(NULL, evType, pt, mb);
		if (ev) {
			CGEventSetIntegerValueField(ev, kCGEventSourceUserData, VEGA_INJECTED_EVENT_TAG);
			CGEventPost(kCGHIDEventTap, ev);
			CFRelease(ev);
		}
	}
	CGAssociateMouseAndMouseCursorPosition(true);
	CGWarpMouseCursorPosition(pt);
}

static void vega_mouse_button(double x, double y, int btn, int down, int clickCount) {
	CGPoint pt = CGPointMake(x, y);
	CGEventType evType;
	CGMouseButton mb;
	if (btn == 2) {
		evType = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
		mb = kCGMouseButtonRight;
	} else if (btn == 3) {
		evType = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
		mb = kCGMouseButtonCenter;
	} else {
		evType = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
		mb = kCGMouseButtonLeft;
	}
	CGEventRef ev = CGEventCreateMouseEvent(NULL, evType, pt, mb);
	if (ev) {
		if (clickCount > 1) {
			CGEventSetIntegerValueField(ev, kCGMouseEventClickState, clickCount);
		}
		CGEventSetIntegerValueField(ev, kCGEventSourceUserData, VEGA_INJECTED_EVENT_TAG);
		CGEventPost(kCGHIDEventTap, ev);
		CFRelease(ev);
	}
}

static void vega_scroll_wheel(int horizontal, int delta) {
	CGEventRef ev = NULL;
	if (horizontal) {
		// Negative value scrolls right on macOS; match Windows positive = right/up semantics.
		ev = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, 0, -delta);
	} else {
		ev = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, delta);
	}
	if (ev) {
		CGEventSetIntegerValueField(ev, kCGEventSourceUserData, VEGA_INJECTED_EVENT_TAG);
		CGEventPost(kCGHIDEventTap, ev);
		CFRelease(ev);
	}
}

static void vega_key_event(uint16_t vk, uint64_t flags, int down) {
	CGEventRef ev = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)vk, down ? true : false);
	if (ev) {
		if (flags != 0) {
			CGEventSetFlags(ev, (CGEventFlags)flags);
		}
		CGEventSetIntegerValueField(ev, kCGEventSourceUserData, VEGA_INJECTED_EVENT_TAG);
		CGEventPost(kCGHIDEventTap, ev);
		CFRelease(ev);
	}
}

static void vega_type_utf16(const uint16_t *units, int count) {
	int offset = 0;
	while (offset < count) {
		int chunk = count - offset;
		if (chunk > 16) chunk = 16;
		CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
		if (down) {
			CGEventKeyboardSetUnicodeString(down, (UniCharCount)chunk, (const UniChar *)(units + offset));
			CGEventSetIntegerValueField(down, kCGEventSourceUserData, VEGA_INJECTED_EVENT_TAG);
			CGEventPost(kCGHIDEventTap, down);
			CFRelease(down);
		}
		CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
		if (up) {
			CGEventKeyboardSetUnicodeString(up, (UniCharCount)chunk, (const UniChar *)(units + offset));
			CGEventSetIntegerValueField(up, kCGEventSourceUserData, VEGA_INJECTED_EVENT_TAG);
			CGEventPost(kCGHIDEventTap, up);
			CFRelease(up);
		}
		offset += chunk;
	}
}
*/
import "C"

import (
	"flag"
	"fmt"
	"image"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"
)

type appuseKey struct {
	VK       uint16
	ModFlags uint64
}

type darwinDisplay struct {
	DisplayID uint32
	CGOriginX float64
	CGOriginY float64
	CGWidth   float64
	CGHeight  float64
	Scale     float64
	Surface   appuseSurface
}

var (
	appusePermOnce sync.Once

	appuseInputBtnMu sync.Mutex
	appuseHeldButton int // 0=none, 1=left, 2=right, 3=middle
	appuseLastClick  struct {
		at    time.Time
		x, y  float64
		btn   int
		count int
	}

	glowWinIDsMu sync.Mutex
	glowWinIDs   = map[uint32]struct{}{}
)

func registerGlowWindowID(id uint32, add bool) {
	if id == 0 {
		return
	}
	glowWinIDsMu.Lock()
	if add {
		glowWinIDs[id] = struct{}{}
	} else {
		delete(glowWinIDs, id)
	}
	glowWinIDsMu.Unlock()
}

func snapshotGlowWindowIDs() []uint32 {
	glowWinIDsMu.Lock()
	defer glowWinIDsMu.Unlock()
	ids := make([]uint32, 0, len(glowWinIDs))
	for id := range glowWinIDs {
		ids = append(ids, id)
	}
	return ids
}

func appuseInit() {
	appusePermOnce.Do(func() {
		if flag.Lookup("test.v") != nil || strings.HasSuffix(filepath.Base(os.Args[0]), ".test") {
			return
		}
		C.vega_request_permissions()
	})
}

func darwinBuildDisplayLayout(raw []darwinDisplay) []darwinDisplay {
	if len(raw) == 0 {
		return nil
	}
	maxScale := 1.0
	for _, d := range raw {
		if d.Scale > maxScale {
			maxScale = d.Scale
		}
	}
	out := make([]darwinDisplay, len(raw))
	for i, d := range raw {
		out[i] = d
		out[i].Surface = appuseSurface{
			ID: uint32(i),
			X:  int32(math.Round(d.CGOriginX * maxScale)),
			Y:  int32(math.Round(d.CGOriginY * maxScale)),
			W:  d.Surface.W,
			H:  d.Surface.H,
		}
	}
	return out
}

func darwinDisplayAtCG(displays []darwinDisplay, cx, cy float64) int {
	for i, d := range displays {
		if cx >= d.CGOriginX && cx < d.CGOriginX+d.CGWidth && cy >= d.CGOriginY && cy < d.CGOriginY+d.CGHeight {
			return i
		}
	}
	best := 0
	bestDist := math.MaxFloat64
	for i, d := range displays {
		midX, midY := d.CGOriginX+d.CGWidth/2, d.CGOriginY+d.CGHeight/2
		dist := math.Hypot(cx-midX, cy-midY)
		if dist < bestDist {
			bestDist = dist
			best = i
		}
	}
	return best
}

func darwinDisplayAtPhysical(displays []darwinDisplay, px, py int32) int {
	for i, d := range displays {
		s := d.Surface
		if px >= s.X && py >= s.Y && int64(px) < int64(s.X)+int64(s.W) && int64(py) < int64(s.Y)+int64(s.H) {
			return i
		}
	}
	best := 0
	bestDist := math.MaxFloat64
	for i, d := range displays {
		s := d.Surface
		midX, midY := float64(s.X)+float64(s.W)/2, float64(s.Y)+float64(s.H)/2
		dist := math.Hypot(float64(px)-midX, float64(py)-midY)
		if dist < bestDist {
			bestDist = dist
			best = i
		}
	}
	return best
}

func darwinCGPointToPhysical(displays []darwinDisplay, cx, cy float64) (appusePoint, uint32) {
	if len(displays) == 0 {
		return appusePoint{X: int32(math.Round(cx)), Y: int32(math.Round(cy))}, 0
	}
	idx := darwinDisplayAtCG(displays, cx, cy)
	d := displays[idx]
	px := d.Surface.X + int32(math.Round((cx-d.CGOriginX)*d.Scale))
	py := d.Surface.Y + int32(math.Round((cy-d.CGOriginY)*d.Scale))
	return appusePoint{X: px, Y: py}, d.Surface.ID
}

func darwinCGRectToPhysical(displays []darwinDisplay, cx, cy, cw, ch float64) (int32, int32, uint32, uint32, uint32) {
	if len(displays) == 0 {
		return int32(math.Round(cx)), int32(math.Round(cy)), uint32(math.Max(0, math.Round(cw))), uint32(math.Max(0, math.Round(ch))), 0
	}
	idx := darwinDisplayAtCG(displays, cx+cw/2, cy+ch/2)
	d := displays[idx]
	px := d.Surface.X + int32(math.Round((cx-d.CGOriginX)*d.Scale))
	py := d.Surface.Y + int32(math.Round((cy-d.CGOriginY)*d.Scale))
	pw := uint32(math.Max(0, math.Round(cw*d.Scale)))
	ph := uint32(math.Max(0, math.Round(ch*d.Scale)))
	return px, py, pw, ph, d.Surface.ID
}

func darwinPhysicalToCG(displays []darwinDisplay, px, py int32) (float64, float64) {
	if len(displays) == 0 {
		return float64(px), float64(py)
	}
	idx := darwinDisplayAtPhysical(displays, px, py)
	d := displays[idx]
	scale := d.Scale
	if scale <= 0 {
		scale = 1.0
	}
	cx := d.CGOriginX + float64(px-d.Surface.X)/scale
	cy := d.CGOriginY + float64(py-d.Surface.Y)/scale
	return cx, cy
}

func darwinCGToAppKitY(primaryLogicalHeight, cgY, height float64) float64 {
	return primaryLogicalHeight - cgY - height
}

func darwinDisplays() ([]darwinDisplay, error) {
	var cList *C.VegaDisplayInfo
	var cCount C.int
	if C.vega_list_displays(&cList, &cCount) != 0 || cList == nil || cCount <= 0 {
		return nil, fmt.Errorf("没有可截图的显示器")
	}
	defer C.free(unsafe.Pointer(cList))
	slice := unsafe.Slice(cList, int(cCount))
	raw := make([]darwinDisplay, int(cCount))
	for i, item := range slice {
		raw[i] = darwinDisplay{
			DisplayID: uint32(item.displayID),
			CGOriginX: float64(item.cgX),
			CGOriginY: float64(item.cgY),
			CGWidth:   float64(item.cgW),
			CGHeight:  float64(item.cgH),
			Scale:     float64(item.scale),
			Surface: appuseSurface{
				ID: uint32(i),
				W:  uint32(item.pixelsW),
				H:  uint32(item.pixelsH),
			},
		}
	}
	return darwinBuildDisplayLayout(raw), nil
}

func appuseMonitors() ([]appuseSurface, error) {
	displays, err := darwinDisplays()
	if err != nil {
		return nil, err
	}
	surfaces := make([]appuseSurface, len(displays))
	for i, d := range displays {
		surfaces[i] = d.Surface
	}
	return surfaces, nil
}

func copyRGBAFromC(buf *C.uint8_t, w, h int) *image.RGBA {
	if buf == nil || w <= 0 || h <= 0 {
		return nil
	}
	size := w * h * 4
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(img.Pix, unsafe.Slice((*byte)(unsafe.Pointer(buf)), size))
	return img
}

func appuseCaptureMonitor(surface appuseSurface) (*image.RGBA, error) {
	displays, err := darwinDisplays()
	if err != nil {
		return nil, err
	}
	if int(surface.ID) >= len(displays) {
		return nil, fmt.Errorf("显示器 %d 不存在", surface.ID)
	}
	d := displays[surface.ID]
	excluded := snapshotGlowWindowIDs()
	var exPtr *C.uint32_t
	if len(excluded) > 0 {
		exPtr = (*C.uint32_t)(unsafe.Pointer(&excluded[0]))
	}
	var outW, outH C.int
	var cErr *C.char
	rgba := C.vega_capture_display_rgba(C.uint32_t(d.DisplayID), C.uint32_t(d.Surface.W), C.uint32_t(d.Surface.H),
		exPtr, C.int(len(excluded)), &outW, &outH, &cErr)
	if cErr != nil {
		defer C.free(unsafe.Pointer(cErr))
	}
	if rgba == nil {
		msg := "截图失败"
		if cErr != nil {
			msg = C.GoString(cErr)
		}
		return nil, fmt.Errorf("%s", msg)
	}
	defer C.free(unsafe.Pointer(rgba))
	img := copyRGBAFromC(rgba, int(outW), int(outH))
	if img == nil {
		return nil, fmt.Errorf("截图缓冲为空")
	}
	return img, nil
}

func captureWindowImage(window appuseWindow) (*image.RGBA, error) {
	var outW, outH C.int
	var cErr *C.char
	rgba := C.vega_capture_window_rgba(C.uint32_t(window.ID), C.uint32_t(window.W), C.uint32_t(window.H), &outW, &outH, &cErr)
	if cErr != nil {
		defer C.free(unsafe.Pointer(cErr))
	}
	if rgba == nil {
		msg := "窗口截图失败"
		if cErr != nil {
			msg = C.GoString(cErr)
		}
		return nil, fmt.Errorf("%s", msg)
	}
	defer C.free(unsafe.Pointer(rgba))
	img := copyRGBAFromC(rgba, int(outW), int(outH))
	if img == nil {
		return nil, fmt.Errorf("窗口图像为空")
	}
	return img, nil
}

func appuseListWindows() ([]appuseWindow, error) {
	displays, err := darwinDisplays()
	if err != nil {
		displays = nil
	}
	var cWins *C.VegaWindowInfo
	var cCount C.int
	if C.vega_list_windows(&cWins, &cCount) != 0 {
		return nil, fmt.Errorf("无法枚举窗口")
	}
	if cWins == nil || cCount <= 0 {
		return []appuseWindow{}, nil
	}
	defer C.vega_free_windows(cWins, cCount)
	slice := unsafe.Slice(cWins, int(cCount))
	rows := make([]appuseWindow, 0, len(slice))
	for _, w := range slice {
		px, py, pw, ph, monID := darwinCGRectToPhysical(displays, float64(w.cgX), float64(w.cgY), float64(w.cgW), float64(w.cgH))
		rows = append(rows, appuseWindow{
			ID:        uint32(w.id),
			PID:       uint32(w.pid),
			App:       C.GoString(w.app),
			Title:     C.GoString(w.title),
			X:         px,
			Y:         py,
			W:         pw,
			H:         ph,
			Monitor:   monID,
			Focused:   w.focused != 0,
			Minimized: false,
		})
	}
	return rows, nil
}

func appuseWindowInfo(id uint32) (appuseWindow, error) {
	wins, err := appuseListWindows()
	if err != nil {
		return appuseWindow{}, err
	}
	for _, w := range wins {
		if w.ID == id {
			return w, nil
		}
	}
	return appuseWindow{}, fmt.Errorf("程序窗口已关闭，请重新 windows")
}

func appuseForegroundWindow() *uint32 {
	wins, err := appuseListWindows()
	if err != nil {
		return nil
	}
	for _, w := range wins {
		if w.Focused {
			id := w.ID
			return &id
		}
	}
	if len(wins) > 0 {
		id := wins[0].ID
		return &id
	}
	return nil
}

func appuseActivate(id uint32) error {
	var cWins *C.VegaWindowInfo
	var cCount C.int
	if C.vega_list_windows(&cWins, &cCount) != 0 || cWins == nil {
		return fmt.Errorf("无法读取窗口列表")
	}
	defer C.vega_free_windows(cWins, cCount)
	slice := unsafe.Slice(cWins, int(cCount))
	for _, w := range slice {
		if uint32(w.id) == id {
			if C.vega_activate_window(C.uint32_t(id), C.uint32_t(w.pid), C.double(w.cgX), C.double(w.cgY), C.double(w.cgW), C.double(w.cgH), w.title) != 0 {
				return fmt.Errorf("系统未允许激活该窗口")
			}
			time.Sleep(60 * time.Millisecond)
			return nil
		}
	}
	return fmt.Errorf("程序窗口已关闭，请重新 windows")
}

func appuseCursor() (appusePoint, bool) {
	var cx, cy C.double
	if C.vega_cursor_pos(&cx, &cy) != 0 {
		return appusePoint{}, false
	}
	displays, err := darwinDisplays()
	if err != nil {
		return appusePoint{X: int32(math.Round(float64(cx))), Y: int32(math.Round(float64(cy)))}, true
	}
	pt, _ := darwinCGPointToPhysical(displays, float64(cx), float64(cy))
	return pt, true
}

func appuseMovePointer(x, y int32, inputEvent bool) error {
	displays, err := darwinDisplays()
	if err != nil {
		return err
	}
	cx, cy := darwinPhysicalToCG(displays, x, y)
	appuseInputBtnMu.Lock()
	held := appuseHeldButton
	appuseInputBtnMu.Unlock()
	ie := C.int(0)
	if inputEvent {
		ie = 1
	}
	C.vega_move_pointer(C.double(cx), C.double(cy), ie, C.int(held))
	return nil
}

func mouseButtonCode(button string) int {
	switch button {
	case "right":
		return 2
	case "middle":
		return 3
	default:
		return 1
	}
}

func appuseMouseButton(button string, down bool) error {
	btn := mouseButtonCode(button)
	var cx, cy C.double
	if C.vega_cursor_pos(&cx, &cy) != 0 {
		return fmt.Errorf("无法获取鼠标位置")
	}
	appuseInputBtnMu.Lock()
	if down {
		appuseHeldButton = btn
	} else if appuseHeldButton == btn {
		appuseHeldButton = 0
	}
	appuseInputBtnMu.Unlock()
	d := C.int(0)
	if down {
		d = 1
	}
	C.vega_mouse_button(cx, cy, C.int(btn), d, 1)
	return nil
}

func appuseClick(button string) error {
	btn := mouseButtonCode(button)
	var cx, cy C.double
	if C.vega_cursor_pos(&cx, &cy) != 0 {
		return fmt.Errorf("无法获取鼠标位置")
	}
	appuseInputBtnMu.Lock()
	now := time.Now()
	count := 1
	if appuseLastClick.btn == btn && now.Sub(appuseLastClick.at) < 450*time.Millisecond &&
		math.Hypot(float64(cx)-appuseLastClick.x, float64(cy)-appuseLastClick.y) <= 4.0 {
		count = appuseLastClick.count + 1
	}
	appuseLastClick.at = now
	appuseLastClick.x = float64(cx)
	appuseLastClick.y = float64(cy)
	appuseLastClick.btn = btn
	appuseLastClick.count = count
	appuseHeldButton = 0
	appuseInputBtnMu.Unlock()

	C.vega_mouse_button(cx, cy, C.int(btn), 1, C.int(count))
	C.vega_mouse_button(cx, cy, C.int(btn), 0, C.int(count))
	return nil
}

func appuseWheel(axis string, delta int32) error {
	horiz := C.int(0)
	if axis == "horizontal" {
		horiz = 1
	}
	C.vega_scroll_wheel(horiz, C.int(delta))
	return nil
}

const (
	darwinFlagShift   uint64 = uint64(C.kCGEventFlagMaskShift)
	darwinFlagControl uint64 = uint64(C.kCGEventFlagMaskControl)
	darwinFlagAlt     uint64 = uint64(C.kCGEventFlagMaskAlternate)
	darwinFlagCommand uint64 = uint64(C.kCGEventFlagMaskCommand)
)

var darwinKeyTable = map[string]appuseKey{
	"ctrl":      {VK: C.kVK_Control, ModFlags: darwinFlagControl},
	"control":   {VK: C.kVK_Control, ModFlags: darwinFlagControl},
	"alt":       {VK: C.kVK_Option, ModFlags: darwinFlagAlt},
	"option":    {VK: C.kVK_Option, ModFlags: darwinFlagAlt},
	"shift":     {VK: C.kVK_Shift, ModFlags: darwinFlagShift},
	"meta":      {VK: C.kVK_Command, ModFlags: darwinFlagCommand},
	"super":     {VK: C.kVK_Command, ModFlags: darwinFlagCommand},
	"cmd":       {VK: C.kVK_Command, ModFlags: darwinFlagCommand},
	"command":   {VK: C.kVK_Command, ModFlags: darwinFlagCommand},
	"win":       {VK: C.kVK_Command, ModFlags: darwinFlagCommand},
	"enter":     {VK: C.kVK_Return},
	"return":    {VK: C.kVK_Return},
	"tab":       {VK: C.kVK_Tab},
	"escape":    {VK: C.kVK_Escape},
	"esc":       {VK: C.kVK_Escape},
	"space":     {VK: C.kVK_Space},
	"backspace": {VK: C.kVK_Delete},
	"delete":    {VK: C.kVK_ForwardDelete},
	"left":      {VK: C.kVK_LeftArrow},
	"arrowleft": {VK: C.kVK_LeftArrow},
	"up":        {VK: C.kVK_UpArrow},
	"arrowup":   {VK: C.kVK_UpArrow},
	"right":     {VK: C.kVK_RightArrow},
	"arrowright": {VK: C.kVK_RightArrow},
	"down":      {VK: C.kVK_DownArrow},
	"arrowdown": {VK: C.kVK_DownArrow},
	"home":      {VK: C.kVK_Home},
	"end":       {VK: C.kVK_End},
	"pageup":    {VK: C.kVK_PageUp},
	"pagedown":  {VK: C.kVK_PageDown},
	"f1":        {VK: C.kVK_F1},
	"f2":        {VK: C.kVK_F2},
	"f3":        {VK: C.kVK_F3},
	"f4":        {VK: C.kVK_F4},
	"f5":        {VK: C.kVK_F5},
	"f6":        {VK: C.kVK_F6},
	"f7":        {VK: C.kVK_F7},
	"f8":        {VK: C.kVK_F8},
	"f9":        {VK: C.kVK_F9},
	"f10":       {VK: C.kVK_F10},
	"f11":       {VK: C.kVK_F11},
	"f12":       {VK: C.kVK_F12},
	"f13":       {VK: C.kVK_F13},
	"f14":       {VK: C.kVK_F14},
	"f15":       {VK: C.kVK_F15},
	"f16":       {VK: C.kVK_F16},
	"f17":       {VK: C.kVK_F17},
	"f18":       {VK: C.kVK_F18},
	"f19":       {VK: C.kVK_F19},
	"f20":       {VK: C.kVK_F20},
	"a": {VK: C.kVK_ANSI_A}, "b": {VK: C.kVK_ANSI_B}, "c": {VK: C.kVK_ANSI_C}, "d": {VK: C.kVK_ANSI_D},
	"e": {VK: C.kVK_ANSI_E}, "f": {VK: C.kVK_ANSI_F}, "g": {VK: C.kVK_ANSI_G}, "h": {VK: C.kVK_ANSI_H},
	"i": {VK: C.kVK_ANSI_I}, "j": {VK: C.kVK_ANSI_J}, "k": {VK: C.kVK_ANSI_K}, "l": {VK: C.kVK_ANSI_L},
	"m": {VK: C.kVK_ANSI_M}, "n": {VK: C.kVK_ANSI_N}, "o": {VK: C.kVK_ANSI_O}, "p": {VK: C.kVK_ANSI_P},
	"q": {VK: C.kVK_ANSI_Q}, "r": {VK: C.kVK_ANSI_R}, "s": {VK: C.kVK_ANSI_S}, "t": {VK: C.kVK_ANSI_T},
	"u": {VK: C.kVK_ANSI_U}, "v": {VK: C.kVK_ANSI_V}, "w": {VK: C.kVK_ANSI_W}, "x": {VK: C.kVK_ANSI_X},
	"y": {VK: C.kVK_ANSI_Y}, "z": {VK: C.kVK_ANSI_Z},
	"0": {VK: C.kVK_ANSI_0}, "1": {VK: C.kVK_ANSI_1}, "2": {VK: C.kVK_ANSI_2}, "3": {VK: C.kVK_ANSI_3},
	"4": {VK: C.kVK_ANSI_4}, "5": {VK: C.kVK_ANSI_5}, "6": {VK: C.kVK_ANSI_6}, "7": {VK: C.kVK_ANSI_7},
	"8": {VK: C.kVK_ANSI_8}, "9": {VK: C.kVK_ANSI_9},
}

func appuseKeyOf(name string) (appuseKey, error) {
	if k, ok := darwinKeyTable[name]; ok {
		return k, nil
	}
	return appuseKey{}, fmt.Errorf("不支持的按键：%s", name)
}

func appuseKeyPress(keys []appuseKey) error {
	var flags uint64
	for _, key := range keys {
		flags |= key.ModFlags
		C.vega_key_event(C.uint16_t(key.VK), C.uint64_t(flags), 1)
	}
	return nil
}

func appuseKeyRelease(keys []appuseKey) error {
	var flags uint64
	for _, key := range keys {
		flags |= key.ModFlags
	}
	for index := len(keys) - 1; index >= 0; index-- {
		flags &^= keys[index].ModFlags
		C.vega_key_event(C.uint16_t(keys[index].VK), C.uint64_t(flags), 0)
	}
	return nil
}

func appuseTypeText(text string) error {
	if text == "" {
		return nil
	}
	units := utf16.Encode([]rune(text))
	if len(units) == 0 {
		return nil
	}
	C.vega_type_utf16((*C.uint16_t)(unsafe.Pointer(&units[0])), C.int(len(units)))
	return nil
}
