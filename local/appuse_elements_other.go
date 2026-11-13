//go:build !windows

package main

import "fmt"

func appuseQueryElements(uint32, int, int, string) (appuseControlTree, error) {
	return appuseControlTree{}, fmt.Errorf("控件树仅支持 Windows；未操作桌面")
}
func appuseWindowAtPoint(appusePoint) (uint32, error) {
	return 0, fmt.Errorf("控件树仅支持 Windows")
}
func appuseCheckElement(uint32, appusePoint, appuseControl) error {
	return fmt.Errorf("控件校验仅支持 Windows")
}
