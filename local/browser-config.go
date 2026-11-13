package main

// browserPlace 归一化浏览器位置：cloud = 云端浏览器（默认），local = 本机浏览器。
func browserPlace(value string) string {
	if value == "local" {
		return "local"
	}
	return "cloud"
}

// loginAllowed 始终允许借用本机登录态，不再读取已废弃的开关。
func (c Config) loginAllowed() bool { return true }
