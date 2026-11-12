package main

import (
	"context"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx context.Context
	pin instancePin
	err string
}

func NewApp(pin instancePin, err error) *App {
	app := &App{pin: pin}
	if err != nil {
		app.err = err.Error()
	}
	return app
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	runtime.WindowCenter(ctx)
}

func (a *App) domReady(ctx context.Context) {
	runtime.WindowCenter(ctx)
	runtime.WindowExecJS(ctx, shimJS)
	if a.err == "" && a.pin.Origin != "" {
		a.navigate(a.pin.Origin)
	}
}

// StartupError 没有安装包里的站点信息时返回说明，供窗口展示；正常启动为空。
func (a *App) StartupError() string {
	return a.err
}

func (a *App) navigate(serverURL string) {
	escaped := strings.ReplaceAll(serverURL, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	runtime.WindowExecJS(a.ctx, `window.location.replace("`+escaped+`");`)
}
