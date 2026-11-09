package main

// 蝴蝶的提示通道：聊天本身是网页里的 BOT 会话，这里只负责“用户得看一眼”的提示和入口。
// 真实鼠标键盘在动、操作可能已经部分执行时，用户必须在自己电脑上看得见，而不是只写在会话记录里。

import (
	"sync"
	"time"
)

type butterflyNotice struct {
	Kind string // running = 正在操作电脑；needs_review = 可能已部分执行，需要用户核对
	Text string
	At   time.Time
}

// butterflyDetail 当前服务端五档的 detail（气泡卡副标题/待确认正文）；客户端不另存。

var butterflyState struct {
	sync.Mutex
	notice   *butterflyNotice
	disabled bool // 设置里关掉蝴蝶：不再弹气泡、不画任务栏蝴蝶
	open     func()
}

// butterflyQuiet 让测试只验证提示状态，不真的弹窗。
var butterflyQuiet bool

func butterflySnapshot() *butterflyNotice {
	butterflyState.Lock()
	defer butterflyState.Unlock()
	return butterflyState.notice
}

// butterflySetOpen 注册“打开 BOT 会话”的入口：托盘菜单和气泡点击都用它。
func butterflySetOpen(open func()) {
	butterflyState.Lock()
	butterflyState.open = open
	butterflyState.Unlock()
}

// butterflyOpen 打开网页里的 BOT 会话。
func butterflyOpen() {
	butterflyState.Lock()
	open := butterflyState.open
	butterflyState.Unlock()
	if open != nil {
		open()
	}
}

// assistantURL 蝴蝶面板打开的地址：本地内置的助理界面（不用登录网站，也不加载站点前端）。
func (a *Agent) assistantURL() string {
	return a.assistantBase()
}

// threadURL 面板里直达某条会话：界面自己记得上次看的那条，这里仍然回到面板。
func (a *Agent) threadURL(session string) string {
	return a.assistantBase()
}

// butterflyOpenThread 双击直达某条会话；没拿到 agent 时退回普通打开。
func butterflyOpenThread(thread string) {
	if runningAgent != nil && thread != "" {
		url := runningAgent.threadURL(thread)
		if !butterflyPanelOpen(url) {
			openBrowser(url)
		}
		return
	}
	butterflyOpen()
}

// butterflyNotify 更新提示并显示气泡；同一条内容不反复弹。
func butterflyNotify(kind, text string) {
	if butterflyDisabled() {
		return
	}
	butterflyState.Lock()
	previous := butterflyState.notice
	notice := &butterflyNotice{Kind: kind, Text: text, At: time.Now()}
	butterflyState.notice = notice
	butterflyState.Unlock()
	butterflyTrayNotice(notice)
	butterflyChipState(kind)
	if previous == nil || previous.Kind != kind || previous.Text != text || time.Since(previous.At) > 30*time.Second {
		if !butterflyQuiet {
			butterflyShowNotice(notice)
		}
	}
}

// butterflyClear 撤掉提示，收起气泡并恢复托盘。
func butterflyClear() {
	butterflyState.Lock()
	had := butterflyState.notice != nil
	butterflyState.notice = nil
	butterflyState.Unlock()
	if !had {
		return
	}
	butterflyTrayNotice(nil)
	butterflyChipState("")
	if !butterflyQuiet {
		butterflyHideNotice()
	}
}

// butterflyClearIfKind 只清掉某一类提示：操作结束不能抹掉“待核对”的提醒。
func butterflyClearIfKind(kind string) {
	butterflyState.Lock()
	current := butterflyState.notice
	butterflyState.Unlock()
	if current != nil && current.Kind == kind {
		butterflyClear()
	}
}

// butterflyDisabled 设置里关掉蝴蝶后为 true：提示与任务栏蝴蝶都不再出现。
func butterflyDisabled() bool {
	butterflyState.Lock()
	defer butterflyState.Unlock()
	return butterflyState.disabled
}

// butterflySetEnabled 打开/关掉蝴蝶：关掉时收起当前气泡和任务栏蝴蝶，并忽略后续提示。
func butterflySetEnabled(on bool) {
	butterflyState.Lock()
	butterflyState.disabled = !on
	quiet := butterflyQuiet
	butterflyState.Unlock()
	// 测试里不碰真实窗口（butterflyQuiet 只跑状态）。
	if quiet {
		return
	}
	if on {
		butterflyChipStart()
		return
	}
	butterflyClear()
	butterflyChipHide()
}
