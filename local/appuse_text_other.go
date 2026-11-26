//go:build !windows

package main

type appuseBatchClipboard struct{}

func newAppuseBatchClipboard() *appuseBatchClipboard { return &appuseBatchClipboard{} }
func (b *appuseBatchClipboard) waitGrace() error    { return nil }
func (b *appuseBatchClipboard) paste(text string) error {
	return appuseTypeText(text)
}
func (b *appuseBatchClipboard) finish() error { return nil }

// 非 Windows 没有剪贴板延迟渲染通道：走逐字注入（中文输入法差异只在 Windows 上有）。
func appusePasteText(text string) error { return appuseTypeText(text) }

func appuseSetClipboardText(string) error { return nil }

func appuseClipboardText() (string, bool) { return "", false }
