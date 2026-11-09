package main

// 动鼠标键盘前先问用户一句：与 Nova 数字员工操作电脑同一套（employee::claim_desktop / ask_takeover）——
// 蝴蝶上方弹一张要作答的卡，倒计时内不选就当作同意；选「我在用」就冷却几分钟，期间不再问也不再操作。
// shortcut: 冷却和“问过谁”只存在本次运行里（Nova 把它们落进 employee.json），客户端重启后会再问一次。

import (
	"fmt"
	"sync"
	"time"
)

const (
	appuseConfirmDefault = 15 // 秒：与 Nova 的 takeover_seconds 默认值一致
	appuseConfirmMin     = 3
	appuseConfirmMax     = 600
	appuseConfirmCool    = 5 * time.Minute  // 拒绝后的冷却（Nova 的 DESKTOP_COOLDOWN_MS）
	appuseConfirmReuse   = 10 * time.Minute // 同一个会话连续操作只问一次
)

// appuseConfirmTimeout 与卡上那句说明都跟着设置里的秒数走（见 setAppuseConfirmSeconds）。
var (
	appuseConfirmTimeout = appuseConfirmDefault * time.Second
	appuseConfirmText    = appuseConfirmTextFor(appuseConfirmDefault)
)

func appuseConfirmTextFor(seconds int) string {
	return fmt.Sprintf("%d 秒内不选就开始用鼠标键盘操作这台电脑；操作中按 Esc 可随时叫停。", seconds)
}

// appuseConfirmSeconds 是当前生效的秒数（设置页展示用）。
func appuseConfirmSeconds() int { return int(appuseConfirmTimeout / time.Second) }

// setAppuseConfirmSeconds 让设置里的秒数生效：启动与保存时各调一次，没设置或越界就用默认值。
func setAppuseConfirmSeconds(seconds int) {
	if seconds < appuseConfirmMin || seconds > appuseConfirmMax {
		seconds = appuseConfirmDefault
	}
	appuseConfirmTimeout = time.Duration(seconds) * time.Second
	appuseConfirmText = appuseConfirmTextFor(seconds)
}

// saveConfirmSeconds 保存「操作电脑前等多少秒」并立即生效。
func (a *Agent) saveConfirmSeconds(seconds int) error {
	if seconds < appuseConfirmMin || seconds > appuseConfirmMax {
		return fmt.Errorf("确认时间要在 %d–%d 秒之间", appuseConfirmMin, appuseConfirmMax)
	}
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.ConfirmSeconds = seconds
	err := a.saveConfig(next)
	if err == nil {
		a.config = next
	}
	a.mu.Unlock()
	if err != nil {
		return fmt.Errorf("确认时间未保存：%w", err)
	}
	setAppuseConfirmSeconds(seconds)
	return nil
}

// appuseConfirmCard 弹出这张卡；测试里换成不真的弹窗、直接当作能点的实现。
var appuseConfirmCard = butterflyConfirm

var appuseConfirmState struct {
	sync.Mutex
	owner    string    // 上次同意的是哪个会话
	at       time.Time // 上次同意的时间
	askAfter time.Time // 用户说「我在用」后的冷却截止
	answer   chan string
}

// appuseConfirmAsk 保证同一时刻只有一张确认卡在等答复。
var appuseConfirmAsk sync.Mutex

// appuseConfirmInput 在真正动鼠标键盘前问一次；返回空串表示可以开始，否则是本批未执行的原因。
func appuseConfirmInput(owner string) string {
	appuseConfirmAsk.Lock()
	defer appuseConfirmAsk.Unlock()
	state := &appuseConfirmState
	now := time.Now()
	state.Lock()
	if now.Before(state.askAfter) {
		left := int((state.askAfter.Sub(now) + time.Minute - 1) / time.Minute)
		state.Unlock()
		return fmt.Sprintf("用户刚说现在在用电脑：%d 分钟内不要再操作这台电脑，本批未执行；不要重试，先结束本轮并说明", left)
	}
	if state.owner == owner && now.Sub(state.at) < appuseConfirmReuse {
		state.at = now
		state.Unlock()
		return ""
	}
	state.Unlock()

	if !appuseConfirmCard() {
		// 蝴蝶被关掉或没有 WebView2：没有能作答的卡，按「不拒绝默认视为同意」直接开始。
		state.Lock()
		state.owner, state.at = owner, time.Now()
		state.Unlock()
		return ""
	}
	answer := make(chan string, 1)
	state.Lock()
	state.answer = answer
	state.Unlock()

	timer := time.NewTimer(appuseConfirmTimeout)
	choice := "allow"
	select {
	case choice = <-answer:
	case <-timer.C:
	}
	timer.Stop()
	butterflyHideNotice()

	state.Lock()
	state.answer = nil
	if choice == "reject" {
		state.owner, state.at = "", time.Time{}
		state.askAfter = time.Now().Add(appuseConfirmCool)
	} else {
		state.owner, state.at = owner, time.Now()
	}
	state.Unlock()
	if choice == "reject" {
		return "用户选了「我在用」：本批未执行，5 分钟内也不要再问这台电脑；不要重试，先结束本轮并说明"
	}
	return ""
}

// appuseConfirmAnswer 是蝴蝶卡上「现在接管 / 我在用」的答复入口。
func appuseConfirmAnswer(option string) {
	if option != "allow" && option != "reject" {
		return
	}
	state := &appuseConfirmState
	state.Lock()
	answer := state.answer
	state.Unlock()
	if answer == nil {
		return
	}
	select {
	case answer <- option:
	default:
	}
}
