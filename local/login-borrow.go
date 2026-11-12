package main

// 登录态同步：在你自己的 Chrome 与无头实例之间双向搬 Cookie。
//
// 为什么不复制文件：你自己的 Chrome 开着时，它的 Default/Network/Cookies 是独占打开的（Chrome 157
// 实测连共享读都拿不到），所以 seedLogin 那条复制路径只在 Chrome 关着时才有效。
// 扩展装在你自己的 Chrome 里时改用它：CDP 从那个实例读（Chrome 自己解密，不碰 v10/v20），
// 再写进无头实例；无头里新登录的站点也写回你的 Chrome。
// 规则：只补对方缺的（或对方那份已经过期的），两边都有的有效会话互不覆盖 —— 周期性双向写
// 如果用「来源赢」会来回顶掉、把两边的登录都写坏。回写还记一份镜像，你删掉的登录不会被种回去。

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// loginBorrowEvery 同一台机器最多这么久同步一次：既让后来的登录生效，
	// 又不会每个会话都把用户的页签借来借去。
	loginBorrowEvery = 10 * time.Minute
	// loginBorrowMax 单次最多搬多少条 Cookie（够覆盖常用站点，也不会把内存和请求撑爆）。
	loginBorrowMax = 4000
	// loginBorrowBatch 每次 setCookies 的条数：一次几千条会被 CDP 拒掉或超时。
	loginBorrowBatch  = 500
	loginReadTimeout  = 60 * time.Second
	loginWriteTimeout = 60 * time.Second
)

// loginSyncBusy 一轮只允许一个同步：两个会话同时结束、或与下一次浏览器操作撞上时，
// 不能对同一个页签并发 attach（先结束的那个会把另一个的调试会话 detach 掉）。
var loginSyncBusy atomic.Bool

// loginMirror 是无头实例上一次同步时的登录态（key → value|expires）以及它属于哪个实例。
// 你在自己 Chrome 里退出登录或删掉 Cookie 后，同一份无头 Cookie 不会被自动种回去；
// 只有无头里真的产生了新登录才会再写一次。
var loginMirror = struct {
	sync.Mutex
	owner  string
	values map[string]string
}{}

func mirrorSignature(cookies []map[string]any) map[string]string {
	signature := make(map[string]string, len(cookies))
	for _, cookie := range cookies {
		if key, ok := loginCookieKey(cookie); ok {
			signature[key] = fmt.Sprint(cookie["value"], "|", cookie["expires"])
		}
	}
	return signature
}

func mirrorFor(owner string) map[string]string {
	loginMirror.Lock()
	defer loginMirror.Unlock()
	if loginMirror.owner != owner {
		return nil
	}
	return loginMirror.values
}

// loginMirrorUnchanged 这一轮无头登录态与上次同步时完全一样。会话结束时先问它：
// 没变就直接收工，不去碰你自己 Chrome 的页签（attach 会弹一下调试横条）。
func loginMirrorUnchanged(owner string, cookies []map[string]any) bool {
	known := mirrorFor(owner)
	if known == nil || len(known) != len(cookies) {
		return false
	}
	for key, value := range mirrorSignature(cookies) {
		if known[key] != value {
			return false
		}
	}
	return true
}

// loginUnmirrored 只留上次同步之后无头里新建或变化的 Cookie。
func loginUnmirrored(owner string, cookies []map[string]any) []map[string]any {
	known := mirrorFor(owner)
	fresh := make([]map[string]any, 0, len(cookies))
	for _, cookie := range cookies {
		key, ok := loginCookieKey(cookie)
		if !ok {
			continue
		}
		if known[key] != fmt.Sprint(cookie["value"], "|", cookie["expires"]) {
			fresh = append(fresh, cookie)
		}
	}
	return fresh
}

// recordMirror 记下这轮看到（并已尝试写入）的无头登录态：一条被 CDP 拒掉的 Cookie
// 不该让之后每一轮都再来打扰你的 Chrome。
func recordMirror(owner string, cookies []map[string]any) {
	loginMirror.Lock()
	defer loginMirror.Unlock()
	loginMirror.owner = owner
	loginMirror.values = mirrorSignature(cookies)
}

// headedPeers 你自己开的那些浏览器（扩展连上来的非无头实例），Google Chrome 排前面。
func (b *browserBridge) headedPeers() []string {
	headless := b.headlessClient()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.liveLocked()
	peers := []string{}
	for client := range b.clients {
		if client != headless {
			peers = append(peers, client)
		}
	}
	sort.SliceStable(peers, func(i, j int) bool {
		return b.clients[peers[i]].browser == "Google Chrome" && b.clients[peers[j]].browser != "Google Chrome"
	})
	return peers
}

