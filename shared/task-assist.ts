/**
 * Structured user-assistance metadata for tasks in `waiting` state.
 * Shared between server tools/state and Vue UI components.
 */

export const ASSIST_KINDS = [
  "general",
  "choice",
  "qr_login",
  "browser_action",
  "verification",
  "form",
  "settings",
] as const;

export type TaskAssistKind = (typeof ASSIST_KINDS)[number];

export const ASSIST_SETTINGS_ROUTES = [
  "scenes",
  "vault",
  "external-mcp",
  "principles",
  "triggers",
] as const;

export type TaskAssistSettingsRoute = (typeof ASSIST_SETTINGS_ROUTES)[number];

export type TaskAssistOption = {
  id?: string;
  label: string;
  value?: string;
  description?: string;
  recommended?: boolean;
  tone?: "default" | "primary" | "danger";
  needsDetail?: boolean;
};

export type TaskAssistField = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "code" | "select" | "checkbox";
  placeholder?: string;
  description?: string;
  required?: boolean;
  defaultValue?: string | boolean;
  options?: string[];
};

export type TaskAssistAction = {
  label: string;
  reply: string;
  tone?: "primary" | "default" | "danger";
};

export type TaskAssistBrowser = {
  tabTag?: string;
  url?: string;
  title?: string;
};

export type TaskAssistImage = {
  url: string;
  caption?: string;
  capturedAt?: number;
  volatile?: boolean;
};

export type TaskAssist = {
  kind?: TaskAssistKind;
  title?: string;
  hint?: string;
  options?: TaskAssistOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  fields?: TaskAssistField[];
  images?: TaskAssistImage[];
  browser?: TaskAssistBrowser;
  quickActions?: TaskAssistAction[];
  externalUrl?: { url: string; label?: string };
  settingsRoute?: TaskAssistSettingsRoute;
  settingsLabel?: string;
  capturedAt?: number;
};

export type BrowserAssistContext = {
  tabTag?: string;
  url?: string;
  title?: string;
  screenshotUrl?: string;
  capturedAt?: number;
};

export function defaultAssistTitle(kind?: TaskAssistKind): string {
  switch (kind) {
    case "qr_login":
      return "需要扫码登录";
    case "choice":
      return "需要你做决定";
    case "browser_action":
      return "需要你在浏览器中操作";
    case "verification":
      return "需要提供验证码";
    case "form":
      return "需要补充以下信息";
    case "settings":
      return "需要完成相关配置";
    default:
      return "需要补充信息";
  }
}

export function defaultAssistHint(assist?: TaskAssist): string {
  if (!assist) return "";
  if (assist.kind === "qr_login") {
    return "二维码通常具有时效性，因时间原因当前截图可能已过期；如扫码提示失效，请点击下方按钮前往浏览器标签页刷新或直接操作。";
  }
  if (assist.kind === "browser_action") {
    return "请前往对应浏览器标签页完成操作，完成后点击下方按钮通知热心市民继续。";
  }
  if (assist.images?.some((img) => img.volatile)) {
    return "当前截图内容可能随时间失效，如已过期请前往浏览器标签页查看最新画面。";
  }
  return "";
}

export function defaultQuickActions(assist?: TaskAssist): TaskAssistAction[] {
  if (assist?.quickActions?.length) return assist.quickActions;
  switch (assist?.kind) {
    case "qr_login":
      return [
        { label: "我已扫码完成，继续任务", reply: "我已完成扫码登录，请继续原任务", tone: "primary" },
        { label: "二维码已过期，重新截图", reply: "二维码已过期，请刷新页面并重新截图发给我", tone: "default" },
      ];
    case "browser_action":
      return [
        { label: "我已操作完成，继续任务", reply: "我已在浏览器中完成操作，请继续原任务", tone: "primary" },
      ];
    case "settings":
      return [
        { label: "我已配置完成，继续任务", reply: "我已完成配置，请继续原任务", tone: "primary" },
      ];
    case "verification":
      return [
        { label: "未收到，请重新发送", reply: "未收到验证码，请帮我重新发送一次", tone: "default" },
      ];
    default:
      return [];
  }
}

export function defaultSettingsLabel(route?: TaskAssistSettingsRoute): string {
  switch (route) {
    case "scenes":
      return "前往设置 · 场景模型";
    case "vault":
      return "前往设置 · 密码本";
    case "external-mcp":
      return "前往设置 · 外部 MCP";
    case "principles":
      return "前往设置 · 工作原则";
    case "triggers":
      return "前往设置 · 触发器";
    default:
      return "前往设置";
  }
}

