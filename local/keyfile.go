package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
)

// Private keys from an employee's vault (ssh_key entries): written 0600 under the user's temp directory for one run and
// removed by the server when the run ends; clearKeys removes whatever a crash or kill left behind.
var keyDir = filepath.Join(os.TempDir(), "vega-keys")

type keyReq struct {
	Op      string `json:"op"`
	Path    string `json:"path"`
	Content string `json:"content"`
}

func keyOperation(req keyReq) map[string]any {
	switch req.Op {
	case "ssh":
		return localSshKeys()
	case "write":
		data, err := base64.StdEncoding.DecodeString(req.Content)
		if err != nil || len(data) == 0 || len(data) > 64<<10 {
			return failure("Invalid key content")
		}
		if err = os.MkdirAll(keyDir, 0700); err == nil {
			err = os.Chmod(keyDir, 0700)
		}
		if err != nil {
			return failure(err.Error())
		}
		f, err := os.CreateTemp(keyDir, "key-*")
		if err != nil {
			return failure(err.Error())
		}
		if err = f.Chmod(0600); err == nil {
			_, err = f.Write(data)
		}
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(f.Name())
			return failure(err.Error())
		}
		return map[string]any{"path": f.Name()}
	case "remove":
		path := filepath.Clean(req.Path)
		if filepath.Dir(path) != keyDir || !strings.HasPrefix(filepath.Base(path), "key-") {
			return failure("Not a Vega key file")
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return failure(err.Error())
		}
		return map[string]any{"removed": true}
	}
	return failure("Unknown key operation")
}

// localSshKeys 是服务端 git over SSH 借用本机 ssh 时的取材处：只给 ~/.ssh/config 和私钥（不含 .pub、known_hosts）。
func localSshKeys() map[string]any {
	home, err := os.UserHomeDir()
	if err != nil {
		return failure(err.Error())
	}
	dir := filepath.Join(home, ".ssh")
	names := []string{"config"}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return failure("本机 " + dir + " 里没有可用的 SSH 私钥；请先配好 ssh 密钥，或改用密码本里的 SSH 私钥")
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "id_") || strings.HasSuffix(name, ".pub") {
			continue
		}
		names = append(names, name)
	}
	keys := make([]map[string]string, 0, len(names))
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || len(data) == 0 || len(data) > 64<<10 {
			continue // 带口令的私钥读完也没用，交给 ssh 的 BatchMode 直接失败，不在这里分类
		}
		keys = append(keys, map[string]string{"name": name, "content": base64.StdEncoding.EncodeToString(data)})
		if len(keys) == 8 {
			break
		}
	}
	if len(keys) == 1 && keys[0]["name"] == "config" {
		return failure("本机 " + dir + " 里没有可用的 SSH 私钥；请先配好 ssh 密钥，或改用密码本里的 SSH 私钥")
	}
	return map[string]any{"keys": keys}
}

func clearKeys() { _ = os.RemoveAll(keyDir) }
