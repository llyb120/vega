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
	"time"

	"github.com/gorilla/websocket"
)

type Config struct {
	ClientID       string   `json:"clientId"`
	TrustedOrigins []string `json:"trustedOrigins"`
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

var pairingPage = template.Must(template.New("pairing").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vega 本机连接授权</title><style>body{font:16px system-ui;background:#f5f6fa;color:#202431;margin:0;padding:32px}main{max-width:520px;margin:auto;background:white;padding:28px;border-radius:16px}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#5147dd;color:white}code{overflow-wrap:anywhere}form{padding:16px 0;border-top:1px solid #ddd}p{line-height:1.7}</style><main><h1>Vega 本机连接授权</h1><p>只允许你信任的 Vega 站点。允许后，该站点登录的账号可在本机读写文件、执行命令。无需配置 Key。</p>{{range .Pending}}<form method="post"><p>请求连接的站点：<br><strong><code>{{.}}</code></strong></p><button name="origin" value="{{.}}">允许此站点</button></form>{{else}}<p>当前没有新的连接请求。请保持客户端运行，并登录 Vega 网站。</p>{{end}}{{if .Trusted}}<h2>已信任站点</h2>{{range .Trusted}}<form method="post"><code>{{.}}</code> <button name="remove" value="{{.}}">撤销授权</button></form>{{end}}{{end}}</main></html>`))

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
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if r.ParseForm() != nil {
			http.Error(w, "Invalid form", 400)
			return
		}
		origin, remove := r.FormValue("origin"), r.FormValue("remove")
		a.mu.Lock()
		next := Config{ClientID: a.config.ClientID, TrustedOrigins: append([]string{}, a.config.TrustedOrigins...)}
		if origin != "" && a.pendingOrigins[origin] {
			next.TrustedOrigins = append(next.TrustedOrigins, origin)
		} else if remove != "" {
			next.TrustedOrigins = nil
			for _, item := range a.config.TrustedOrigins {
				if item != remove {
					next.TrustedOrigins = append(next.TrustedOrigins, item)
				}
			}
		} else {
			a.mu.Unlock()
			http.Error(w, "Unknown site", 400)
			return
		}
		data, _ := json.Marshal(next)
		err := os.MkdirAll(filepath.Dir(a.configPath), 0700)
		if err == nil {
			err = os.WriteFile(a.configPath, data, 0600)
		}
		if err != nil {
			a.mu.Unlock()
			http.Error(w, "Unable to save site permission", 500)
			return
		}
		a.config = next
		delete(a.pendingOrigins, origin)
		if remove != "" {
			for conn := range a.connections {
				_ = conn.Close()
			}
		}
		a.mu.Unlock()
		http.Redirect(w, r, r.URL.Path, http.StatusSeeOther)
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
	a.mu.Unlock()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pairingPage.Execute(w, struct{ Pending, Trusted []string }{pending, trusted})
}

type loginProof struct {
	UserID    string `json:"userId"`
	Instance  string `json:"instance"`
	ExpiresAt int64  `json:"expiresAt"`
}

func verifyLogin(origin, ticket string) (loginProof, error) {
	var proof loginProof
	if !validOrigin(origin) || len(ticket) != 72 {
		return proof, fmt.Errorf("Invalid login ticket")
	}
	data, _ := json.Marshal(map[string]string{"ticket": ticket})
	req, err := http.NewRequest(http.MethodPost, origin+"/api/local-agent/verify", bytes.NewReader(data))
	if err != nil {
		return proof, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return proof, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return proof, fmt.Errorf("Login expired")
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&proof)
	if err == nil && (proof.UserID == "" || len(proof.Instance) < 32 || proof.ExpiresAt <= time.Now().UnixMilli()) {
		err = fmt.Errorf("Invalid login proof")
	}
	return proof, err
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
