package main

import "regexp"

const shellPolicyError = "禁止通过命令执行网页交互或控制真实桌面；允许在原绑定客户端用命令冷启动 Chrome（不携带导航 URL），随后必须通过 chrome 工具的扩展通道操作网页。网页填框和回车应使用 chrome 的 fill/type/press，员工主会话先 relay 到电脑会话。Chrome 已启动后扩展仍不可用，或需要原生对话框时请停止并交给用户处理，不得换脚本、编码、辅助程序或场景绕行。"

// shortcut: literal command checks are not a sandbox; use OS isolation to contain arbitrary executables.
var desktopAutomation = regexp.MustCompile(`(?i)` +
	`\b(?:user32(?:\.dll)?|Set(?:Physical)?CursorPos|SendInput|mouse_event|keybd_event|SetForegroundWindow|ShowWindow(?:Async)?|BringWindowToTop|SwitchToThisWindow|(?:Post|Send|SendNotify)Message[AW]?|SendKeys|AppActivate|WScript\.Shell|UIAutomation(?:Client|Types)?|System\.Windows\.(?:Automation|Forms\.(?:Cursor|SendKeys)))\b|` +
	`\b(?:pyautogui|pydirectinput|pynput|pywinauto|win32api|win32gui|AutoHotkey|AutoIt|xdotool|ydotool|wmctrl|cliclick|osascript|CGEventPost|AXUIElementPerformAction|robotjs|nut-js|webbrowser)\b|` +
	`(?:\b(?:Start-Process|saps|start|Invoke-Item|ii|xdg-open|open|gio[ \t]+open|rundll32(?:\.exe)?)\b[ \t]+|\bProcess\]::Start[ \t]*\()[^\r\n;|]*(?:https?://|file://|about:|chrome:|url\.dll[ \t]*,[ \t]*FileProtocolHandler)|` +
	`(?:^|[;&|(\r\n])[ \t]*&?[ \t]*(?:["'][^"'\r\n]*[\\/]|[^\s"';&|()]*[\\/])?["']?(?:chrome|msedge|firefox|brave|chromium|google-chrome)(?:\.exe)?["']?[ \t]+[^\r\n;|]*(?:https?://|file://|about:|chrome:)|` +
	`\b(?:selenium|playwright|puppeteer|chromedriver|msedgedriver|geckodriver|chrome-remote-interface|Input\.(?:dispatchMouseEvent|dispatchKeyEvent|insertText))\b|--remote-debugging-(?:port|pipe)\b|` +
	`-(?:enc|encodedcommand|encodedarguments)\b`)

func commandPolicyError(command string) string {
	if desktopAutomation.MatchString(command) {
		return shellPolicyError
	}
	return ""
}
