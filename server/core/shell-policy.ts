import { assert } from "./util";

export const SHELL_POLICY_ERROR = "禁止通过命令执行网页交互或控制真实桌面；允许在原绑定客户端用命令冷启动 Chrome（不携带导航 URL），随后必须通过 browser_* 工具的扩展通道操作网页。网页填框和回车应使用 browser_act 的 fill/type/press，员工主会话先 switch_scene(scene=computer)。Chrome 已启动后扩展仍不可用，或需要原生对话框时请停止并交给用户处理，不得换脚本、编码、辅助程序或场景绕行。";

// shortcut: literal command checks are not a sandbox; use OS isolation to contain arbitrary executables.
const desktopAutomation = new RegExp([
  String.raw`\b(?:user32(?:\.dll)?|Set(?:Physical)?CursorPos|SendInput|mouse_event|keybd_event|SetForegroundWindow|ShowWindow(?:Async)?|BringWindowToTop|SwitchToThisWindow|(?:Post|Send|SendNotify)Message[AW]?|SendKeys|AppActivate|WScript\.Shell|UIAutomation(?:Client|Types)?|System\.Windows\.(?:Automation|Forms\.(?:Cursor|SendKeys)))\b`,
  String.raw`\b(?:pyautogui|pydirectinput|pynput|pywinauto|win32api|win32gui|AutoHotkey|AutoIt|xdotool|ydotool|wmctrl|cliclick|osascript|CGEventPost|AXUIElementPerformAction|robotjs|nut-js|webbrowser)\b`,
  String.raw`(?:\b(?:Start-Process|saps|start|Invoke-Item|ii|xdg-open|open|gio[ \t]+open|rundll32(?:\.exe)?)\b[ \t]+|\bProcess\]::Start[ \t]*\()[^\r\n;|]*(?:https?://|file://|about:|chrome:|url\.dll[ \t]*,[ \t]*FileProtocolHandler)`,
  String.raw`(?:^|[;&|(\r\n])[ \t]*&?[ \t]*(?:["'][^"'\r\n]*[\\/]|[^\s"';&|()]*[\\/])?["']?(?:chrome|msedge|firefox|brave|chromium|google-chrome)(?:\.exe)?["']?[ \t]+[^\r\n;|]*(?:https?://|file://|about:|chrome:)`,
  String.raw`\b(?:selenium|playwright|puppeteer|chromedriver|msedgedriver|geckodriver|chrome-remote-interface|Input\.(?:dispatchMouseEvent|dispatchKeyEvent|insertText))\b|--remote-debugging-(?:port|pipe)\b`,
  String.raw`-(?:enc|encodedcommand|encodedarguments)\b`,
].join("|"), "i");

// Extracts an explicit leading target directory for workspace locking and rejects relative/wrong-platform
// directory changes (`cd` / `Set-Location` / `git -C`). Pathless, piped, and compound commands return null
// and fall back to device-scoped locking.
export function explicitShellDirectory(command: string, windows: boolean): string | null {
  const script = command.trim().replace(/^set(?:[ \t]+(?:-[a-z]+(?:[ \t]+[a-z]+)?))+[ \t]*(?:&&|;|\r?\n)\s*/, "");
  const absolute = windows ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i : /^\//;
  const error = "切换目录（cd / Set-Location / git -C）必须使用执行端的绝对路径，不依赖隐式当前目录。本步未执行";
  const prefix = /^(?:cd[ \t]+(?:-[LP][ \t]+)?(?:--[ \t]+)?|Set-Location[ \t]+(?:-LiteralPath[ \t]+|-Path[ \t]+)?|git[ \t]+-C[ \t]+)/i.exec(script);
  if (prefix) {
    const arg = /^(?:'([^']+)'|"([^"$`]+)"|([^\s;&|"'$`]+))(?=$|[\s;&|])/.exec(script.slice(prefix[0].length));
    const path = arg && (arg[1] || arg[2] || arg[3]);
    assert(path && absolute.test(path), error);
    return path;
  }
  return null;
}

export function assertShellCommand(command: string) {
  assert(!desktopAutomation.test(command), SHELL_POLICY_ERROR);
}
