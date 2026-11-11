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
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ClientID         string               `json:"clientId"`
	Supplement       string               `json:"supplement,omitempty"`
	Browser          string               `json:"browser,omitempty"`       // 旧字段，仅作尚未按牛马配置时的缺省
	BrowserMaster    string               `json:"browserMaster,omitempty"` // 旧的账户级记忆，已改按牛马存
	LoginState       *bool                `json:"loginState,omitempty"`    // 已废弃：始终允许借用登录态
	SSHKeys          *bool                `json:"sshKeys,omitempty"`       // 已废弃：始终允许借用 ~/.ssh
	Prefer           string               `json:"prefer,omitempty"`        // 旧字段，仅作尚未按牛马配置时的缺省
	FsMaster         string               `json:"fsMaster,omitempty"`
	EmployeeMasters  []EmployeeMasterPref `json:"employeeMasters,omitempty"`
	SelectedEmployee string               `json:"selectedEmployee,omitempty"`
	Offline          bool                 `json:"offline,omitempty"`        // 已废弃：进程开着即上线，忽略此字段
	Butterfly        bool                 `json:"butterfly,omitempty"`      // 显示任务栏蝴蝶与提示气泡；默认关
	ConfirmSeconds   int                  `json:"confirmSeconds,omitempty"` // 动鼠标键盘前等几秒（0 = 用默认 15）
	TrustedOrigins   []string             `json:"trustedOrigins"`
	Servers          []ServerCredential   `json:"servers,omitempty"`
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
	a := &Agent{configPath: filepath.Join(dir, "trusted-sites.json"), dataDir: dir, pinnedOrigin: pin.Origin, configToken: hex.EncodeToString(token), connections: make(map[*Conn]struct{}), pendingOrigins: make(map[string]bool)}
	data, err := os.ReadFile(a.configPath)
	if err == nil {
		err = json.Unmarshal(data, &a.config)
	}
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	// 只认安装包里的站点，其它来源不参与白名单。
	a.config.TrustedOrigins = []string{a.pinnedOrigin}
	if len(a.config.Servers) == 0 {
		// clientId 必须跟凭据一起搬：服务端的授权记录把它和 token 绑定，换成新 id 握手就过不了。
		imported, importedClientID := legacyServers(a.pinnedOrigin)
		a.config.Servers = imported
		if len(imported) > 0 {
			if importedClientID != "" {
				a.config.ClientID = importedClientID
			}
			a.clientLog("沿用旧版配对凭据：%s", a.pinnedOrigin)
			// 立刻落到自己的目录，别每次启动都去读旧配置（它随时可能被删除）。
			if data, marshalErr := json.Marshal(a.config); marshalErr == nil {
				_ = os.MkdirAll(dir, 0o700)
				_ = os.WriteFile(a.configPath, data, 0o600)
			}
		}
	}
	kept := currentAccounts(a.config.Servers, a.pinnedOrigin)
	dropped := len(a.config.Servers) - len(kept)
	a.config.Servers = kept
	if dropped > 0 {
		a.clientLog("站点 %s 只保留最近配对的账户，丢弃 %d 个旧配对", a.pinnedOrigin, dropped)
		_ = a.saveConfig(a.config) // 旧账户的凭据不再留在本机
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

// allowOrigin 只放行安装包自带的站点；其它站点一律拒绝，也不弹窗请求授权。
func (a *Agent) allowOrigin(origin string) bool {
	if !validOrigin(origin) {
		a.noteSite(origin, "拒绝：来源地址不合法")
		return false
	}
	if origin != a.pinnedOrigin {
		a.noteSite(origin, "拒绝：本客户端只属于 "+a.pinnedOrigin)
		fmt.Fprintf(os.Stderr, "vega-local: 拒绝站点 %s：此客户端只属于 %s\n", origin, a.pinnedOrigin)
		return false
	}
	return true
}

// legacyServers 把旧版共用配置里属于本安装包站点的配对搬过来：数据目录一按站点分开，
// 老用户的设备凭据不然就丢了，得重新让浏览器配对一次。
func legacyServers(origin string) ([]ServerCredential, string) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, ""
	}
	data, err := os.ReadFile(filepath.Join(configDir, "vega-local", "trusted-sites.json"))
	if err != nil {
		return nil, ""
	}
	var legacy Config
	if json.Unmarshal(data, &legacy) != nil {
		return nil, ""
	}
	imported := []ServerCredential{}
	for _, saved := range legacy.Servers {
		if saved.Origin == origin {
			imported = append(imported, saved)
		}
	}
	if len(imported) == 0 {
		return nil, ""
	}
	return imported, legacy.ClientID
}