// borrowLogin 在无头实例和你自己开着的 Chrome 之间同步登录态：两个方向都补，
// 但只补对方没有（或对方那份已经过期）的 Cookie，谁也不顶掉对方刚登录的会话。
// 有节流，坏了只留提示，不影响浏览器本身。
func (b *browserBridge) borrowLogin(h *headlessChrome) {
	headless := b.headlessClient()
	if headless == "" || !h.loginDue(time.Now()) {
		return
	}
	if !loginSyncBusy.CompareAndSwap(false, true) {
		return
	}
	defer loginSyncBusy.Store(false)
	// 有会话正占着浏览器就先不动：那可能是有人在操作你自己的 Chrome 页签。
	b.mu.Lock()
	busy := b.connection != nil
	b.mu.Unlock()
	if busy {
		return
	}
	h.markLogin()
	peers := b.headedPeers()
	if len(peers) == 0 {
		h.note("无头浏览器用它自己的 profile：要用你 Chrome 里的登录态、或把这里的登录同步回 Chrome，请先在你的 Chrome 里装 Vega 扩展（设置 → 授权 → 浏览器扩展）")
		b.logLogin("没有连上来的本机 Chrome")
		return
	}
	// 只跟一个（Chrome 优先）。一个无头 profile 伺候多个浏览器 profile 时，
	// 把 A 的登录写进 B 的浏览器比不同步更糟。
	pulled, pushed, err := b.syncLogin(peers[0], headless)
	b.logLogin("同步 " + strconv.Itoa(pulled) + " → 无头 / " + strconv.Itoa(pushed) + " → 你的 Chrome" + errorSuffix(err))
	if pulled == 0 && pushed == 0 {
		if err != nil {
			h.note("读不到你 Chrome 里的登录态：" + err.Error() + "；请确认装了 Vega 扩展，或改用「我自己的 Chrome」")
			return
		}
		h.note("你 Chrome 与无头浏览器之间没有需要同步的 Cookie")
		return
	}
	h.note(loginSyncNotice(pulled, pushed))
}

// syncLoginAfterTurn 一轮浏览器操作结束就同步一次登录态：无头里刚登录的站点不用等下一个
// 十分钟周期，也不用等下一次浏览器操作。先只看无头实例（隐藏进程）；没变就不碰你的 Chrome。
func (b *browserBridge) syncLoginAfterTurn() {
	h := headlessBrowser.Load()
	headless := b.headlessClient()
	if h == nil || headless == "" {
		return
	}
	tab, err := b.anyTab(headless)
	if err != nil {
		return
	}
	raw, err := b.allCookies(headless, tab)
	if err != nil {
		return
	}
	if loginMirrorUnchanged(headless, loginCookieList(raw)) {
		return
	}
	h.resetLogin()
	go b.borrowLogin(h)
}

// syncLogin 附着一次你自己 Chrome 的后台页签完成双向同步：
// 读你 Chrome 的 Cookie 写进无头实例，再把无头里新登录的 Cookie 写回你 Chrome。
// 写回去的 Cookie 由 Chrome 自己落盘，下次打开还在；不为它单独开窗口或页签。
func (b *browserBridge) syncLogin(peer, headless string) (int, int, error) {
	tab, err := b.idleTab(peer)
	if err != nil {
		return 0, 0, err
	}
	// 读完/写完就 detach：横条、标签组都回到原样（失败了也不影响已经生效的 Cookie）。
	defer func() { _, _ = b.internal(peer, "stop", map[string]any{"tabTag": tab}, 10*time.Second) }()
	raw, err := b.allCookies(peer, tab)
	if err != nil {
		return 0, 0, err
	}
	theirs := loginCookieList(raw)
	headlessTab, err := b.anyTab(headless)
	if err != nil {
		return 0, 0, err
	}
	rawHeadless, err := b.allCookies(headless, headlessTab)
	if err != nil {
		return 0, 0, err
	}
	mine := loginCookieList(rawHeadless)
	forward, back := loginMerge(theirs, mine)
	// 回写只发这轮新出现的：你在 Chrome 里删掉的登录不会被种回去。
	back = loginUnmirrored(headless, back)
	pulled, forwardErr := b.pushCookies(headless, headlessTab, forward)
	pushed, backErr := b.pushCookies(peer, tab, back)
	// 已经尝试过就记账（含已写进无头的那批）；同一条被拒的 Cookie 不每轮重试。
	recordMirror(headless, append(append([]map[string]any{}, mine...), forward...))
	if forwardErr != nil {
		return pulled, pushed, forwardErr
	}
	return pulled, pushed, backErr
}

