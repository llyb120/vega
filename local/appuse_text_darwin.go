//go:build darwin && cgo

package main

// macOS 文本输入：通过 NSPasteboard 写入整段文本并触发 Cmd+V 粘贴，随后还原用户原有剪贴板。

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework AppKit
#import <AppKit/AppKit.h>
#include <stdlib.h>
#include <string.h>

static int vega_pasteboard_set(const char *text) {
	@autoreleasepool {
		NSPasteboard *pb = [NSPasteboard generalPasteboard];
		if (!pb) return -1;
		NSString *str = text ? [NSString stringWithUTF8String:text] : @"";
		if (!str) return -1;
		[pb clearContents];
		return [pb setString:str forType:NSPasteboardTypeString] ? 0 : -1;
	}
}

static char *vega_pasteboard_get(void) {
	@autoreleasepool {
		NSPasteboard *pb = [NSPasteboard generalPasteboard];
		if (!pb) return NULL;
		NSString *str = [pb stringForType:NSPasteboardTypeString];
		if (!str) return NULL;
		const char *utf8 = [str UTF8String];
		return utf8 ? strdup(utf8) : NULL;
	}
}
*/
import "C"

import (
	"fmt"
	"time"
	"unsafe"
)

func appuseSetClipboardText(text string) error {
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	if C.vega_pasteboard_set(cText) != 0 {
		return fmt.Errorf("无法写入剪贴板")
	}
	return nil
}

func appuseClipboardText() (string, bool) {
	cText := C.vega_pasteboard_get()
	if cText == nil {
		return "", false
	}
	defer C.free(unsafe.Pointer(cText))
	return C.GoString(cText), true
}

func appusePasteText(text string) error {
	if text == "" {
		return nil
	}
	saved, hadSaved := appuseClipboardText()
	if err := appuseSetClipboardText(text); err != nil {
		return appuseTypeText(text)
	}
	time.Sleep(15 * time.Millisecond)
	err := appusePressCombo("cmd+v")
	time.Sleep(100 * time.Millisecond)
	if hadSaved {
		_ = appuseSetClipboardText(saved)
	}
	return err
}
