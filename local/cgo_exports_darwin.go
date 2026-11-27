//go:build darwin && cgo

package main

// Cgo 回调导出集中放在此文件：避免带 Objective-C @implementation 的文件因 //export 被 Cgo 二次编译导致符号重复。

/*
#include <stdint.h>
*/
import "C"

//export goVegaBubbleMessage
func goVegaBubbleMessage(cMsg *C.char) {
	handleDarwinBubbleMessage(C.GoString(cMsg))
}

//export goVegaPanelMessage
func goVegaPanelMessage(cMsg *C.char) {
	panelWindowMessage(C.GoString(cMsg))
}

//export goVegaPanelGeometryChanged
func goVegaPanelGeometryChanged(x, y, w, h C.int) {
	savePanelGeometryRect(butterflyPanelDataDir(), int32(x), int32(y), int32(w), int32(h))
}

//export goVegaPanelNavigationFinished
func goVegaPanelNavigationFinished() {
	handleDarwinPanelNavigationFinished()
}

//export goVegaTrayDidFinishLaunching
func goVegaTrayDidFinishLaunching() {
	handleDarwinTrayDidFinishLaunching()
}

//export goVegaTrayAction
func goVegaTrayAction(action C.int) {
	handleDarwinTrayAction(int(action))
}

//export goVegaGlowRegisterWindow
func goVegaGlowRegisterWindow(winID C.uint32_t, add C.int) {
	registerGlowWindowID(uint32(winID), add != 0)
}

//export goVegaGlowShouldContinue
func goVegaGlowShouldContinue(outIntensity *C.double) C.int {
	intensity, cont := handleDarwinGlowShouldContinue()
	if outIntensity != nil {
		*outIntensity = C.double(intensity)
	}
	if cont {
		return 1
	}
	return 0
}

//export goVegaEscPressed
func goVegaEscPressed() {
	handleDarwinEscPressed()
}