// currentAccounts 只留安装包站点下最近配对的账户：客户端只服务当前登录的账号，
// 换号前留下的别人账户的配对不能再连上来操作同一台电脑。
func currentAccounts(servers []ServerCredential, origin string) []ServerCredential {
	latest := make(map[string]int, len(servers))
	for i, saved := range servers {
		if saved.Origin == origin {
			latest[saved.Origin] = i
		}
	}
	kept := []ServerCredential{}
	for i, saved := range servers {
		if index, ok := latest[saved.Origin]; ok && index == i {
			kept = append(kept, saved)
		}
	}
	return kept
}

// noteSite 记下最近一次站点连接：图形方式启动时 stderr 看不到，配置页和 client.log 是唯一线索。
func (a *Agent) noteSite(origin, result string) {
	line := time.Now().Format("15:04:05") + " · " + result
	if origin != "" {
		line = time.Now().Format("15:04:05") + " · " + origin + " · " + result
	}
	a.mu.Lock()
	a.lastSite = line
	a.mu.Unlock()
	a.clientLog("站点 %s", line)
}

// clientLog 追加到 <数据目录>/client.log（双击启动时没有控制台）。
func (a *Agent) clientLog(format string, args ...any) {
	if a.dataDir == "" {
		return
	}
	file, err := os.OpenFile(filepath.Join(a.dataDir, "client.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
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
input[type=number]{width:96px;padding:9px 12px;border:1px solid #c9cee0;border-radius:12px;background:#fbfbfe;font:inherit}
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
/* 分区用 tab：纯 CSS，CSP 不开内联脚本；radio 隐藏但仍可键盘切换。 */
.tab{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.tabs label{margin:0;padding:8px 16px;border-radius:999px;background:#eef0f8;color:var(--muted);font-size:.92rem;cursor:pointer}
.tabs label:hover{background:#e6e9f5}
#tab-site:checked~.tabs label[for=tab-site],#tab-client:checked~.tabs label[for=tab-client],#tab-access:checked~.tabs label[for=tab-access],#tab-computer:checked~.tabs label[for=tab-computer],#tab-relay:checked~.tabs label[for=tab-relay]{background:var(--brand);color:var(--brand-ink)}
#tab-site:focus-visible~.tabs label[for=tab-site],#tab-client:focus-visible~.tabs label[for=tab-client],#tab-access:focus-visible~.tabs label[for=tab-access],#tab-computer:focus-visible~.tabs label[for=tab-computer],#tab-relay:focus-visible~.tabs label[for=tab-relay]{outline:3px solid #292177;outline-offset:2px}
.panel{display:none}
#tab-site:checked~.panels #panel-site,#tab-client:checked~.panels #panel-client,#tab-access:checked~.panels #panel-access,#tab-computer:checked~.panels #panel-computer,#tab-relay:checked~.panels #panel-relay{display:block}
</style>
<main>
  <div class="hero"><div class="badge" aria-hidden="true"></div><div><h1>牵牛星 · 本机连接</h1><p>本客户端来自 <code>{{.Pin}}</code>，只能连接该站点；该站点登录的账号可在本机读写文件、执行命令。</p></div></div>

  {{if .Approved}}<div class="flash ok" role="status"><strong>站点权限已保存。</strong>请回到 Vega 查看登录验证与后端连接结果；允许站点不代表后端已经连通。HTTP 站点也可连接，但凭据和命令会明文传输。</div>{{end}}
  {{if .Revoked}}<div class="flash warn" role="status">站点授权已撤销。若 Vega 网站仍开着，新的连接检测会再次申请授权；关闭网站可停止申请。</div>{{end}}
  {{if .Saved}}<div class="flash ok" role="status">本地配置已保存，将同步到已连接的后端；离线时请等待客户端重新连接。</div>{{end}}
  {{if .Unpaired}}<div class="flash warn" role="status">指定账户的本地配对已移除，站点授权不变。若该账户仍在 Vega 网页中登录，网页可能再次发起配对。</div>{{end}}

  <input type="radio" name="tab" id="tab-site" class="tab"{{if eq .Tab "site"}} checked{{end}}>
  <input type="radio" name="tab" id="tab-client" class="tab"{{if eq .Tab "client"}} checked{{end}}>
  <input type="radio" name="tab" id="tab-access" class="tab"{{if eq .Tab "access"}} checked{{end}}>
  <input type="radio" name="tab" id="tab-computer" class="tab"{{if eq .Tab "computer"}} checked{{end}}>
  <input type="radio" name="tab" id="tab-relay" class="tab"{{if eq .Tab "relay"}} checked{{end}}>
  <nav class="tabs" aria-label="连接授权分区">
    <label for="tab-site">站点</label>
    <label for="tab-client">本机</label>
    <label for="tab-access">授权</label>
    <label for="tab-computer">电脑</label>
    <label for="tab-relay">账户</label>
  </nav>
  <div class="panels">
  <section class="panel" id="panel-site">

  <section class="card">
    <h2>站点连接</h2>
    {{if .LastSite}}<p>{{.LastSite}}</p>{{else}}<p class="empty">还没有任何站点连到本机客户端。用<b>同一台电脑</b>的浏览器打开 <code>{{.Pin}}</code> 并登录，页面会自动发起配对。</p>{{end}}
    <small>这个页面只说客户端看到了什么。如果一直为空：浏览器和客户端不在同一台电脑、浏览器在 https 页面上、或者浏览器拦住了到 127.0.0.1 的连接。详细记录在数据目录的 client.log。</small>
  </section>

  {{if .Trusted}}
  <section class="card">
    <h2>已信任站点</h2>
    {{range .Trusted}}
    <form method="post" class="site"><code>{{.}}</code><button class="secondary" name="remove" value="{{.}}">撤销授权</button></form>
    {{end}}
  </section>
  {{end}}

  </section>
  <section class="panel" id="panel-access">

  <section class="card">
    <h2>浏览器 Master</h2>
    <small>按牛马配置。选定只把这头牛马的其余节点降为 Follower，不影响其它牛马。本机当浏览器 Master 时，不会把云端 Cookie 灌进本机 Chrome，也不会让本机流量改走云端。登录态默认允许被云端 Master 借用，不再单独开关。</small>
    {{if .Employees}}
    {{range $emp := .Employees}}
    <form method="post">
      <p><strong>{{$emp.Name}}</strong></p>
      <input type="hidden" name="employeeId" value="{{$emp.ID}}">
      {{range $.Nodes}}
      <label class="switch"><input type="radio" name="browserMaster" value="{{.ID}}"{{if eq .ID $emp.BrowserMaster}} checked{{end}}>{{.Name}}{{if eq .ID "cloud"}}（云端）{{else if .Online}} · 在线{{else}} · 离线{{end}}</label>
      {{end}}
      <div class="row"><button name="saveBrowserMaster" value="1">保存这头牛马的浏览器 Master</button></div>
    </form>
    {{end}}
    {{else}}<p class="empty">连上站点后，可按牛马分别配置浏览器 Master。尚未列出牛马时无法保存。</p>{{end}}
  </section>

  </section>
  <section class="panel" id="panel-client">

  <section class="card">
    <h2>文件系统 Master</h2>
    <small>按牛马配置，这是 read / write / edit / bash 实际执行的机器。选定只把这头牛马的其余节点降为 Follower，不影响其它牛马。要停接活，把这台设成 Follower，并把 Master 交给别的节点（没有别的可用节点时用云端）。进程开着就是上线，退出按还原点恢复。</small>
    {{if .Employees}}
    {{range $emp := .Employees}}
    <form method="post">
      <p><strong>{{$emp.Name}}</strong></p>
      <input type="hidden" name="employeeId" value="{{$emp.ID}}">
      {{range $.Nodes}}
      <label class="switch"><input type="radio" name="fsMaster" value="{{.ID}}"{{if eq .ID $emp.FsMaster}} checked{{end}}>{{.Name}}{{if eq .ID "cloud"}}（云端）{{else if .Online}} · 在线{{else}} · 离线{{end}}</label>
      {{end}}
      <div class="row"><button name="saveFsMaster" value="1">保存这头牛马的文件系统 Master</button></div>
    </form>
    {{end}}
    {{else}}<p class="empty">连上站点后，可按牛马分别配置文件系统 Master。尚未列出牛马时无法保存。</p>{{end}}
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

  </section>
  <section class="panel" id="panel-computer">

  <section class="card">
    <h2>蝴蝶提示</h2>
    <form method="post">
      <label class="switch"><input type="checkbox" name="butterflyOn" value="1"{{if .Butterfly}} checked{{end}}>显示任务栏蝴蝶与提示气泡</label>
      <small>默认关闭：任务栏不显示蝴蝶，也不弹「正在操作这台电脑」「需要你核对」的气泡；打开后立即生效。托盘菜单「蝴蝶助理」始终可以手动打开面板。</small>
      <div class="row"><button name="saveButterfly" value="1">保存蝴蝶设置</button></div>
    </form>
  </section>

  <section class="card">
    <h2>操作电脑前的确认</h2>
    <form method="post">
      <label for="confirmSeconds">等多少秒（不选就开始）</label>
      <input id="confirmSeconds" name="confirmSeconds" type="number" min="{{.ConfirmMin}}" max="{{.ConfirmMax}}" value="{{.ConfirmSeconds}}">
      <small>牛马要动你电脑的鼠标键盘前，蝴蝶上方会弹一张「现在接管 / 我在用」的卡，这段时间内不选就当作同意；选「我在用」后 5 分钟内不再问也不操作。可填 {{.ConfirmMin}}–{{.ConfirmMax}} 秒；关掉上面蝴蝶就不会问。</small>
      <div class="row"><button name="saveConfirm" value="1">保存确认时间</button></div>
    </form>
  </section>

  </section>
  <section class="panel" id="panel-relay">

  <section class="card">
    <h2>账户配对</h2>
    <p>这里只管理本机与站点账户的配对。云端当 Master 时，访不到的网络会自动单向借用本机网桥，不再单独配置流量中继。</p>
    {{range .Accounts}}
    <form method="post" class="account">
      <p>所属服务器地址：<strong><code>{{.Origin}}</code></strong><br>账户 ID：<code>{{.UserID}}</code><br>
        <span class="status{{if eq .Status "已连接"}} on{{end}}">{{.Status}}</span>
      </p>
      <input type="hidden" name="relayOrigin" value="{{.Origin}}">
      <input type="hidden" name="relayUser" value="{{.UserID}}">
      <details><summary>移除此账户配对</summary>
        <p>仅移除服务器 <code>{{.Origin}}</code> 下账户 <code>{{.UserID}}</code> 的本地配对，并断开其连接；不会删除服务端账户，不影响其他配对或站点授权。</p>
        <small>网页仍登录此账户时可能再次配对。</small>
        <div class="row"><button class="danger" name="removeAccount" value="1" aria-label="确认移除 {{.Origin}} 下账户 {{.UserID}} 的配对">确认移除此账户配对</button></div>
      </details>
    </form>
    {{else}}<p class="empty">尚无配对账户。允许站点后，请回到 Vega 完成连接。</p>{{end}}
  </section>

  </section>
  </div>
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
		if r.FormValue("saveSupplement") == "1" || r.FormValue("saveFsMaster") == "1" || r.FormValue("saveBrowserMaster") == "1" || r.FormValue("saveButterfly") == "1" || r.FormValue("saveConfirm") == "1" {
			var err error
			tab := "client"
			if r.FormValue("saveBrowserMaster") == "1" {
				tab = "access"
				err = a.saveBrowserMaster(strings.TrimSpace(r.FormValue("employeeId")), strings.TrimSpace(r.FormValue("browserMaster")))
			} else if r.FormValue("saveFsMaster") == "1" {
				err = a.saveFsMaster(strings.TrimSpace(r.FormValue("employeeId")), strings.TrimSpace(r.FormValue("fsMaster")))
			} else if r.FormValue("saveButterfly") == "1" {
				tab = "computer"
				err = a.saveButterfly(r.FormValue("butterflyOn") == "1")
			} else if r.FormValue("saveConfirm") == "1" {
				tab = "computer"
				seconds, convErr := strconv.Atoi(strings.TrimSpace(r.FormValue("confirmSeconds")))
				if convErr != nil {
					http.Error(w, "确认时间要填秒数", http.StatusBadRequest)
					return
				}
				err = a.saveConfirmSeconds(seconds)
			} else if r.FormValue("saveSupplement") == "1" {
				err = a.editSupplement(func(string) (string, bool, error) { return r.FormValue("supplement"), true, nil })
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Redirect(w, r, r.URL.Path+"?saved=1&tab="+tab, http.StatusSeeOther)
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
		tab := "site"
		if unpair {
			result, tab = "unpaired", "relay"
		} else if remove != "" {
			result = "revoked"
		}
		http.Redirect(w, r, r.URL.Path+"?"+result+"=1&tab="+tab, http.StatusSeeOther)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET or POST required", 405)
		return
	}
	a.mu.Lock()
	trusted := append([]string{}, a.config.TrustedOrigins...)
	lastSite := a.lastSite
	type account struct {
		Origin, UserID, Status string
		Enabled                bool
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
		accounts = append(accounts, account{saved.Origin, saved.UserID, status, true})
	}
	supplement := a.config.Supplement
	employees, nodes := a.pairingMasters()
	butterfly := a.config.Butterfly
	a.mu.Unlock()
	tab := r.URL.Query().Get("tab")
	switch tab {
	case "site", "client", "access", "computer", "relay":
	default:
		tab = "site"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pairingPage.Execute(w, struct {
		Pending, Trusted                   []string
		Approved, Revoked, Saved, Unpaired bool
		Supplement                         string
		Pin                                string
		LastSite                           string
		Employees                          []EmployeeMasterView
		Nodes                              []RuntimeNode
		Butterfly                          bool
		ConfirmSeconds                     int
		ConfirmMin, ConfirmMax             int
		Tab                                string
		Accounts                           []account
	}{nil, trusted, r.URL.Query().Get("approved") == "1", r.URL.Query().Get("revoked") == "1", r.URL.Query().Get("saved") == "1", r.URL.Query().Get("unpaired") == "1", supplement, a.pinnedOrigin, lastSite, employees, nodes, butterfly, appuseConfirmSeconds(), appuseConfirmMin, appuseConfirmMax, tab, accounts})
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
