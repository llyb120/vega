package main

// 一个站点一份客户端：exe 同目录的 instance.json 说明它属于哪个站点，
// 数据目录也按站点分开，多个站点各自独立、不会互相覆盖配置。

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type instancePin struct {
	Origin       string `json:"origin"`
	DownloadedAt int64  `json:"downloadedAt,omitempty"`
}

const instanceFileName = "instance.json"

var sitePathSegment = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

// A pinned site may have a mount path; a browser Origin header still may not.
func parseSiteBase(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	invalid := fmt.Errorf("站点地址必须是 HTTP(S) 地址，可带目录，不得含凭据、查询参数或片段")
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawPath != "" ||
		(u.Scheme != "http" && u.Scheme != "https") || strings.ContainsAny(raw, "?#\\") {
		return nil, invalid
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	if u.Path != "" {
		for _, segment := range strings.Split(u.Path[1:], "/") {
			if !sitePathSegment.MatchString(segment) || segment == "." || segment == ".." {
				return nil, invalid
			}
		}
	}
	return u, nil
}

func validSiteBase(base string) bool {
	u, err := parseSiteBase(base)
	return err == nil && u.String() == base
}

// readInstancePin 读 exe 同目录的安装包信息（macOS .app 包额外支持 Contents/Resources 与 .app 同级目录）。
// 没有它就不是从站点下载的安装包，直接拒绝启动。
func readInstancePin(exeDir string) (instancePin, error) {
	var pin instancePin
	candidates := []string{filepath.Join(exeDir, instanceFileName)}
	if filepath.Base(exeDir) == "MacOS" {
		contentsDir := filepath.Dir(exeDir)
		appDir := filepath.Dir(contentsDir)
		if filepath.Base(contentsDir) == "Contents" && strings.HasSuffix(strings.ToLower(filepath.Base(appDir)), ".app") {
			candidates = append(candidates,
				filepath.Join(contentsDir, "Resources", instanceFileName),
				filepath.Join(filepath.Dir(appDir), instanceFileName),
			)
		}
	}
	var data []byte
	var err error
	for _, candidate := range candidates {
		data, err = os.ReadFile(candidate)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return pin, err
		}
	}
	if err != nil {
		return pin, fmt.Errorf("缺少站点信息 %s：请回到站点重新下载安装包（ZIP）", instanceFileName)
	}
	if err = json.Unmarshal(data, &pin); err != nil {
		return pin, fmt.Errorf("%s 不是有效的站点信息：%w", instanceFileName, err)
	}
	base, err := parseSiteBase(pin.Origin)
	if err != nil {
		return pin, fmt.Errorf("%s：%w", instanceFileName, err)
	}
	pin.Origin = base.String()
	return pin, nil
}

// siteSlug 站点根路径继续使用旧目录，子目录的配置与凭据单独存放。
func siteSlug(origin string) (string, error) {
	parsed, err := parseSiteBase(origin)
	if err != nil {
		return "", err
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
	if parsed.Path != "" {
		key := sha256.Sum256([]byte(parsed.String()))
		return fmt.Sprintf("%s~%x", cleaned, key[:12]), nil
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

// siteLabel 在托盘展示实际地址，避免同一主机的多个子目录站点看起来一样。
func (a *Agent) siteLabel() string {
	if u, err := parseSiteBase(a.pinnedOrigin); err == nil && u.Path != "" {
		return u.Host + u.Path
	}
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
