package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Config struct {
	ClientID       string             `json:"clientId"`
	Supplement     string             `json:"supplement,omitempty"`
	TrustedOrigins []string           `json:"trustedOrigins"`
	Servers        []ServerCredential `json:"servers,omitempty"`
}

func newAgent() (*Agent, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	token := make([]byte, 24)
	if _, err = rand.Read(token); err != nil {
		return nil, err
	}
	a := &Agent{configPath: filepath.Join(dir, "vega-local", "trusted-sites.json"), configToken: hex.EncodeToString(token), connections: make(map[*websocket.Conn]struct{}), pendingOrigins: make(map[string]bool)}
	data, err := os.ReadFile(a.configPath)
	if err == nil {
		err = json.Unmarshal(data, &a.config)
	}
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err = validateSupplement(a.config.Supplement); err != nil {
		return nil, err
	}
	for i, saved := range a.config.Servers {
		rules, ruleErr := relayRules(strings.Join(saved.Relay, "\n"))
		if ruleErr != nil {
			return nil, ruleErr
		}
		a.config.Servers[i].Relay = rules
	}
	if a.config.ClientID == "" {
		id := make([]byte, 16)
		if _, err = rand.Read(id); err != nil {
			return nil, err
		}
		a.config.ClientID = hex.EncodeToString(id)
		data, err = json.Marshal(a.config)
		if err == nil {
			err = os.MkdirAll(filepath.Dir(a.configPath), 0700)
		}
		if err == nil {
			err = os.WriteFile(a.configPath, data, 0600)
		}
		if err != nil {
			return nil, err
		}
	}
	decoded, err := hex.DecodeString(a.config.ClientID)
	if err != nil || len(decoded) != 16 {
		return nil, fmt.Errorf("Invalid client ID in local config")
	}
	return a, nil
}
func (a *Agent) saveConfig(config Config) error {
	data, err := json.Marshal(config)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(a.configPath), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(a.configPath), ".trusted-sites-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), a.configPath)
}
func validOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http"
}
func (a *Agent) allowOrigin(origin string) bool {
	if !validOrigin(origin) {
		return false
	}
	a.mu.Lock()
	for _, trusted := range a.config.TrustedOrigins {
		if trusted == origin {
			a.mu.Unlock()
			return true
		}
	}
	show := !a.pendingOrigins[origin] && len(a.pendingOrigins) < 8
	if show {
		a.pendingOrigins[origin] = true
	}
	a.mu.Unlock()
	if show {
		openBrowser("http://" + localAddress + "/config/" + a.configToken)
	}
	return false
}