func loginSyncNotice(pulled, pushed int) string {
	switch {
	case pulled > 0 && pushed > 0:
		return "已从你自己的 Chrome 同步 " + strconv.Itoa(pulled) + " 个 Cookie，也把这里的 " + strconv.Itoa(pushed) + " 个新登录写回了你的 Chrome"
	case pulled > 0:
		return "已从你自己的 Chrome 同步 " + strconv.Itoa(pulled) + " 个 Cookie：无头浏览器可以直接用你已登录的站点"
	default:
		return "已把 " + strconv.Itoa(pushed) + " 个新登录写回你自己的 Chrome"
	}
}

// allCookies 读整个 profile 的 Cookie。老版本 Chrome 要求先启用 Network 域，
// 启用失败也不影响读取（与 Nova 的处理一致）。
func (b *browserBridge) allCookies(client, tab string) (any, error) {
	_, _ = b.internal(client, "cdp", map[string]any{
		"tabTag": tab, "method": "Network.enable", "params": map[string]any{},
	}, loginReadTimeout)
	return b.internal(client, "cdp", map[string]any{
		"tabTag": tab, "method": "Network.getAllCookies", "params": map[string]any{},
	}, loginReadTimeout)
}

func (b *browserBridge) setCookies(client, tab string, params []map[string]any) (int, error) {
	if len(params) == 0 {
		return 0, nil
	}
	if _, err := b.internal(client, "cdp", map[string]any{
		"tabTag": tab, "method": "Network.setCookies", "params": map[string]any{"cookies": params},
	}, loginWriteTimeout); err != nil {
		return 0, err
	}
	return len(params), nil
}

// pushCookies 分批把 Cookie 写进某个 Chrome 实例（用指定的那个页签做 CDP 会话）。
func (b *browserBridge) pushCookies(client, tab string, cookies []map[string]any) (int, error) {
	params := make([]map[string]any, 0, len(cookies))
	for _, cookie := range cookies {
		if param := loginCookieParam(cookie); param != nil {
			params = append(params, param)
		}
	}
	applied := 0
	var lastErr error
	for start := 0; start < len(params); start += loginBorrowBatch {
		end := min(start+loginBorrowBatch, len(params))
		count, err := b.setCookies(client, tab, params[start:end])
		if err == nil {
			applied += count
			continue
		}
		// 一条坏 Cookie 不能拖死整批：逐条重试，能写进去的先落地。
		lastErr = err
		for _, param := range params[start:end] {
			if count, single := b.setCookies(client, tab, []map[string]any{param}); single == nil {
				applied += count
			}
		}
	}
	return applied, lastErr
}

// loginCookieParam 把一条 Cookie 变成 setCookies 认识的参数：
// 以点开头的是域 Cookie；其它（host-only）用 url 写，否则会把登录扩散到子域。
// 分区（CHIPS）Cookie 与非法 sameSite 跳过：CDP 会拒掉它们。
func loginCookieParam(cookie map[string]any) map[string]any {
	name, _ := cookie["name"].(string)
	value, _ := cookie["value"].(string)
	domain, _ := cookie["domain"].(string)
	if name == "" || domain == "" {
		return nil
	}
	if _, partitioned := cookie["partitionKey"]; partitioned {
		return nil
	}
	path, _ := cookie["path"].(string)
	if path == "" {
		path = "/"
	}
	secure, _ := cookie["secure"].(bool)
	httpOnly, _ := cookie["httpOnly"].(bool)
	param := map[string]any{"name": name, "value": value, "path": path, "secure": secure, "httpOnly": httpOnly}
	if strings.HasPrefix(domain, ".") {
		param["domain"] = domain
	} else {
		scheme := "http"
		if secure {
			scheme = "https"
		}
		param["url"] = scheme + "://" + domain + path
	}
	if sameSite, ok := cookie["sameSite"].(string); ok && (sameSite == "Strict" || sameSite == "Lax" || sameSite == "None") {
		param["sameSite"] = sameSite
	}
	if expires, ok := cookie["expires"].(float64); ok && expires > 0 {
		param["expires"] = expires
	}
	return param
}

// loginMerge 决定这次两个方向各写哪些 Cookie：只补对方没有的、或对方那份已经过期的。
// 两边都有且仍然有效的同名 Cookie 各留各的，不拿一边的旧值顶掉另一边刚登录的会话。
func loginMerge(theirs, mine []map[string]any) (forward, back []map[string]any) {
	index := func(list []map[string]any) map[string]map[string]any {
		entries := make(map[string]map[string]any, len(list))
		for _, cookie := range list {
			if key, ok := loginCookieKey(cookie); ok {
				entries[key] = cookie
			}
		}
		return entries
	}
	now := float64(time.Now().Unix())
	mineIndex, theirIndex := index(mine), index(theirs)
	for _, cookie := range theirs {
		if loginCookieExpired(cookie, now) {
			continue // 已经过期的来源 Cookie 搬过去也不会生效。
		}
		if key, ok := loginCookieKey(cookie); ok {
			if current, exists := mineIndex[key]; !exists || loginCookieExpired(current, now) {
				forward = append(forward, cookie)
			}
		}
	}
	for _, cookie := range mine {
		if loginCookieExpired(cookie, now) {
			continue
		}
		if key, ok := loginCookieKey(cookie); ok {
			if current, exists := theirIndex[key]; !exists || loginCookieExpired(current, now) {
				back = append(back, cookie)
			}
		}
	}
	return forward, back
}

