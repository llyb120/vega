//go:build !windows

package main

import "fmt"

func appuseCollectFastUIA(uint32, []appuseControlRect) appuseUIAExtract {
	return appuseUIAExtract{}
}

func appuseCollectFullUIA(uint32, int, int, string) (appuseUIAExtract, error) {
	return appuseUIAExtract{}, fmt.Errorf("控件树仅支持 Windows；未操作桌面")
}
