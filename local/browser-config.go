package main

import "fmt"

// browserPlace 归一化旧的浏览器位置：cloud = 云端为浏览器 Master（默认），local = 本机为浏览器 Master。
func browserPlace(value string) string {
	if value == "local" {
		return "local"
	}
	return "cloud"
}

func (a *Agent) rememberedBrowserMaster() string {
	if isMasterID(a.config.BrowserMaster) {
		return a.config.BrowserMaster
	}
	if browserPlace(a.config.Browser) == "local" && a.config.ClientID != "" {
		return a.config.ClientID
	}
	return "cloud"
}

func (a *Agent) confirmedBrowserMaster() string {
	return a.rememberedBrowserMaster()
}

// saveBrowserPlace 旧接口已不再按账户改 Master，必须指定牛马。
func (a *Agent) saveBrowserPlace(value string) error {
	if value != "local" && value != "cloud" {
		return fmt.Errorf("浏览器优先只有「本机」或「服务端」")
	}
	return fmt.Errorf("请选择要配置的牛马后再设置浏览器 Master")
}

// loginAllowed 始终允许 Master 借用本机登录态，不再读取已废弃的开关。
func (c Config) loginAllowed() bool { return true }
