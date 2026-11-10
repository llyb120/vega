package main

import "fmt"

// saveButterfly 保存是否显示蝴蝶（任务栏蝴蝶与提示气泡），并立即生效。
// 关掉后托盘菜单「蝴蝶助理」仍在，需要时还能手动打开面板。
func (a *Agent) saveButterfly(on bool) error {
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.Butterfly = on
	err := a.saveConfig(next)
	if err == nil {
		a.config = next
	}
	a.mu.Unlock()
	if err != nil {
		return fmt.Errorf("蝴蝶设置未保存：%w", err)
	}
	butterflySetEnabled(on)
	return nil
}
