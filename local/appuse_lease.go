package main

// 输入租约与桌面归属：与 Nova 的 jianlai::INPUT_LEASE / DESKTOP_OWNER 对齐。
//
// 一把真实屏幕上的输入租约（同一时刻只有一路在动鼠标键盘），外加“最近是谁在操作桌面”，
// 光效与 Esc 叫停都读它。租约只在真正注入输入/切窗时持有，观察与截图不占用。

import (
	"fmt"
	"sync"
	"time"
)

type appuseLeaseState struct {
	sync.Mutex
	holder   string
	kind     string
	since    time.Time
	sequence uint64
	owner    string
	last     time.Time
	// 最近一次注入输入的结束时间：数字员工据此区分自己的注入与用户真实操作。
	lastInjected time.Time
	escapedAt    time.Time
}

var appuseInput appuseLeaseState

// appuseLease 表示这次输入持有屏幕；release 幂等。
type appuseLease struct {
	state    *appuseLeaseState
	released bool
	sequence uint64
}

// appuseAcquireInput 拿输入租约：同一时刻只有一路能写桌面，另一路等待而不是交错。
func appuseAcquireInput(owner, kind string) (*appuseLease, error) {
	deadline := time.Now().Add(appuseLeaseWait)
	for {
		appuseInput.Lock()
		if appuseInput.holder == "" {
			appuseInput.sequence++
			appuseInput.holder, appuseInput.kind, appuseInput.since = owner, kind, time.Now()
			appuseInput.owner, appuseInput.last = owner, time.Now()
			lease := &appuseLease{state: &appuseInput, sequence: appuseInput.sequence}
			appuseInput.Unlock()
			appuseBrandCursor()
			return lease, nil
		}
		appuseInput.Unlock()
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("另一路操作正在占用这台电脑的鼠标键盘（%s）；本批未执行，稍后重试，不要并发抢输入", kind)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

const appuseLeaseWait = 15 * time.Second

func (l *appuseLease) release() {
	if l == nil || l.released {
		return
	}
	l.released = true
	l.state.Lock()
	if l.state.sequence == l.sequence && l.state.holder != "" {
		l.state.holder = ""
		l.state.lastInjected = time.Now()
		l.state.last = time.Now()
	}
	l.state.Unlock()
	appuseRestoreCursor()
}

// appuseDesktopOwner 是最近一次前台操作桌面的会话 id（Esc 叫停时按它定位要停的会话）。
func appuseDesktopOwner() string {
	appuseInput.Lock()
	defer appuseInput.Unlock()
	return appuseInput.owner
}

// appuseInputActive 报告当前是否真有一路在写桌面，以及最近一次注入的时间。
func appuseInputActive() (busy bool, lastInjected time.Time) {
	appuseInput.Lock()
	defer appuseInput.Unlock()
	return appuseInput.holder != "", appuseInput.lastInjected
}

// appuseMarkEscaped 记下用户亲手按 Esc 的时刻；叫停由调用方派发。
func appuseMarkEscaped() { appuseInput.Lock(); appuseInput.escapedAt = time.Now(); appuseInput.Unlock() }

// appuseEscapedSince 报告自 since 起用户是否按 Esc 叫停过。
func appuseEscapedSince(since time.Time) bool {
	appuseInput.Lock()
	defer appuseInput.Unlock()
	return !appuseInput.escapedAt.IsZero() && !appuseInput.escapedAt.Before(since)
}
