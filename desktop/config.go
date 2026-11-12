package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const defaultServerURL = "http://127.0.0.1:8080"

type Config struct {
	ServerURL string `json:"serverUrl"`
}

func DefaultConfig() Config {
	return Config{ServerURL: defaultServerURL}
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "vega-desktop", "config.json"), nil
}

func LoadConfig() (Config, error) {
	cfg := DefaultConfig()
	path, err := configPath()
	if err != nil {
		return cfg, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg.ServerURL = ""
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return DefaultConfig(), err
	}
	if cfg.ServerURL != "" {
		normalized, err := NormalizeServerURL(cfg.ServerURL)
		if err == nil {
			cfg.ServerURL = normalized
		}
	}
	return cfg, nil
}

func SaveConfig(cfg Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// NormalizeServerURL accepts a user-typed address and returns an http(s) origin
// with no trailing slash (for example http://127.0.0.1:8080).
func NormalizeServerURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("请填写服务器地址")
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("服务器地址无效")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("只支持 http 或 https 地址")
	}
	if parsed.Host == "" || parsed.User != nil {
		return "", fmt.Errorf("服务器地址无效")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("请填写网站根地址，不要带路径")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("请填写网站根地址，不要带参数")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func OriginOf(serverURL string) (string, error) {
	normalized, err := NormalizeServerURL(serverURL)
	if err != nil {
		return "", err
	}
	return normalized, nil
}

func bindingsOrigins(serverURL string) string {
	origins := []string{
		"http://127.0.0.1:*",
		"http://localhost:*",
		"http://[::1]:*",
		"https://127.0.0.1:*",
		"https://localhost:*",
		"https://[::1]:*",
	}
	if origin, err := OriginOf(serverURL); err == nil && origin != "" {
		origins = append([]string{origin}, origins...)
	}
	return strings.Join(origins, ",")
}
