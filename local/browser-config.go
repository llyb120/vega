package main

import "fmt"

// browserPlace 归一化浏览器位置：local = 用本机 Chrome 扩展（默认），cloud = 用服务端浏览器。
func browserPlace(value string) string {
	if value == "cloud" {
		return "cloud"
	}
	return "local"
}

// saveBrowserPlace 保存浏览器位置，并通知已连接的站点按新位置给新任务绑定浏览器。
func (a *Agent) saveBrowserPlace(value string) error {
	if value != "local" && value != "cloud" {
		return fmt.Errorf("浏览器位置只有「本机」或「云端」")
	}
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.Browser = value
	if err := a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("浏览器位置未保存：%w", err)
	}
	a.config = next
	runners := make([]*jobRunner, 0, len(a.direct))
	for _, connection := range a.direct {
		runners = append(runners, connection.jobs)
	}
	a.mu.Unlock()
	for _, runner := range runners {
		runner.mu.Lock()
		runner.browser = value
		runner.write(map[string]any{"type": "ping", "browser": runner.browser})
		runner.mu.Unlock()
	}
	return nil
}
