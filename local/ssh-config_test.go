package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本地 SSH 密钥授权默认打开：关掉后密钥不出本机（op 直接拒绝），打开时交出 ~/.ssh 的 config 与私钥。
func TestSshKeyAuthorizationDefaultsOnAndPersists(t *testing.T) {
	setSshKeysAllowed(true)
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), config: Config{ClientID: strings.Repeat("a", 32)}, direct: map[string]*directConnection{}}
	if err := agent.saveConfig(agent.config); err != nil {
		t.Fatal(err)
	}
	if !agent.config.sshKeysAllowed() || !sshKeysShared {
		t.Fatal("没设置过时应允许借给服务端的 git over SSH")
	}
	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://"+localAddress+"/config/test", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://"+localAddress)
		w := httptest.NewRecorder()
		agent.configure(w, r)
		return w
	}
	if w := post(url.Values{"saveSSH": {"1"}}); w.Code != 303 || agent.config.sshKeysAllowed() || sshKeysShared || w.Header().Get("Location") != "/config/test?saved=1&tab=access" {
		t.Fatalf("不勾选必须关掉授权：%d", w.Code)
	}
	if r := keyOperation(keyReq{Op: "ssh"}); r["error"] == nil {
		t.Fatal("关掉授权后不该把本机密钥交出去")
	}
	data, err := os.ReadFile(agent.configPath)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.sshKeysAllowed() {
		t.Fatalf("授权开关没落盘：%v", err)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir 在 Windows 读 USERPROFILE
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"config": "Host work\n  User git\n", "id_ed25519": "PRIVATE\n", "id_ed25519.pub": "ssh-ed25519 AAAA\n"} {
		if err := os.WriteFile(filepath.Join(sshDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if w := post(url.Values{"saveSSH": {"1"}, "sshKeys": {"1"}}); w.Code != 303 || !agent.config.sshKeysAllowed() || !sshKeysShared {
		t.Fatalf("勾选必须重新允许：%d", w.Code)
	}
	r := keyOperation(keyReq{Op: "ssh"})
	keys, _ := r["keys"].([]map[string]string)
	if r["error"] != nil || len(keys) != 2 {
		t.Fatalf("打开后应交出 config 与私钥（不含 .pub）：%+v", r)
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
	if !strings.Contains(page, `name="sshKeys" value="1" checked`) || !strings.Contains(page, `id="panel-access"`) {
		t.Fatal("设置页应在「授权」里显示已打开的 SSH 密钥开关")
	}
	setSshKeysAllowed(true)
}

// 没装 ssh 密钥时明确报错，不把空目录当成功。
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
