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
	Browser        string             `json:"browser,omitempty"` // local = 本机浏览器（默认），cloud = 服务端浏览器
	Prefer         string             `json:"prefer,omitempty"`  // client = 客户端优先（默认），cloud = 服务端优先
	Offline        bool               `json:"offline,omitempty"` // 手动下线：不连站点、不接任务
	TrustedOrigins []string           `json:"trustedOrigins"`
	Servers        []ServerCredential `json:"servers,omitempty"`
}

// pinnedOrigin 是安装包自带的站点（只允许连它）；dataDir 是它自己的数据目录。

func newAgent() (*Agent, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return newAgentAt(filepath.Dir(executable))
}

// newAgentAt 以安装目录里的 instance.json 为准：它决定数据目录和唯一允许的站点。
func newAgentAt(exeDir string) (*Agent, error) {
	pin, err := readInstancePin(exeDir)
	if err != nil {
		return nil, err
	}
	dir, err := siteDataDir(pin.Origin)
	if err != nil {
		return nil, err
	}
	if err = ensureInstanceFile(dir, pin); err != nil {
		return nil, err
	}
	token := make([]byte, 24)
	if _, err = rand.Read(token); err != nil {
		return nil, err
	}
	a := &Agent{configPath: filepath.Join(dir, "trusted-sites.json"), dataDir: dir, pinnedOrigin: pin.Origin, configToken: hex.EncodeToString(token), connections: make(map[*websocket.Conn]struct{}), pendingOrigins: make(map[string]bool)}
	data, err := os.ReadFile(a.configPath)
	if err == nil {
		err = json.Unmarshal(data, &a.config)
	}
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	// 只认安装包里的站点，其它来源不参与白名单。
	a.config.TrustedOrigins = []string{a.pinnedOrigin}
	kept := a.config.Servers[:0]
	for _, saved := range a.config.Servers {
		if saved.Origin == a.pinnedOrigin {
			kept = append(kept, saved)
		}
	}
	a.config.Servers = kept
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

// allowOrigin 只放行安装包自带的站点；其它站点一律拒绝，也不弹窗请求授权。
func (a *Agent) allowOrigin(origin string) bool {
	if !validOrigin(origin) {
		return false
	}
	if origin != a.pinnedOrigin {
		fmt.Fprintf(os.Stderr, "vega-local: 拒绝站点 %s：此客户端只属于 %s\n", origin, a.pinnedOrigin)
		return false
	}
	return true
}

var pairingPage = template.Must(template.New("pairing").Parse(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>牵牛星 · 本机连接</title><style>
:root{--bg:#eef0f7;--card:#fff;--ink:#1b1f2a;--muted:#5b6475;--line:#e3e6ef;--brand:#5147dd;--brand-ink:#fff;--ok:#0f7b4a;--ok-bg:#e8f7ef;--warn:#8a5a00;--warn-bg:#fff6e5;--danger:#b42318;--shadow:0 12px 40px rgba(33,37,71,.08)}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(1200px 600px at 10% -10%,#dfe5ff 0%,transparent 55%),radial-gradient(900px 500px at 100% 0%,#f3e9ff 0%,transparent 50%),var(--bg)}
main{max-width:720px;margin:28px auto;padding:0 16px 48px}
.hero{display:flex;gap:16px;align-items:center;margin-bottom:18px}
.badge{width:48px;height:48px;border-radius:14px;background:linear-gradient(145deg,#6a62f0,#5147dd);box-shadow:0 8px 20px rgba(81,71,221,.35);flex:none}
.hero h1{margin:0;font-size:1.45rem;letter-spacing:-.02em}.hero p{margin:4px 0 0;color:var(--muted);font-size:.95rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px 22px 18px;box-shadow:var(--shadow);margin-bottom:16px}
.card h2{margin:0 0 10px;font-size:1.05rem}
.flash{border-radius:12px;padding:12px 14px;margin:0 0 14px}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.warn{background:var(--warn-bg);color:var(--warn)}
p{margin:0 0 12px}small{display:block;color:var(--muted);line-height:1.55;margin:0 0 10px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f3f4fa;padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:8px 0 6px}
textarea{width:100%;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 14px;border:1px solid #c9cee0;border-radius:12px;background:#fbfbfe;resize:vertical;min-height:96px}
textarea:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #292177;outline-offset:2px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px}
button{font:inherit;padding:10px 16px;border:0;border-radius:10px;background:var(--brand);color:var(--brand-ink);cursor:pointer;font-weight:600}
button.secondary{background:#eef0f8;color:var(--ink)}button.danger{background:#fff1f0;color:var(--danger)}
.site{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}.site:first-child{border-top:0;padding-top:0}
.status{display:inline-flex;align-items:center;gap:6px;font-size:.85rem;font-weight:600;padding:4px 10px;border-radius:999px;background:#eef0f8;color:var(--muted)}
.status.on{background:#e8f0ff;color:var(--brand)}.status.on::before,.status::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.account{border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0;background:#fafbff}
.switch{display:flex;align-items:center;gap:10px;font-weight:600;margin:8px 0 12px;cursor:pointer;user-select:none}
.switch input{appearance:none;width:44px;height:26px;border-radius:999px;background:#cfd5e6;position:relative;transition:.2s;flex:none;cursor:pointer}
.switch input::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2);transition:.2s}
.switch input:checked{background:var(--brand)}.switch input:checked::after{left:21px}
details{margin-top:12px}details summary{cursor:pointer;color:var(--muted);font-weight:600}
.empty{color:var(--muted);margin:0}
</style>
<main>
  <div class="hero"><div class="badge" aria-hidden="true"></div><div><h1>牵牛星 · 本机连接</h1><p>本客户端来自 <code>{{.Pin}}</code>，只能连接该站点；该站点登录的账号可在本机读写文件、执行命令。</p></div></div>

  {{if .Approved}}<div class="flash ok" role="status"><strong>站点权限已保存。</strong>请回到 Vega 查看登录验证与后端连接结果；允许站点不代表后端已经连通。HTTP 站点也可连接，但凭据和命令会明文传输。</div>{{end}}
  {{if .Revoked}}<div class="flash warn" role="status">站点授权已撤销。若 Vega 网站仍开着，新的连接检测会再次申请授权；关闭网站可停止申请。</div>{{end}}
  {{if .Saved}}<div class="flash ok" role="status">本地配置已保存，将同步到已连接的后端；离线时请等待客户端重新连接。</div>{{end}}
  {{if .Unpaired}}<div class="flash warn" role="status">指定账户的本地配对已移除，其他账户和站点授权不变。若该账户仍在 Vega 网页中登录，网页可能再次发起配对。</div>{{end}}

  <section class="card">
    <h2>连接请求</h2>
    {{range .Pending}}
    <form method="post" class="site"><div>请求连接的站点<br><strong><code>{{.}}</code></strong></div><button name="origin" value="{{.}}">允许此站点</button></form>
    {{else}}<p class="empty">当前没有新的连接请求。请保持客户端运行，并登录 Vega 网站。</p>{{end}}
  </section>

  {{if .Trusted}}
  <section class="card">
    <h2>已信任站点</h2>
    {{range .Trusted}}
    <form method="post" class="site"><code>{{.}}</code><button class="secondary" name="remove" value="{{.}}">撤销授权</button></form>
    {{end}}
  </section>
  {{end}}

  <section class="card">
    <h2>浏览器位置</h2>
    <form method="post">
      <label class="switch"><input type="checkbox" name="browserLocal" value="1"{{if .BrowserLocal}} checked{{end}}>在本机执行时用本机浏览器</label>
      <small>默认用本机 Chrome（需装 Nova Chrome 扩展）。取消后改用服务端浏览器，访问本机内网服务靠下方流量中继；新任务生效，已有任务不变。</small>
      <div class="row"><button name="saveBrowser" value="1">保存浏览器位置</button></div>
    </form>
  </section>

  <section class="card">
    <h2>执行位置</h2>
    <form method="post">
      <label class="switch"><input type="checkbox" name="executionClient" value="1"{{if not .ExecutionCloud}} checked{{end}}>客户端优先：任务在本机执行</label>
      <small>默认客户端优先。取消后改为服务端优先：新任务在云端执行，本机正在跑的任务会自动接力到云端继续，本机文件通过接力同步。</small>
      <div class="row"><button name="saveExecution" value="1">保存执行位置</button></div>
    </form>
  </section>

  <section class="card">
    <h2>接单状态</h2>
    <p>{{if .Offline}}当前<b>已下线</b>：不连接站点、不接任务；已在跑的任务由服务端接续。{{else}}当前<b>在线</b>：可以接任务。{{end}}</p>
    <form method="post">
      <div class="row">
        {{if .Offline}}<button name="setOnline" value="1">上线（恢复接单）</button>{{else}}<button name="setOffline" value="1">下线（暂停接单）</button>{{end}}
      </div>
    </form>
  </section>

  <section class="card">
    <h2>补充内容</h2>
    <form method="post">
      <label for="supplement">本机项目目录等辅助提示</label>
      <small id="supplement-help">最多 8192 UTF-8 字节。同步到此客户端授权的站点，仅供绑定本机的会话参考。不要填写密码或密钥；清空后保存可移除。</small>
      <textarea id="supplement" name="supplement" rows="6" aria-describedby="supplement-help">{{.Supplement}}</textarea>
      <div class="row"><button name="saveSupplement" value="1">保存补充内容</button></div>
    </form>
  </section>

  <section class="card">
    <h2>流量中继</h2>
    <p>按配对账户授权内网域名，该账户的服务端牛马浏览器自动使用本机网络，不改变任务执行位置。</p>
    <small>每行填写一个精确域名或域名:端口，省略端口表示 80 和 443，最多 64 条。不支持通配符、IP、localhost 或 URL。关闭开关可保留规则但停止中继。请使用 HTTPS 站点保护隧道。</small>
    {{range .Accounts}}
    <form method="post" class="account">
      <p>所属服务器地址：<strong><code>{{.Origin}}</code></strong><br>账户 ID：<code>{{.UserID}}</code><br>
        <span class="status{{if eq .Status "已连接"}} on{{end}}">{{.Status}}</span>
      </p>
      <input type="hidden" name="relayOrigin" value="{{.Origin}}">
      <input type="hidden" name="relayUser" value="{{.UserID}}">
      <label class="switch"><input type="checkbox" name="relayOn" value="1"{{if .Enabled}} checked{{end}}>启用流量中继</label>
      <label>允许中继的域名和端口<textarea name="relayRules" rows="5" placeholder="git.company.internal&#10;dev.company.internal:8080">{{.Rules}}</textarea></label>
      <small>命中域名但客户端离线、端口未授权或多个客户端配置冲突时拒绝连接，不回退公网。保存会断开受影响账户的现有浏览器网络连接，不自动重放请求。</small>
      <div class="row"><button name="saveRelay" value="1">保存此账户的中继配置</button></div>
      <details><summary>移除此账户配对</summary>
        <p>仅移除服务器 <code>{{.Origin}}</code> 下账户 <code>{{.UserID}}</code> 的本地配对和中继配置，并断开其连接；不会删除服务端账户，不影响其他配对或站点授权。</p>
        <small>移除后，该账户已配置的服务端中继域名仍会拒绝直连；若只是关闭中继，请关掉上方开关后保存。网页仍登录此账户时可能再次配对。</small>
        <div class="row"><button class="danger" name="removeAccount" value="1" aria-label="确认移除 {{.Origin}} 下账户 {{.UserID}} 的配对">确认移除此账户配对</button></div>
      </details>
    </form>
    {{else}}<p class="empty">尚无配对账户。允许站点后，请回到 Vega 完成连接。</p>{{end}}
  </section>
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
		if r.FormValue("saveSupplement") == "1" || r.FormValue("saveRelay") == "1" || r.FormValue("saveBrowser") == "1" || r.FormValue("saveExecution") == "1" || r.FormValue("setOnline") == "1" || r.FormValue("setOffline") == "1" {
			var err error
			if r.FormValue("saveBrowser") == "1" {
				place := "cloud"
				if r.FormValue("browserLocal") == "1" {
					place = "local"
				}
				err = a.saveBrowserPlace(place)
			} else if r.FormValue("saveExecution") == "1" {
				place := "cloud"
				if r.FormValue("executionClient") == "1" {
					place = "client"
				}
				err = a.saveExecutionPlace(place)
			} else if r.FormValue("setOnline") == "1" {
				err = a.setOnline(true)
			} else if r.FormValue("setOffline") == "1" {
				err = a.setOnline(false)
			} else if r.FormValue("saveSupplement") == "1" {
				err = a.editSupplement(func(string) (string, bool, error) { return r.FormValue("supplement"), true, nil })
			} else {
				err = a.saveRelay(r.FormValue("relayOrigin"), r.FormValue("relayUser"), r.FormValue("relayRules"), r.FormValue("relayOn") == "1")
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
			if remove == a.pinnedOrigin {
				a.mu.Unlock()
				http.Error(w, "本客户端固定属于安装包自带的站点，不能在此撤销；如需更换请重新下载对应站点的安装包", http.StatusBadRequest)
				return
			}
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
	type account struct {
		Origin, UserID, Rules, Status string
		Enabled                       bool
	}
	accounts := []account{}
	for _, saved := range a.config.Servers {
		status := "未连接"
		if connection := a.direct[saved.Origin+"\x00"+saved.UserID]; connection != nil {
			status = connection.status.Code
			if status == "connected" {
				status = "已连接"
			}
		}
		enabled := (saved.RelayOn == nil && len(saved.Relay) > 0) || (saved.RelayOn != nil && *saved.RelayOn)
		accounts = append(accounts, account{saved.Origin, saved.UserID, strings.Join(saved.Relay, "\n"), status, enabled})
	}
	supplement := a.config.Supplement
	browserLocal := browserPlace(a.config.Browser) == "local"
	executionCloud := executionPlace(a.config.Prefer) == "cloud"
	offline := a.config.Offline
	a.mu.Unlock()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pairingPage.Execute(w, struct {
		Pending, Trusted                   []string
		Approved, Revoked, Saved, Unpaired bool
		Supplement                         string
		Pin                                string
		BrowserLocal                       bool
		ExecutionCloud                     bool
		Offline                            bool
		Accounts                           []account
	}{pending, trusted, r.URL.Query().Get("approved") == "1", r.URL.Query().Get("revoked") == "1", r.URL.Query().Get("saved") == "1", r.URL.Query().Get("unpaired") == "1", supplement, a.pinnedOrigin, browserLocal, executionCloud, offline, accounts})
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
