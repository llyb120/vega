package main

import (
	"fmt"
	"time"
)

// offlineHandoffGrace 下线后等站点断开的上限。
// shortcut: 交接完由站点关连接，十分钟还没断就自己断；服务端交接再长就要改成按站点确认消息断开。
const offlineHandoffGrace = 10 * time.Minute

// executionPlace 归一化执行位置偏好：client = 客户端优先（默认），cloud = 服务端优先。
func executionPlace(value string) string {
	if value == "cloud" {
		return "cloud"
	}
	return "client"
}

// saveExecutionPlace 保存执行位置，并通知已连接的站点按新位置绑定新任务；切到服务端优先后由服务端接力。
func (a *Agent) saveExecutionPlace(value string) error {
	if value != "client" && value != "cloud" {
		return fmt.Errorf("执行位置只有「客户端优先」或「服务端优先」")
	}
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.Prefer = value
	if err := a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("执行位置未保存：%w", err)
	}
	a.config = next
	runners := make([]*jobRunner, 0, len(a.direct))
	for _, connection := range a.direct {
		runners = append(runners, connection.jobs)
	}
	a.mu.Unlock()
	for _, runner := range runners {
		runner.mu.Lock()
		runner.prefer = value
		runner.write(map[string]any{"type": "ping", "prefer": runner.prefer})
		runner.mu.Unlock()
	}
	return nil
}

// setOnline 手动上下线。下线是软交接：告诉站点主动下线，站点趁连接还在把变动与登录态同步过去，
// 交接完自己断开，本机这期间不再重连；连接已经不在时没有可交接的内容，服务端按还原点硬交接。
// 上线时重新连接。
func (a *Agent) setOnline(online bool) error {
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.Offline = !online
	if err := a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("接单状态未保存：%w", err)
	}
	a.config = next
	servers := append([]ServerCredential{}, a.config.Servers...)
	connections := make([]*directConnection, 0, len(a.direct))
	for _, connection := range a.direct {
		connections = append(connections, connection)
	}
	a.mu.Unlock()
	setTrayOffline(!online)
	if !online {
		for _, connection := range connections {
			connection.jobs.mu.Lock()
			connection.jobs.write(map[string]any{"type": "offline"})
			connection.jobs.mu.Unlock()
			// 紧接着 cancel 会让站点来不及读工作区和登录态：等站点交接完断开，等不到再自己断。
			time.AfterFunc(offlineHandoffGrace, func() {
				a.mu.Lock()
				stillOffline := a.config.Offline
				a.mu.Unlock()
				if stillOffline {
					connection.cancel()
				}
			})
		}
		return nil
	}
	for _, saved := range servers {
		if token, err := unprotectToken(saved.Token); err == nil {
			a.startConnection(saved, token)
		}
	}
	return nil
}