var pairingPage = template.Must(template.New("pairing").Parse(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>牵牛星 本机连接授权</title><style>
body{font:16px system-ui;background:#f5f6fa;color:#202431;margin:0;padding:24px}main{max-width:680px;margin:auto;background:white;padding:28px;border-radius:16px}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#5147dd;color:white;cursor:pointer}button:focus-visible,textarea:focus-visible{outline:3px solid #292177;outline-offset:3px}code{overflow-wrap:anywhere}form{padding:16px 0;border-top:1px solid #ddd}p{line-height:1.7}textarea{box-sizing:border-box;width:100%;font:14px monospace;padding:12px;margin:10px 0;border:1px solid #888;border-radius:8px}small{display:block;line-height:1.6;color:#555}
</style><main><h1>牵牛星 本机连接授权</h1>
<p>只允许你信任的 Vega 站点。允许后，该站点登录的账号可在本机读写文件、执行命令。无需配置 Key。</p>
{{if .Approved}}<p role="status"><strong>站点权限已保存。</strong>请回到 Vega 网站查看登录验证和后端连接结果；允许站点不代表后端已经连通。HTTP 站点也可连接，但凭据和命令会明文传输，存在被窃听或篡改的风险。</p>{{end}}
{{if .Revoked}}<p role="status">站点授权已撤销。若 Vega 网站仍开着，新的连接检测会再次申请授权；关闭网站可停止申请。</p>{{end}}
{{if .Saved}}<p role="status">本地配置已保存，将同步到已连接的后端；离线时请等待客户端重新连接。</p>{{end}}
{{if .Unpaired}}<p role="status">指定账户的本地配对已移除，其他账户和站点授权不变。若该账户仍在 Vega 网页中登录，网页可能再次发起配对。</p>{{end}}
{{range .Pending}}<form method="post"><p>请求连接的站点：<br><strong><code>{{.}}</code></strong></p><button name="origin" value="{{.}}">允许此站点</button></form>{{else}}<p>当前没有新的连接请求。请保持客户端运行，并登录 Vega 网站。</p>{{end}}
{{if .Trusted}}<h2>已信任站点</h2>{{range .Trusted}}<form method="post"><code>{{.}}</code> <button name="remove" value="{{.}}">撤销授权</button></form>{{end}}{{end}}
<h2>补充内容</h2><form method="post"><label for="supplement">本机项目目录等辅助提示</label>
<small id="supplement-help">最多 8192 UTF-8 字节。同步到此客户端授权的站点，仅供绑定本机的会话参考。不要填写密码或密钥；清空后保存可移除。</small>
<textarea id="supplement" name="supplement" rows="6" aria-describedby="supplement-help">{{.Supplement}}</textarea><button name="saveSupplement" value="1">保存补充内容</button></form>
<h2>流量中继</h2><p>按配对账户授权内网域名，该账户的服务端牛马浏览器自动使用本机网络，不改变任务执行位置。</p>
<small>每行填写一个精确域名或域名:端口，省略端口表示 80 和 443，最多 64 条域名端口规则。不支持通配符、IP、localhost 或 URL；留空保存关闭该账户的中继。请使用 HTTPS 站点保护隧道。网站内容会进入服务端浏览器，登录态不会从本机复制。</small>
{{range .Accounts}}<form method="post"><p>所属服务器地址：<strong><code>{{.Origin}}</code></strong><br>账户 ID：<code>{{.UserID}}</code><br>连接状态：{{.Status}}</p>
<input type="hidden" name="relayOrigin" value="{{.Origin}}"><input type="hidden" name="relayUser" value="{{.UserID}}">
<label>允许中继的域名和端口<textarea name="relayRules" rows="5" placeholder="git.company.internal&#10;dev.company.internal:8080">{{.Rules}}</textarea></label>
<small>命中域名但客户端离线、端口未授权或多个客户端配置冲突时拒绝连接，不回退公网。保存规则会断开受影响账户的现有浏览器网络连接，不自动重放请求。</small>
<button name="saveRelay" value="1">保存此账户的中继配置</button>
<details><summary>移除此账户配对</summary><p>仅移除服务器 <code>{{.Origin}}</code> 下账户 <code>{{.UserID}}</code> 的本地配对和中继配置，并断开其连接；不会删除服务端账户，不影响其他配对或站点授权。</p><small>移除后，该账户已配置的服务端中继域名仍会拒绝直连；若只是关闭中继，请改用清空规则后保存。网页仍登录此账户时可能再次配对。</small><button name="removeAccount" value="1" aria-label="确认移除 {{.Origin}} 下账户 {{.UserID}} 的配对">确认移除此账户配对</button></details></form>{{else}}<p>尚无配对账户。允许站点后，请回到 Vega 完成连接。</p>{{end}}
</main></html>`))

func (a *Agent) configure(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
	// Preserve the local Origin on form POSTs instead of turning it into "null".
	w.Header().Set("Referrer-Policy", "same-origin")
	if r.Host != localAddress {
		http.Error(w, "Invalid host", 403)
		return
	}
	if r.Method == http.MethodPost {
		if r.Header.Get("Origin") != "http://"+localAddress {
			http.Error(w, "Invalid origin", 403)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if r.ParseForm() != nil {
			http.Error(w, "Invalid form", 400)
			return
		}
		if r.FormValue("saveSupplement") == "1" || r.FormValue("saveRelay") == "1" {
			var err error
			if r.FormValue("saveSupplement") == "1" {
				err = a.editSupplement(func(string) (string, bool, error) { return r.FormValue("supplement"), true, nil })
			} else {
				err = a.saveRelay(r.FormValue("relayOrigin"), r.FormValue("relayUser"), r.FormValue("relayRules"))
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Redirect(w, r, r.URL.Path+"?saved=1", http.StatusSeeOther)
			return
		}
		origin, remove := r.FormValue("origin"), r.FormValue("remove")
		unpair := r.FormValue("removeAccount") == "1"
		accountOrigin, accountUser := r.FormValue("relayOrigin"), r.FormValue("relayUser")
		a.mu.Lock()
		next := a.config
		next.TrustedOrigins = append([]string{}, a.config.TrustedOrigins...)
		if unpair {
			if a.updating {
				a.mu.Unlock()
				http.Error(w, "客户端正在更新，请稍后再试", http.StatusServiceUnavailable)
				return
			}
			next.Servers = nil
			found := false
			for _, saved := range a.config.Servers {
				if saved.Origin == accountOrigin && saved.UserID == accountUser {
					found = true
				} else {
					next.Servers = append(next.Servers, saved)
				}
			}
			if !found {
				a.mu.Unlock()
				http.Error(w, "Unknown paired account", http.StatusBadRequest)
				return
			}
		} else if origin != "" && a.pendingOrigins[origin] {
			next.TrustedOrigins = append(next.TrustedOrigins, origin)
		} else if remove != "" {
			next.TrustedOrigins = nil
			for _, item := range a.config.TrustedOrigins {
				if item != remove {
					next.TrustedOrigins = append(next.TrustedOrigins, item)
				}
			}
			next.Servers = nil
			for _, saved := range a.config.Servers {
				if saved.Origin != remove {
					next.Servers = append(next.Servers, saved)
				}
			}
		} else {
			a.mu.Unlock()
			http.Error(w, "Unknown site", 400)
			return
		}
		err := a.saveConfig(next)
		if err != nil {
			a.mu.Unlock()
			http.Error(w, "Unable to save connection settings", 500)
			return
		}
		a.config = next
		if unpair {
			key := accountOrigin + "\x00" + accountUser
			if connection := a.direct[key]; connection != nil {
				connection.cancel()
				delete(a.direct, key)
			}
		} else {
			delete(a.pendingOrigins, origin)
			if remove != "" {
				for _, connection := range a.direct {
					if connection.origin == remove {
						connection.cancel()
					}
				}
			}
		}
		a.mu.Unlock()
		result := "approved"
		if unpair {
			result = "unpaired"
		} else if remove != "" {
			result = "revoked"
		}
		http.Redirect(w, r, r.URL.Path+"?"+result+"=1", http.StatusSeeOther)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET or POST required", 405)
		return
	}
	a.mu.Lock()
	pending := []string{}
	for origin := range a.pendingOrigins {
		pending = append(pending, origin)
	}
	trusted := append([]string{}, a.config.TrustedOrigins...)
	type account struct{ Origin, UserID, Rules, Status string }
	accounts := []account{}
	for _, saved := range a.config.Servers {
		status := "未连接"
		if connection := a.direct[saved.Origin+"\x00"+saved.UserID]; connection != nil {
			status = connection.status.Code
			if status == "connected" {
				status = "已连接"
			}
		}
		accounts = append(accounts, account{saved.Origin, saved.UserID, strings.Join(saved.Relay, "\n"), status})
	}
	supplement := a.config.Supplement
	a.mu.Unlock()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pairingPage.Execute(w, struct {
		Pending, Trusted                   []string
		Approved, Revoked, Saved, Unpaired bool
		Supplement                         string
		Accounts                           []account
	}{pending, trusted, r.URL.Query().Get("approved") == "1", r.URL.Query().Get("revoked") == "1", r.URL.Query().Get("saved") == "1", r.URL.Query().Get("unpaired") == "1", supplement, accounts})
}

type loginProof struct {
	UserID      string `json:"userId"`
	Instance    string `json:"instance"`
	ClientID    string `json:"clientId"`
	DeviceToken string `json:"deviceToken"`
}

type pairingError struct{ connectionStatus }

func (err *pairingError) Error() string { return err.Code }

func verifyLogin(origin, ticket, clientID, deviceToken string) (loginProof, error) {
	var proof loginProof
	if !validOrigin(origin) {
		return proof, &pairingError{connectionStatus{Code: "login_invalid"}}
	}
	if len(ticket) != 72 {
		return proof, &pairingError{connectionStatus{Code: "login_invalid"}}
	}
	data, _ := json.Marshal(map[string]string{"ticket": ticket, "clientId": clientID, "deviceToken": deviceToken})
	req, err := http.NewRequest(http.MethodPost, origin+"/api/local-agent/verify", bytes.NewReader(data))
	if err != nil {
		return proof, &pairingError{connectionStatus{Code: "login_invalid"}}
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return proof, &pairingError{connectionStatus{Code: "login_network"}}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return proof, &pairingError{connectionStatus{Code: "login_http", HTTPStatus: response.StatusCode}}
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&proof)
	if err != nil || proof.UserID == "" || len(proof.Instance) < 32 || proof.ClientID != clientID || len(proof.DeviceToken) != 43 {
		return loginProof{}, &pairingError{connectionStatus{Code: "login_invalid"}}
	}
	return proof, nil
}
func openBrowser(address string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", address)
	case "darwin":
		cmd = exec.Command("open", address)
	default:
		cmd = exec.Command("xdg-open", address)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "vega-local: open local connection permissions at "+address)
	} else {
		go cmd.Wait()
	}
}
