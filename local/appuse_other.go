//go:build !windows

package main

// appuse 只在 Windows 客户端可用：其它平台如实拒绝，绝不用脚本或别的自动化绕行。

import (
	"fmt"
	"image"
)

type appuseKey struct{ VK uint16 }

const appuseUnsupported = "appuse 目前只支持 Windows 客户端操作桌面；本机未执行任何操作"

func appuseInit() {}

func appuseMonitors() ([]appuseSurface, error) { return nil, fmt.Errorf(appuseUnsupported) }

func appuseCaptureMonitor(appuseSurface) (*image.RGBA, error) {
	return nil, fmt.Errorf(appuseUnsupported)
}

func appuseListWindows() ([]appuseWindow, error) { return nil, fmt.Errorf(appuseUnsupported) }

func appuseWindowInfo(uint32) (appuseWindow, error) {
	return appuseWindow{}, fmt.Errorf(appuseUnsupported)
}

func appuseForegroundWindow() *uint32 { return nil }

func appuseActivate(uint32) error { return fmt.Errorf(appuseUnsupported) }

func appuseCursor() (appusePoint, bool) { return appusePoint{}, false }

func appuseMovePointer(int32, int32, bool) error { return fmt.Errorf(appuseUnsupported) }

func appuseMouseButton(string, bool) error { return fmt.Errorf(appuseUnsupported) }

func appuseClick(string) error { return fmt.Errorf(appuseUnsupported) }

func appuseWheel(string, int32) error { return fmt.Errorf(appuseUnsupported) }

func appuseKeyPress([]appuseKey) error { return fmt.Errorf(appuseUnsupported) }

func appuseKeyRelease([]appuseKey) error { return fmt.Errorf(appuseUnsupported) }

func appuseTypeText(string) error { return fmt.Errorf(appuseUnsupported) }

func appuseKeyOf(string) (appuseKey, error) { return appuseKey{}, fmt.Errorf(appuseUnsupported) }