/** Validate an external URL (http/https only, no embedded credentials). */
export function safeExternalUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function extractMarkdownImageUrls(text: string): string[] {
  const source = String(text || "");
  if (!source.includes("![")) return [];
  const urls: string[] = [];
  const pattern = /!\[[^\]\n]*\]\([ \t]*(?:<([^<>\n]+)>|((?:\\[()\\]|[^()\s\\]|\([^()\s]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/g;
  for (const match of source.matchAll(pattern)) {
    const dest = (match[1] || match[2] || "").replace(/\\([()\\])/g, "$1").trim();
    if (dest && (/^\/api\/(?:files|blobs)\//.test(dest) || /^sqlite:blob\//.test(dest))) {
      urls.push(dest);
    }
  }
  return [...new Set(urls)];
}

export type FormatAssistInput = {
  selectedOptions?: number[];
  fieldValues?: Record<string, string | boolean>;
  verificationCode?: string;
  customText?: string;
};

export type FormatAssistResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Format structured option/form/code/custom answers into the final reply string sent to employee.control("answer"). */
export function formatAssistAnswer(
  assist: TaskAssist | undefined,
  input: FormatAssistInput,
): FormatAssistResult {
  const options = assist?.options || [];
  const fields = assist?.fields || [];
  const selectedIndices = [...new Set((input.selectedOptions || []).filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))];
  const chosen = selectedIndices.map((i) => options[i]!);
  const custom = String(input.customText || "").trim();
  const code = String(input.verificationCode || "").trim();

  if (chosen.some((opt) => opt.needsDetail) && !custom && !code) {
    return { ok: false, error: "所选选项需要补充具体说明" };
  }

  const fieldLines: string[] = [];
  for (const field of fields) {
    const raw = input.fieldValues?.[field.key];
    if (field.type === "checkbox") {
      if (field.required && raw !== true) {
        return { ok: false, error: `请勾选必填项：${field.label}` };
      }
      if (raw === true || raw === false) {
        fieldLines.push(`${field.label}：${raw ? "是" : "否"}`);
      }
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (field.required && !text) {
      return { ok: false, error: `请填写必填项：${field.label}` };
    }
    if (text) {
      fieldLines.push(`${field.label}：${text}`);
    }
  }

  // Exact single-option submission (preserves SETTLE_CHOICE "1" contract when value is set and no extra text is added).
  if (!assist?.multiSelect && chosen.length === 1 && !fieldLines.length && !code && !custom) {
    const opt = chosen[0]!;
    const out = String(opt.value || opt.label).trim();
    if (!out) return { ok: false, error: "请补充有效回复" };
    return out.length > 8000 ? { ok: false, error: "回复内容不能超过 8000 字" } : { ok: true, text: out };
  }

  const parts: string[] = [];
  if (chosen.length === 1) {
    const opt = chosen[0]!;
    const main = opt.value && opt.value !== opt.label ? `${opt.label} (${opt.value})` : opt.label;
    parts.push(`选择：${main}`);
  } else if (chosen.length > 1) {
    const list = chosen.map((opt) => (opt.value && opt.value !== opt.label ? `${opt.label} (${opt.value})` : opt.label)).join("；");
    parts.push(`选择：${list}`);
  }
  if (code) {
    parts.push(fields.length || chosen.length ? `验证码：${code}` : code);
  }
  if (fieldLines.length) {
    parts.push(fieldLines.join("\n"));
  }
  if (custom) {
    parts.push(parts.length ? `补充说明：${custom}` : custom);
  }

  const combined = parts.join("\n").trim();
  if (!combined) {
    return { ok: false, error: options.length ? "请至少选择一项或填写回复" : "请填写需要补充的信息" };
  }
  if (combined.length > 8000) {
    return { ok: false, error: "回复内容不能超过 8000 字" };
  }
  return { ok: true, text: combined };
}

/** Conservative fallback inference when the model invokes plain task_ask_user({ question }) without structured fields. */
export function inferAssistFromText(
  question: string,
  browserCtx?: BrowserAssistContext,
): Partial<TaskAssist> {
  const text = String(question || "");
  if (/computer\s*场景未配置模型/i.test(text)) {
    return {
      kind: "settings",
      settingsRoute: "scenes",
      settingsLabel: "前往配置电脑场景模型",
    };
  }
  if (/(?:去|到|前往|打开).*密码本|密码本.*(?:添加|配置|补充|录入)/.test(text)) {
    return {
      kind: "settings",
      settingsRoute: "vault",
      settingsLabel: "前往密码本配置",
    };
  }
  const hasQrCue = /扫码|二维码|QR\s*code|扫一扫/i.test(text);
  const hasCodeCue = /短信验证码|邮箱验证码|图形验证码|验证码|访问码|2FA|OTP|动态口令/i.test(text);
  const hasBrowserCue = /在浏览器|浏览器标签页|手动登录|页面上完成|人机验证|原生对话框|登录后继续|滑块验证/i.test(text);

  if (hasQrCue && (browserCtx?.tabTag || browserCtx?.url || browserCtx?.screenshotUrl || extractMarkdownImageUrls(text).length > 0)) {
    return { kind: "qr_login" };
  }
  if (hasQrCue) {
    return { kind: "qr_login" };
  }
  if (hasCodeCue) {
    return { kind: "verification" };
  }
  if (hasBrowserCue && (browserCtx?.tabTag || browserCtx?.url || browserCtx?.screenshotUrl)) {
    return { kind: "browser_action" };
  }
  return {};
}
