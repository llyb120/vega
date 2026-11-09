package main

import (
	"testing"
	"time"
)

// quietConfirm 让确认走状态机但不动真实窗口，并返回一个“用户点了 / 到点了”的入口。
func quietConfirm(t *testing.T) {
	t.Helper()
	quiet, card, timeout := butterflyQuiet, appuseConfirmCard, appuseConfirmTimeout
	butterflyQuiet = true
	appuseConfirmCard = func() bool { return true }
	t.Cleanup(func() { butterflyQuiet, appuseConfirmCard, appuseConfirmTimeout = quiet, card, timeout })
	appuseConfirmState.Lock()
	appuseConfirmState.owner, appuseConfirmState.at, appuseConfirmState.askAfter = "", time.Time{}, time.Time{}
	appuseConfirmState.answer = nil
	appuseConfirmState.Unlock()
}

// confirmWaiting 报告确认卡是不是已经弹出来在等答复了。
func confirmWaiting() bool {
	appuseConfirmState.Lock()
	defer appuseConfirmState.Unlock()
	return appuseConfirmState.answer != nil
}

func TestAppuseConfirmStartsWhenNobodyAnswers(t *testing.T) {
	quietConfirm(t)
	appuseConfirmTimeout = 30 * time.Millisecond
	start := time.Now()
	if reason := appuseConfirmInput("s1"); reason != "" {
		t.Fatalf("不选就应当当作同意，却得到 %q", reason)
	}
	if time.Since(start) < appuseConfirmTimeout {
		t.Fatal("应当等满确认时间再开始")
	}
	// 同一个会话紧接着继续操作不再问、也不等。
	start = time.Now()
	if reason := appuseConfirmInput("s1"); reason != "" {
		t.Fatalf("同一个会话连续操作不该再问：%q", reason)
	}
	if time.Since(start) > appuseConfirmTimeout {
		t.Fatal("同一个会话不该再等一次确认")
	}
}

func TestAppuseConfirmRejectCoolsDownEverySession(t *testing.T) {
	quietConfirm(t)
	done := make(chan string, 1)
	go func() { done <- appuseConfirmInput("s1") }()
	for deadline := time.Now().Add(2 * time.Second); !confirmWaiting(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("确认卡一直没弹出来")
		}
	}
	appuseConfirmAnswer("reject")
	if reason := <-done; reason == "" {
		t.Fatal("用户选了「我在用」就不该开始操作电脑")
	}
	// 冷却期内换哪个会话都不再问，直接拒绝。
	if reason := appuseConfirmInput("s2"); reason == "" {
		t.Fatal("冷却期内不该再操作电脑")
	}
}