// loginCookieKey 认一条 Cookie 的身份：同一站点、同名、同路径才算同一条。
func loginCookieKey(cookie map[string]any) (string, bool) {
	name, _ := cookie["name"].(string)
	domain, _ := cookie["domain"].(string)
	path, _ := cookie["path"].(string)
	if name == "" || domain == "" {
		return "", false
	}
	return name + "\x00" + domain + "\x00" + path, true
}

// loginCookieExpired 只有过期的才允许被另一侧覆盖；会话 Cookie（没有 expires）算有效。
func loginCookieExpired(cookie map[string]any, now float64) bool {
	expires, ok := cookie["expires"].(float64)
	return ok && expires > 0 && expires <= now
}

// idleTab 挑一个可以静默附上去的页签：只挑后台页签，
// 只剩用户正在看的那一页时宁可不读，也不在他眼前弹调试横条。
func (b *browserBridge) idleTab(client string) (string, error) {
	raw, err := b.internal(client, "tabs", map[string]any{}, 20*time.Second)
	if err != nil {
		return "", err
	}
	for _, tab := range tabList(raw) {
		url, _ := tab["url"].(string)
		if tab["active"] == true || !usableTabURL(url) {
			continue
		}
		if tag, _ := tab["tag"].(string); tag != "" {
			return tag, nil
		}
	}
	return "", errors.New("本机 Chrome 没有可以静默读取的后台页签")
}

// anyTab 无头实例里的任意页签（启动后总有 about:blank）。
func (b *browserBridge) anyTab(client string) (string, error) {
	raw, err := b.internal(client, "tabs", map[string]any{}, 20*time.Second)
	if err != nil {
		return "", err
	}
	tabs := tabList(raw)
	for _, tab := range tabs {
		if url, _ := tab["url"].(string); usableTabURL(url) {
			if tag, _ := tab["tag"].(string); tag != "" {
				return tag, nil
			}
		}
	}
	if len(tabs) > 0 {
		if tag, _ := tabs[0]["tag"].(string); tag != "" {
			return tag, nil
		}
	}
	return "", errors.New("无头浏览器没有可用页签")
}

// loginCookieList 只留能写进另一个 Chrome 的字段：跳过 CHIPS（partitionKey）和不完整的条目。
func loginCookieList(raw any) []map[string]any {
	object, _ := raw.(map[string]any)
	list, _ := object["cookies"].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		cookie, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := cookie["name"].(string)
		domain, _ := cookie["domain"].(string)
		value, _ := cookie["value"].(string)
		if name == "" || domain == "" || len(value) > 8<<10 {
			continue
		}
		// 分区（CHIPS）Cookie 依赖 top-level site，跨浏览器搬过去只会变成无效条目。
		if _, partitioned := cookie["partitionKey"]; partitioned {
			continue
		}
		entry := map[string]any{"name": name, "value": value, "domain": domain, "path": "/"}
		if path, ok := cookie["path"].(string); ok && path != "" {
			entry["path"] = path
		}
		for _, key := range []string{"secure", "httpOnly"} {
			if flag, ok := cookie[key].(bool); ok && flag {
				entry[key] = true
			}
		}
		if sameSite, ok := cookie["sameSite"].(string); ok && sameSite != "" {
			entry["sameSite"] = sameSite
		}
		// 会话 Cookie（expires <= 0）不写 expires，跟着无头实例的会话走。
		if expires, ok := cookie["expires"].(float64); ok && expires > 0 {
			entry["expires"] = expires
		}
		out = append(out, entry)
		if len(out) >= loginBorrowMax {
			break
		}
	}
	return out
}

func tabList(raw any) []map[string]any {
	object, _ := raw.(map[string]any)
	list, _ := object["tabs"].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if tab, ok := item.(map[string]any); ok {
			out = append(out, tab)
		}
	}
	return out
}

// usableTabURL 扩展只允许对 http(s) 和 about:blank 附调试器。
func usableTabURL(url string) bool {
	return url == "about:blank" || strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://")
}

func errorSuffix(err error) string {
	if err == nil {
		return ""
	}
	return "（" + err.Error() + "）"
}

// logLogin 只记过程，不记任何 Cookie 内容。
func (b *browserBridge) logLogin(text string) {
	if runningAgent != nil {
		runningAgent.clientLog("登录态借用：%s", text)
	}
}
