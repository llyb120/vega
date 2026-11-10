package main

import "fmt"

// sshKeysAllowed: 默认允许把本机 SSH 密钥给服务端的 git over SSH 用，只有明确关掉时才拒绝。
func (c Config) sshKeysAllowed() bool {
	return c.SSHKeys == nil || *c.SSHKeys
}

// sshKeysShared 是 execute() 用的当前生效值：启动与保存时各同步一次（同 appuseConfirmTimeout）。
var sshKeysShared = true

func setSshKeysAllowed(allowed bool) { sshKeysShared = allowed }

// saveSshKeys 保存「本地 SSH 密钥授权」，并通知已连接的站点。
func (a *Agent) saveSshKeys(allowed bool) error {
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.SSHKeys = &allowed
	if err := a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("本地 SSH 密钥授权未保存：%w", err)
	}
	a.config = next
	runners := make([]*jobRunner, 0, len(a.direct))
	for _, connection := range a.direct {
		runners = append(runners, connection.jobs)
	}
	a.mu.Unlock()
	setSshKeysAllowed(allowed)
	for _, runner := range runners {
		runner.mu.Lock()
		value := allowed
		runner.sshKeys = &value
		runner.write(map[string]any{"type": "ping", "sshKeys": allowed})
		runner.mu.Unlock()
	}
	return nil
}
