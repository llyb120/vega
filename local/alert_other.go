//go:build !windows

package main

import (
	"fmt"
	"os"
)

// 没有桌面弹框的平台上，把启动失败原因写到 stderr。
func alertUser(message string) { fmt.Fprintln(os.Stderr, "vega-local:", message) }
