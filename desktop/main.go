package main

import (
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend
var assets embed.FS

//go:embed build/appicon.png
var icon []byte

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Printf("load config: %v", err)
		cfg = DefaultConfig()
		cfg.ServerURL = ""
	}
	app := NewApp(cfg)
	err = wails.Run(&options.App{
		Title:             "Vega",
		Width:             1100,
		Height:            760,
		MinWidth:          800,
		MinHeight:         560,
		Frameless:         true,
		DisableResize:     false,
		BackgroundColour:  &options.RGBA{R: 247, G: 248, B: 250, A: 255},
		StartHidden:       false,
		HideWindowOnClose: false,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:        app.startup,
		OnDomReady:       app.domReady,
		Bind:             []interface{}{app},
		CSSDragProperty:  "--wails-draggable",
		CSSDragValue:     "drag",
		BindingsAllowedOrigins: bindingsOrigins(cfg.ServerURL),
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			Theme:                windows.Light,
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				HideTitleBar:               false,
				FullSizeContent:            true,
				UseToolbar:                 false,
			},
			Appearance:           mac.NSAppearanceNameAqua,
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			About: &mac.AboutInfo{
				Title:   "Vega",
				Message: "Vega desktop chat client",
				Icon:    icon,
			},
		},
		Linux: &linux.Options{
			Icon:             icon,
			ProgramName:      "vega-desktop",
			WebviewGpuPolicy: linux.WebviewGpuPolicyOnDemand,
		},
	})
	if err != nil {
		log.Println("Error:", err.Error())
		os.Exit(1)
	}
}
