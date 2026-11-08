//go:build !windows

package main

import (
	"errors"
	"image"
)

// 非 Windows 没有 DXGI Desktop Duplication：如实报不支持，由调用方走平台通道。
var errNoDXGI = errors.New("DXGI Desktop Duplication 只在 Windows 上可用")

func dxgiGrab(appuseSurface) (*image.RGBA, error) {
	return nil, errNoDXGI
}
