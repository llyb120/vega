//go:build darwin && cgo

package main

// macOS Accessibility (AXUIElement) 底层封装：带安全超时与弱符号窗口匹配。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics -framework CoreFoundation -framework AppKit
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>

extern AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *identifier) __attribute__((weak_import));

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

static char *vega_cfstr_to_cstr(CFTypeRef ref) {
	if (!ref) return NULL;
	if (CFGetTypeID(ref) == CFStringGetTypeID()) {
		NSString *s = (__bridge NSString *)ref;
		if ([s length] > 1024) s = [s substringToIndex:1024];
		const char *utf8 = [s UTF8String];
		return utf8 ? strdup(utf8) : NULL;
	}
	return NULL;
}

static char *vega_ax_str_attr(AXUIElementRef elem, CFStringRef attr) {
	CFTypeRef val = NULL;
	if (AXUIElementCopyAttributeValue(elem, attr, &val) != kAXErrorSuccess || !val) {
		return NULL;
	}
	char *out = vega_cfstr_to_cstr(val);
	CFRelease(val);
	return out;
}

static int vega_ax_bool_attr(AXUIElementRef elem, CFStringRef attr, int defaultVal) {
	CFTypeRef val = NULL;
	if (AXUIElementCopyAttributeValue(elem, attr, &val) != kAXErrorSuccess || !val) {
		return defaultVal;
	}
	int out = defaultVal;
	if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
		out = CFBooleanGetValue((CFBooleanRef)val) ? 1 : 0;
	}
	CFRelease(val);
	return out;
}

static int vega_ax_rect(AXUIElementRef elem, double *ox, double *oy, double *ow, double *oh) {
	CFTypeRef posVal = NULL, sizeVal = NULL;
	CGPoint pt = CGPointZero;
	CGSize sz = CGSizeZero;
	if (AXUIElementCopyAttributeValue(elem, kAXPositionAttribute, &posVal) != kAXErrorSuccess || !posVal) {
		return -1;
	}
	BOOL gotPos = AXValueGetValue((AXValueRef)posVal, kAXValueCGPointType, &pt);
	CFRelease(posVal);
	if (!gotPos) return -1;

	if (AXUIElementCopyAttributeValue(elem, kAXSizeAttribute, &sizeVal) != kAXErrorSuccess || !sizeVal) {
		return -1;
	}
	BOOL gotSize = AXValueGetValue((AXValueRef)sizeVal, kAXValueCGSizeType, &sz);
	CFRelease(sizeVal);
	if (!gotSize) return -1;

	*ox = pt.x; *oy = pt.y; *ow = sz.width; *oh = sz.height;
	return 0;
}

void vega_ax_read_node(AXUIElementRef elem, VegaAXNode *out) {
	memset(out, 0, sizeof(*out));
	if (!elem) return;
	out->role = vega_ax_str_attr(elem, kAXRoleAttribute);
	out->className = vega_ax_str_attr(elem, kAXSubroleAttribute);
	out->automationID = vega_ax_str_attr(elem, kAXIdentifierAttribute);
	out->enabled = vega_ax_bool_attr(elem, kAXEnabledAttribute, 1);

	char *title = vega_ax_str_attr(elem, kAXTitleAttribute);
	if (title && title[0] != '\0') {
		out->name = title;
	} else {
		free(title);
		char *desc = vega_ax_str_attr(elem, kAXDescriptionAttribute);
		if (desc && desc[0] != '\0') {
			out->name = desc;
		} else {
			free(desc);
			char *val = vega_ax_str_attr(elem, kAXValueAttribute);
			if (val && val[0] != '\0') {
				out->name = val;
			} else {
				free(val);
			}
		}
	}
	if (vega_ax_rect(elem, &out->x, &out->y, &out->w, &out->h) != 0) {
		out->w = 0;
		out->h = 0;
	}
}

void vega_ax_free_node(VegaAXNode *node) {
	if (!node) return;
	free(node->name);
	free(node->role);
	free(node->automationID);
	free(node->className);
	memset(node, 0, sizeof(*node));
}

AXUIElementRef vega_ax_find_window(uint32_t pid, uint32_t windowID, double cgX, double cgY, double cgW, double cgH, const char *wantTitle) {
	@autoreleasepool {
		if (!AXIsProcessTrusted()) return NULL;
		AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)pid);
		if (!appRef) return NULL;
		CFTypeRef axWindowsRef = NULL;
		if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &axWindowsRef) != kAXErrorSuccess || !axWindowsRef) {
			CFRelease(appRef);
			return NULL;
		}
		NSArray *wins = CFBridgingRelease(axWindowsRef);
		CFRelease(appRef);
		NSString *titleStr = wantTitle ? [NSString stringWithUTF8String:wantTitle] : @"";
		AXUIElementRef fallback = NULL;

		for (id wObj in wins) {
			AXUIElementRef wRef = (__bridge AXUIElementRef)wObj;
			if (_AXUIElementGetWindow != NULL) {
				CGWindowID wid = 0;
				if (_AXUIElementGetWindow(wRef, &wid) == kAXErrorSuccess && wid == (CGWindowID)windowID) {
					CFRetain(wRef);
					if (fallback) CFRelease(fallback);
					return wRef;
				}
			}
			double wx = 0, wy = 0, ww = 0, wh = 0;
			if (vega_ax_rect(wRef, &wx, &wy, &ww, &wh) == 0) {
				if (fabs(wx - cgX) <= 3.0 && fabs(wy - cgY) <= 3.0 &&
					fabs(ww - cgW) <= 3.0 && fabs(wh - cgH) <= 3.0) {
					CFRetain(wRef);
					if (fallback) CFRelease(fallback);
					return wRef;
				}
			}
			if (!fallback && [titleStr length] > 0) {
				char *t = vega_ax_str_attr(wRef, kAXTitleAttribute);
				if (t) {
					NSString *cur = [NSString stringWithUTF8String:t];
					free(t);
					if (cur && [cur isEqualToString:titleStr]) {
						CFRetain(wRef);
						fallback = wRef;
					}
				}
			}
		}
		return fallback;
	}
}

