package main

// 扩展随客户端一起发布：二进制里带着一份解压好的文件，配置页点「更新浏览器扩展」时写回本机，
// 再交给一个牛马在电脑会话里用 appuse 加载（见 installExtension）。

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed extension/vega-chrome
var bundledExtension embed.FS

const bundledExtensionRoot = "extension/vega-chrome"

// extensionDir 是本机可加载的扩展目录；每次点击都整份重写，避免残留旧文件让 Chrome 加载到半新半旧。
func (a *Agent) extensionDir() string {
	return filepath.Join(a.dataDir, "extension", "vega-chrome")
}

// writeBundledExtension 把内置扩展解压到数据目录，返回可以直接「加载已解压的扩展程序」的路径。
func (a *Agent) writeBundledExtension() (string, error) {
	dir := a.extensionDir()
	if err := os.RemoveAll(dir); err != nil {
		return "", fmt.Errorf("清理旧的扩展目录失败：%w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("创建扩展目录失败：%w", err)
	}
	err := fs.WalkDir(bundledExtension, bundledExtensionRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(bundledExtensionRoot, path)
		if err != nil || rel == "." {
			return err
		}
		target := filepath.Join(dir, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := bundledExtension.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
	if err != nil {
		return "", fmt.Errorf("写入内置扩展失败：%w", err)
	}
	a.clientLog("已把内置浏览器扩展写到 %s", dir)
	return dir, nil
}
