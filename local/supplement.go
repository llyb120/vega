package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func validateSupplement(text string) error {
	if len(text) > 8192 || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return fmt.Errorf("补充内容最多 8192 字节，且不能包含无效字符")
	}
	return nil
}

func (a *Agent) editSupplement(edit func(string) (string, bool, error)) error {
	a.mu.Lock()
	if a.editing || a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在编辑补充内容或安装更新，请稍后再试")
	}
	a.editing = true
	current := a.config.Supplement
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.editing = false
		a.mu.Unlock()
	}()
	text, confirmed, err := edit(current)
	if err != nil || !confirmed {
		return err
	}
	if err = validateSupplement(text); err != nil {
		return err
	}
	if text == current {
		return nil
	}
	a.mu.Lock()
	next := a.config
	next.Supplement = text
	if err = a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("补充内容未保存：%w", err)
	}
	a.config = next
	runners := make([]*jobRunner, 0, len(a.direct))
	for _, connection := range a.direct {
		runner := connection.jobs
		runner.mu.Lock()
		runner.supplement = text
		runner.mu.Unlock()
		runners = append(runners, runner)
	}
	a.mu.Unlock()
	for _, runner := range runners {
		runner.mu.Lock()
		runner.write(map[string]string{"type": "ping", "supplement": runner.supplement})
		runner.mu.Unlock()
	}
	return nil
}
