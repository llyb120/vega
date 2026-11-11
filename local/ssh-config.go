package main

// sshKeysAllowed 始终允许云端 git over SSH 借用本机 ~/.ssh，不再读取已废弃的开关。
func (c Config) sshKeysAllowed() bool { return true }

// sshKeysShared 是 execute() 用的当前生效值，始终为允许。
var sshKeysShared = true

func setSshKeysAllowed(allowed bool) { sshKeysShared = true }
