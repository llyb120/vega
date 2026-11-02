import { assert } from "./util";

export const SHELL_POLICY_ERROR = "禁止通过命令执行控制浏览器或真实桌面；Chrome 只能通过 chrome 工具的扩展通道操作。扩展不可用或需要原生对话框时请停止并交给用户处理，不得换脚本、编码、辅助程序或场景绕行。";

// shortcut: literal command checks are not a sandbox; use OS isolation to contain arbitrary executables.
const desktopAutomation = new RegExp([
  String.raw`\b(?:user32(?:\.dll)?|Set(?:Physical)?CursorPos|SendInput|mouse_event|keybd_event|SetForegroundWindow|ShowWindow(?:Async)?|BringWindowToTop|SwitchToThisWindow|(?:Post|Send|SendNotify)Message[AW]?|SendKeys|AppActivate|WScript\.Shell|UIAutomation(?:Client|Types)?|System\.Windows\.(?:Automation|Forms\.(?:Cursor|SendKeys)))\b`,
  String.raw`\b(?:pyautogui|pydirectinput|pynput|pywinauto|win32api|win32gui|AutoHotkey|AutoIt|xdotool|ydotool|wmctrl|cliclick|osascript|CGEventPost|AXUIElementPerformAction|robotjs|nut-js)\b`,
  String.raw`\b(?:selenium|playwright|puppeteer|chromedriver|msedgedriver|geckodriver|chrome-remote-interface|Input\.(?:dispatchMouseEvent|dispatchKeyEvent|insertText))\b|--remote-debugging-(?:port|pipe)\b`,
  String.raw`-(?:enc|encodedcommand|encodedarguments)\b`,
].join("|"), "i");

export function assertShellCommand(command: string) {
  assert(!desktopAutomation.test(command), SHELL_POLICY_ERROR);
}
