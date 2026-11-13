package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"net/http"
)

//go:embed grok_ui.zip
var grokZipData []byte

// grokFileServer 提供从嵌入 zip 包读取的静态资源服务
func grokFileServer() http.Handler {
	zr, err := zip.NewReader(bytes.NewReader(grokZipData), int64(len(grokZipData)))
	if err != nil {
		return http.NotFoundHandler()
	}
	return http.FileServer(http.FS(zr))
}
