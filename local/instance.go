package main

// 一个站点一份客户端：exe 同目录的 instance.json 说明它属于哪个站点，
// 数据目录也按站点分开，多个站点各自独立、不会互相覆盖配置。

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type instancePin struct {
	Origin       string `json:"origin"`
	DownloadedAt int64  `json:"downloadedAt,omitempty"`
}

const instanceFileName = "instance.json"

// readInstancePin 读 exe 同目录的安装包信息。没有它就不是从站点下载的安装包，直接拒绝启动。
func readInstancePin(exeDir string) (instancePin, error) {
	var pin instancePin
	data, err := os.ReadFile(filepath.Join(exeDir, instanceFileName))
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

// siteSlug 把站点地址变成数据目录名：默认端口只留主机名，其它端口和 http 明文方案带上以免撞名。
func siteSlug(origin string) (string, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Hostname() == "" {
		return "", fmt.Errorf("无效的站点地址：%q", origin)
	}
	slug := strings.ToLower(parsed.Hostname())
	if parsed.Scheme == "http" {
		slug = "http-" + slug
	}
	port := parsed.Port()
	if port != "" && !((parsed.Scheme == "https" && port == "443") || (parsed.Scheme == "http" && port == "80")) {
		slug += "_" + port
	}
	cleaned := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, slug)
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return "", fmt.Errorf("无法从站点地址生成数据目录：%q", origin)
	}
	return cleaned, nil
}

// siteDataDir 是某个站点在本机的数据目录：配置、凭据、面板登录态都在里面。
func siteDataDir(origin string) (string, error) {
	slug, err := siteSlug(origin)
	if err != nil {
		return "", err
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "vega-local", slug)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

// siteLabel 是托盘上显示的站点名（主机名，非默认端口时带端口）。
func (a *Agent) siteLabel() string {
	slug, err := siteSlug(a.pinnedOrigin)
	if err != nil {
		return a.pinnedOrigin
	}
	return slug
}

// ensureInstanceFile 首次运行时把站点地址写进数据目录；已有记录保持一致。
func ensureInstanceFile(dir string, pin instancePin) error {
	path := filepath.Join(dir, instanceFileName)
	if saved, err := os.ReadFile(path); err == nil {
		var existing instancePin
		if json.Unmarshal(saved, &existing) == nil && existing.Origin == pin.Origin {
			return nil
		}
	}
	if pin.DownloadedAt == 0 {
		pin.DownloadedAt = time.Now().UnixMilli()
	}
	data, err := json.MarshalIndent(pin, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
