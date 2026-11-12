package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	goruntime "runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx    context.Context
	cfg    Config
	origin string
}

func NewApp(cfg Config) *App {
	return &App{cfg: cfg}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	runtime.EventsOn(ctx, "vega:desktop-settings", func(_ ...interface{}) {
		a.OpenSettings()
	})
	runtime.WindowCenter(ctx)
}

func (a *App) domReady(ctx context.Context) {
	runtime.WindowCenter(ctx)
	runtime.WindowExecJS(ctx, shimJS)
}

func (a *App) GetConfig() Config {
	return a.cfg
}

func (a *App) Connect(raw string) error {
	normalized, err := NormalizeServerURL(raw)
	if err != nil {
		return err
	}
	previous := a.cfg.ServerURL
	a.cfg.ServerURL = normalized
	if err := SaveConfig(a.cfg); err != nil {
		return fmt.Errorf("无法保存服务器地址：%w", err)
	}
	if previous != "" && originChanged(previous, normalized) {
		return a.relaunch()
	}
	a.navigate(normalized)
	return nil
}

func (a *App) ConnectExisting() error {
	if a.cfg.ServerURL == "" {
		return fmt.Errorf("还没有配置服务器地址")
	}
	a.navigate(a.cfg.ServerURL)
	return nil
}

func (a *App) OpenSettings() {
	runtime.WindowExecJS(a.ctx, fmt.Sprintf("window.location.href = %q;", settingsPageURL()))
}

func (a *App) navigate(serverURL string) {
	escaped := strings.ReplaceAll(serverURL, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	runtime.WindowExecJS(a.ctx, `window.location.replace("`+escaped+`");`)
}

func settingsPageURL() string {
	if goruntime.GOOS == "windows" {
		return "http://wails.localhost/?settings=1"
	}
	return "wails://wails/?settings=1"
}

func originChanged(previous, next string) bool {
	prev, err1 := OriginOf(previous)
	curr, err2 := OriginOf(next)
	if err1 != nil || err2 != nil {
		return true
	}
	return prev != curr
}

func (a *App) relaunch() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("无法重启桌面客户端：%w", err)
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法重启桌面客户端：%w", err)
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		if a.ctx != nil {
			runtime.Quit(a.ctx)
		} else {
			os.Exit(0)
		}
	}()
	return nil
}
