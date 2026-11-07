package main

// 蝴蝶的提示通道：聊天本身是网页里的 BOT 会话，这里只负责“用户得看一眼”的提示和入口。
// 真实鼠标键盘在动、操作可能已经部分执行时，用户必须在自己电脑上看得见，而不是只写在会话记录里。

import (
	"strings"
	"sync"
	"time"
)

type butterflyNotice struct {
	Kind string // running = 正在操作电脑；needs_review = 可能已部分执行，需要用户核对
	Text string
	At   time.Time
}

var butterflyState struct {
	sync.Mutex
	notice *butterflyNotice
	open   func()
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

// assistantURL 面板打开的地址：本站点的对话页（蝴蝶里该是 BOT 会话，不是站点首页）。
func (a *Agent) assistantURL() string {
	return strings.TrimRight(a.pinnedOrigin, "/") + "/chat"
}

// butterflyNotify 更新提示并显示气泡；同一条内容不反复弹。
func butterflyNotify(kind, text string) {
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
