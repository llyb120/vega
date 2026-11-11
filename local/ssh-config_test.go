package main

import (
	"encoding/base64"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本地 SSH 密钥授权默认打开：关掉后密钥不出本机（op 直接拒绝），打开时交出 ~/.ssh 的 config 与私钥。
func TestSshKeyAuthorizationAlwaysAllows(t *testing.T) {
	setSshKeysAllowed(true)
	off := false
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32), SSHKeys: &off}, direct: map[string]*directConnection{}}
	if err := agent.saveConfig(agent.config); err != nil {
		t.Fatal(err)
	}
	if !agent.config.sshKeysAllowed() || !sshKeysShared {
		t.Fatal("旧的关闭配置也必须视为允许")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"config": "Host work\n  User git\n", "id_ed25519": "PRIVATE\n", "id_ed25519.pub": "ssh-ed25519 AAAA\n"} {
		if err := os.WriteFile(filepath.Join(sshDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r := keyOperation(keyReq{Op: "ssh"})
	keys, _ := r["keys"].([]map[string]string)
	if r["error"] != nil || len(keys) != 2 {
		t.Fatalf("应交出 config 与私钥（不含 .pub）：%+v", r)
	}
	got := map[string]string{}
	for _, key := range keys {
		raw, _ := base64.StdEncoding.DecodeString(key["content"])
		got[key["name"]] = string(raw)
	}
	if got["config"] != "Host work\n  User git\n" || got["id_ed25519"] != "PRIVATE\n" || got["id_ed25519.pub"] != "" {
		t.Fatalf("交出的内容不对：%v", got)
	}
	w := httptest.NewRecorder()
	agent.configure(w, httptest.NewRequest("GET", "http://"+localAddress+"/config/test?tab=access", nil))
	page := w.Body.String()
	if strings.Contains(page, `name="sshKeys"`) || strings.Contains(page, "本地 SSH 密钥授权") {
		t.Fatal("设置页不应再显示 SSH 密钥开关")
	}
	setSshKeysAllowed(true)
}

func TestSshKeyAuthorizationWithoutKeysFails(t *testing.T) {
	setSshKeysAllowed(true)
	defer setSshKeysAllowed(true)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if r := keyOperation(keyReq{Op: "ssh"}); r["error"] == nil || !strings.Contains(r["error"].(string), "没有可用") {
		t.Fatalf("没有 ~/.ssh 时应失败：%+v", r)
	}
}
