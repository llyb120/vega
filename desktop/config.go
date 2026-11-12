package main

// 和 vega-local 一样：网站下载的 ZIP 里带 instance.json，里面写死了这个包属于哪个站点。
// 桌面窗口只打开这个站点，不再让用户填写或修改服务器地址。

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type instancePin struct {
	Origin       string `json:"origin"`
	DownloadedAt int64  `json:"downloadedAt,omitempty"`
}

const instanceFileName = "instance.json"

func validOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http"
}

// readInstancePin 读目录里的安装包信息。没有它就不是从站点下载的安装包。
func readInstancePin(dir string) (instancePin, error) {
	var pin instancePin
	data, err := os.ReadFile(filepath.Join(dir, instanceFileName))
	if err != nil {
		return pin, fmt.Errorf("缺少站点信息 %s：请回到站点重新下载安装包（ZIP）", instanceFileName)
	}
	if err = json.Unmarshal(data, &pin); err != nil {
		return pin, fmt.Errorf("%s 不是有效的站点信息：%w", instanceFileName, err)
	}
	if !validOrigin(pin.Origin) {
		return pin, fmt.Errorf("%s 里的站点地址无效：%q", instanceFileName, pin.Origin)
	}
	return pin, nil
}

// resolvePin 决定这个桌面窗口属于哪个站点。
// 正式安装包读可执行文件同目录的 instance.json；本地开发可用 VEGA_ORIGIN，或在当前目录放一份 instance.json。
func resolvePin() (instancePin, error) {
	if origin := strings.TrimSpace(os.Getenv("VEGA_ORIGIN")); origin != "" {
		if !validOrigin(origin) {
			return instancePin{}, fmt.Errorf("VEGA_ORIGIN 里的站点地址无效：%q", origin)
		}
		return instancePin{Origin: origin}, nil
	}
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(exe))
	}
	if cwd, err := os.Getwd(); err == nil {
		dirs = append(dirs, cwd)
	}
	seen := map[string]bool{}
	var last error
	for _, dir := range dirs {
		abs, err := filepath.Abs(dir)
		if err != nil {
			abs = dir
		}
		if seen[abs] {
			continue
		}
		seen[abs] = true
		pin, err := readInstancePin(abs)
		if err == nil {
			return pin, nil
		}
		last = err
	}
	if last != nil {
		return instancePin{}, last
	}
	return instancePin{}, fmt.Errorf("缺少站点信息 %s：请回到站点重新下载安装包（ZIP）", instanceFileName)
}

func bindingsOrigins(origin string) string {
	origins := []string{
		"http://127.0.0.1:*",
		"http://localhost:*",
		"http://[::1]:*",
		"https://127.0.0.1:*",
		"https://localhost:*",
		"https://[::1]:*",
	}
	if validOrigin(origin) {
		origins = append([]string{origin}, origins...)
	}
	return strings.Join(origins, ",")
}
