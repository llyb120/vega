package main

import "fmt"

// browserPlace 归一化浏览器优先：cloud = 用服务端浏览器（默认），local = 用本机 Chrome 扩展。
func browserPlace(value string) string {
	if value == "local" {
		return "local"
	}
	return "cloud"
}

// saveBrowserPlace 保存浏览器优先，并通知已连接的站点按新选择给新任务绑定浏览器。
func (a *Agent) saveBrowserPlace(value string) error {
	if value != "local" && value != "cloud" {
		return fmt.Errorf("浏览器优先只有「本机」或「服务端」")
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
		return fmt.Errorf("浏览器优先未保存：%w", err)
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

// loginAllowed: 本机站点登录态默认可以搬到服务端浏览器，只有明确关掉时才阻止。
func (c Config) loginAllowed() bool {
	return c.LoginState == nil || *c.LoginState
}

// saveLoginState 保存登录态开关，并通知已连接的站点。
func (a *Agent) saveLoginState(allowed bool) error {
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.LoginState = &allowed
	if err := a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("登录态设置未保存：%w", err)
	}
	a.config = next
	runners := make([]*jobRunner, 0, len(a.direct))
	for _, connection := range a.direct {
		runners = append(runners, connection.jobs)
	}
	a.mu.Unlock()
	for _, runner := range runners {
		runner.mu.Lock()
		value := allowed
		runner.loginState = &value
		runner.write(map[string]any{"type": "ping", "loginState": allowed})
		runner.mu.Unlock()
	}
	return nil
}
