package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// 桌面操作（appuse）只有 Windows 客户端有；测试里可以覆盖这个入口。
var browserExtensionInstallSupported = func() bool { return runtime.GOOS == "windows" }

// installExtension 把内置扩展解压到本机，再请站点把安装这件事交给一个牛马：
// 站点侧校验「本机是接管的主控客户端 / 客户端优先 / 有可用牛马」，不满足会回可直接照做的提示。
func (a *Agent) installExtension() error {
	if !browserExtensionInstallSupported() {
		return fmt.Errorf("浏览器扩展自动安装只支持 Windows 客户端：牛马要在这台电脑上用真实鼠标键盘操作 Chrome")
	}
	a.mu.Lock()
	origin, token := "", ""
	for _, saved := range a.config.Servers {
		revealed, err := unprotectToken(saved.Token)
		if err == nil && revealed != "" && saved.Origin != "" {
			origin, token = saved.Origin, revealed
			break
		}
	}
	a.mu.Unlock()
	if origin == "" || token == "" {
		return fmt.Errorf("这台电脑还没和站点配对：先在同一台电脑的浏览器打开站点完成连接授权，再点一次")
	}
	dir, err := a.writeBundledExtension()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"path": dir})
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, origin+"/api/local-agent/extension", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("安装请求无效：%w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("连不上站点，安装任务未发起：%w", err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusOK {
		// 站点回的是给人看的提示（没有可用牛马 / 本机待命 / 执行位置成了服务端优先），原样交给用户。
		var failure struct {
			StatusMessage string `json:"statusMessage"`
			Message       string `json:"message"`
			Error         string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		reason := firstText(failure.StatusMessage, failure.Message, failure.Error, string(data))
		if reason == "" {
			return fmt.Errorf("站点拒绝了安装请求：HTTP %d", response.StatusCode)
		}
		return fmt.Errorf("%s", clipText(reason, 500))
	}
	var result struct {
		Employee   string `json:"employee"`
		EmployeeID string `json:"employeeId"`
	}
	if err = json.Unmarshal(data, &result); err != nil {
		return fmt.Errorf("站点响应无法解析：%w", err)
	}
	if strings.TrimSpace(result.Employee) == "" {
		result.Employee = "牛马"
	}
	a.mu.Lock()
	a.lastExtension = fmt.Sprintf("已把安装/更新浏览器扩展的任务交给牛马「%s」。扩展目录：%s。进展在它的对话里；点击本身不代表已经装好。", result.Employee, dir)
	message := a.lastExtension
	a.mu.Unlock()
	a.clientLog("安装浏览器扩展：%s", message)
	return nil
}

// firstText 返回第一个非空的候选（站点可能用 statusMessage、message 或纯文本 body）。
func firstText(values ...string) string {
	for _, value := range values {
		if text := strings.TrimSpace(value); text != "" {
			return text
		}
	}
	return ""
}

// clipText 按字符截断，避免把整页 HTML 当成错误提示。
func clipText(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
