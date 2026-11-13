package main

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:grok_ui
var grokUIFS embed.FS

// grokFS 返回嵌入的 grok_ui 子文件系统
func grokFS() fs.FS {
	sub, err := fs.Sub(grokUIFS, "grok_ui")
	if err != nil {
		return nil
	}
	return sub
}

// grokFileServer 提供静态资源服务
func grokFileServer() http.Handler {
	sub := grokFS()
	if sub == nil {
		return http.NotFoundHandler()
	}
	return http.FileServer(http.FS(sub))
}