int vega_ax_children(AXUIElementRef elem, AXUIElementRef **outChildren, int *outCount) {
	*outChildren = NULL;
	*outCount = 0;
	CFTypeRef val = NULL;
	if (AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute, &val) != kAXErrorSuccess || !val) {
		return 0;
	}
	if (CFGetTypeID(val) != CFArrayGetTypeID()) {
		CFRelease(val);
		return 0;
	}
	CFArrayRef arr = (CFArrayRef)val;
	CFIndex count = CFArrayGetCount(arr);
	if (count <= 0) {
		CFRelease(val);
		return 0;
	}
	AXUIElementRef *list = (AXUIElementRef *)calloc((size_t)count, sizeof(AXUIElementRef));
	if (!list) {
		CFRelease(val);
		return -1;
	}
	for (CFIndex i = 0; i < count; i++) {
		AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(arr, i);
		if (child) {
			CFRetain(child);
			list[i] = child;
		}
	}
	CFRelease(val);
	*outChildren = list;
	*outCount = (int)count;
	return 0;
}

void vega_ax_free_children(AXUIElementRef *children, int count) {
	if (!children) return;
	for (int i = 0; i < count; i++) {
		if (children[i]) CFRelease(children[i]);
	}
	free(children);
}

AXUIElementRef vega_ax_element_at(uint32_t pid, double cgX, double cgY) {
	if (!AXIsProcessTrusted()) return NULL;
	AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)pid);
	if (!appRef) return NULL;
	AXUIElementRef elem = NULL;
	AXError err = AXUIElementCopyElementAtPosition(appRef, (float)cgX, (float)cgY, &elem);
	CFRelease(appRef);
	if (err != kAXErrorSuccess) return NULL;
	return elem;
}

AXUIElementRef vega_ax_parent(AXUIElementRef elem) {
	if (!elem) return NULL;
	CFTypeRef parent = NULL;
	if (AXUIElementCopyAttributeValue(elem, kAXParentAttribute, &parent) != kAXErrorSuccess || !parent) {
		return NULL;
	}
	if (CFGetTypeID(parent) != AXUIElementGetTypeID()) {
		CFRelease(parent);
		return NULL;
	}
	return (AXUIElementRef)parent;
}

uint32_t vega_cg_window_at_point(double cgX, double cgY) {
	@autoreleasepool {
		CFArrayRef arr = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
		if (!arr) return 0;
		NSArray *list = CFBridgingRelease(arr);
		for (NSDictionary *dict in list) {
			NSNumber *layerNum = dict[(id)kCGWindowLayer];
			if (!layerNum || [layerNum intValue] != 0) continue;
			NSDictionary *boundsDict = dict[(id)kCGWindowBounds];
			CGRect bounds = CGRectZero;
			if (!boundsDict || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsDict, &bounds)) continue;
			if (CGRectContainsPoint(bounds, CGPointMake(cgX, cgY))) {
				NSNumber *winNum = dict[(id)kCGWindowNumber];
				if (winNum) return [winNum unsignedIntValue];
			}
		}
		return 0;
	}
}
*/
import "C"

import "time"

const uiaBudget = 2500 * time.Millisecond

func axRoleNormalize(axRole string) string {
	switch axRole {
	case "AXButton":
		return "button"
	case "AXCheckBox":
		return "checkbox"
	case "AXComboBox", "AXPopUpButton":
		return "combobox"
	case "AXTextField", "AXTextArea", "AXSearchField":
		return "textbox"
	case "AXLink":
		return "link"
	case "AXImage":
		return "image"
	case "AXRow", "AXCell":
		return "listitem"
	case "AXList":
		return "list"
	case "AXMenu":
		return "menu"
	case "AXMenuBar":
		return "menubar"
	case "AXMenuItem", "AXMenuBarItem":
		return "menuitem"
	case "AXProgressIndicator":
		return "progressbar"
	case "AXRadioButton":
		return "radiobutton"
	case "AXScrollBar":
		return "scrollbar"
	case "AXSlider":
		return "slider"
	case "AXStaticText":
		return "text"
	case "AXToolbar":
		return "toolbar"
	case "AXTabGroup":
		return "tablist"
	case "AXOutline":
		return "tree"
	case "AXGroup":
		return "group"
	case "AXTable":
		return "table"
	case "AXWindow":
		return "window"
	case "AXSplitGroup", "AXScrollArea":
		return "pane"
	case "AXWebArea":
		return "document"
	case "AXSeparator":
		return "separator"
	}
	if len(axRole) > 2 && axRole[:2] == "AX" {
		return axRole[2:]
	}
	if axRole == "" {
		return "custom"
	}
	return axRole
}
