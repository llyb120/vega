//go:build darwin && cgo

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

static void vega_show_alert_on_main(const char *msg) {
	@autoreleasepool {
		NSString *text = msg ? [NSString stringWithUTF8String:msg] : @"";
		void (^show)(void) = ^{
			@autoreleasepool {
				[NSApplication sharedApplication];
				[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
				[NSApp activateIgnoringOtherApps:YES];
				NSAlert *alert = [[NSAlert alloc] init];
				[alert setAlertStyle:NSAlertStyleCritical];
				[alert setMessageText:@"牵牛星客户端"];
				[alert setInformativeText:text];
				[alert addButtonWithTitle:@"确定"];
				[alert runModal];
			}
		};
		if ([NSThread isMainThread]) {
			show();
		} else {
			dispatch_sync(dispatch_get_main_queue(), show);
		}
	}
}
*/
import "C"

import (
	"fmt"
	"os"
	"unsafe"
)

func alertUser(message string) {
	fmt.Fprintln(os.Stderr, "vega-local:", message)
	if butterflyQuiet || os.Getenv("VEGA_TEST_NO_ALERT") == "1" {
		return
	}
	cMsg := C.CString(message)
	defer C.free(unsafe.Pointer(cMsg))
	C.vega_show_alert_on_main(cMsg)
}
