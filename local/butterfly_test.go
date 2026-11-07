package main

import (
	"strings"
	"testing"
)

// 蝴蝶提示只做两件事：让用户知道电脑正在被操作，以及在可能已部分执行时留着让他核对。
func TestButterflyNoticeKeepsReviewUntilCleared(t *testing.T) {
	butterflyQuiet = true
	defer func() { butterflyQuiet = false; butterflyClear() }()

	butterflyNotify("running", "正在用鼠标键盘操作这台电脑")
	if notice := butterflySnapshot(); notice == nil || notice.Kind != "running" {
		t.Fatalf("running notice missing: %+v", notice)
	}
	// 别的类别不能顺手清掉“正在操作”。
	butterflyClearIfKind("needs_review")
	if butterflySnapshot() == nil {
		t.Fatal("running notice cleared by an unrelated kind")
	}

	appuseAnnounce(map[string]any{"status": "needs_review", "reason": "输入可能已发出"})
	notice := butterflySnapshot()
	if notice == nil || notice.Kind != "needs_review" || !strings.Contains(notice.Text, "可能已经部分执行") || !strings.Contains(notice.Text, "输入可能已发出") {
		t.Fatalf("needs_review notice wrong: %+v", notice)
	}
	// 操作结束后到的那条结果不能把“待核对”抹掉。
	appuseAnnounce(map[string]any{"status": "executed"})
	if notice := butterflySnapshot(); notice == nil || notice.Kind != "needs_review" {
		t.Fatalf("review notice lost after a later executed result: %+v", notice)
	}

	butterflyClear()
	if butterflySnapshot() != nil {
		t.Fatal("notice survived clear")
	}
}

func TestAppuseLongReasonIsShortened(t *testing.T) {
	long := strings.Repeat("点", 400)
	if short := appuseShort(long); len([]rune(short)) != 121 || !strings.HasSuffix(short, "…") {
		t.Fatalf("unexpected shortening: %d runes", len([]rune(short)))
	}
	if short := appuseShort("ok"); short != "ok" {
		t.Fatalf("short text changed: %q", short)
	}
}
