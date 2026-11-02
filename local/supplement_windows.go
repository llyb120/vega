//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const supplementDialogScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = '牵牛星 · 补充内容'
$form.Font = [Drawing.SystemFonts]::MessageBoxFont
$form.AutoScaleMode = 'Font'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = [Drawing.Size]::new(560, 340)
$form.MinimumSize = [Drawing.Size]::new(400, 280)
$form.Padding = [Windows.Forms.Padding]::new(12)
$label = [Windows.Forms.Label]::new()
$label.Dock = 'Top'
$label.Height = 48
$label.Text = '例如：本地项目目录 D:\code\my-project。内容会发送给已授权的 Vega 站点作为辅助提示，不会自动切换工作目录；请勿填写密码或密钥。'
$inputBox = [Windows.Forms.TextBox]::new()
$inputBox.Dock = 'Fill'
$inputBox.Multiline = $true
$inputBox.AccessibleName = '补充内容'
$inputBox.AccessibleDescription = $label.Text
$inputBox.AcceptsReturn = $true
$inputBox.ScrollBars = 'Vertical'
$inputBox.MaxLength = 8192
$inputBox.Text = [Console]::In.ReadToEnd()
$buttons = [Windows.Forms.FlowLayoutPanel]::new()
$buttons.Dock = 'Bottom'
$buttons.Height = 40
$buttons.Padding = [Windows.Forms.Padding]::new(0, 8, 0, 0)
$buttons.FlowDirection = 'RightToLeft'
$cancel = [Windows.Forms.Button]::new()
$cancel.Text = '取消'
$cancel.DialogResult = 'Cancel'
$save = [Windows.Forms.Button]::new()
$save.Text = '保存'
$save.Add_Click({
    if ([Text.Encoding]::UTF8.GetByteCount($inputBox.Text) -gt 8192) {
        [void][Windows.Forms.MessageBox]::Show('补充内容最多 8192 字节，请精简后再保存。', '补充内容过长', 'OK', 'Warning')
        return
    }
    $form.DialogResult = 'OK'
    $form.Close()
})
$buttons.Controls.Add($cancel)
$buttons.Controls.Add($save)
$form.Controls.Add($inputBox)
$form.Controls.Add($buttons)
$form.Controls.Add($label)
$form.AcceptButton = $save
$form.CancelButton = $cancel
$form.Add_Shown({ [void]$inputBox.Focus() })
$confirmed = $form.ShowDialog() -eq 'OK'
[Console]::Out.Write((@{confirmed = $confirmed; text = $inputBox.Text} | ConvertTo-Json -Compress))
$form.Dispose()
`

func promptSupplement(current string) (string, bool, error) {
	cmd := exec.CommandContext(context.Background(), "powershell.exe", "-NoLogo", "-NoProfile", "-STA", "-Command", supplementDialogScript)
	cmd.Stdin = strings.NewReader(current)
	configureCommand(cmd)
	cmd.SysProcAttr.HideWindow = false // CREATE_NO_WINDOW hides the console, not the input dialog.
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", false, fmt.Errorf("无法打开补充内容输入框：%w\n%s", err, output)
	}
	var result struct {
		Confirmed bool   `json:"confirmed"`
		Text      string `json:"text"`
	}
	if err = json.Unmarshal(output, &result); err != nil {
		return "", false, fmt.Errorf("无法读取补充内容：%w", err)
	}
	return result.Text, result.Confirmed, nil
}

func reportSupplementError(err error) {
	fmt.Fprintln(os.Stderr, "vega-local:", err)
	cmd := exec.CommandContext(context.Background(), "powershell.exe", "-NoLogo", "-NoProfile", "-STA", "-Command", `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; [void][Windows.Forms.MessageBox]::Show([Console]::In.ReadToEnd(), '补充内容未保存', 'OK', 'Error')`)
	cmd.Stdin = strings.NewReader(err.Error())
	configureCommand(cmd)
	cmd.SysProcAttr.HideWindow = false
	_ = cmd.Run()
}
