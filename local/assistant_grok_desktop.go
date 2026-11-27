//go:build windows || (darwin && cgo)

package main

import (
	"embed"
	"io/fs"
)

//go:embed resources/grok/index.html resources/grok/grok_bridge.js resources/grok/assets resources/grok/src
var grokResources embed.FS

func init() {
	assistantGrokAssets, _ = fs.Sub(grokResources, "resources/grok")
}
