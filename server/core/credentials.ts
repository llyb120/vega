import { assert } from "./util";

export function vaultSite(value: unknown): string {
  assert(typeof value === "string" && value.length <= 2048, "网站地址必须是 2048 字符以内的 HTTP(S) 地址");
  const text = value.trim();
  if (!text) return "";
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : "https://" + text); }
  catch { throw Error("网站地址无效，请填写实际登录页面的 HTTP(S) 地址"); }
  assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hostname.includes("*"), "网站地址必须使用 HTTP(S)，且不能包含账号密码或通配符");
  return url.origin;
}

export function assertCredentialInput(text: unknown) {
  assert(typeof text !== "string" || !/\[(?:credential )?redacted\]|\[withheld from transcript[^\]]*\]|__stored_secret__/i.test(text), "输入含脱敏占位符，不是真实凭据；本次未输入。请针对当前登录页面重新读取密码本，不能从历史记录复制占位符。");
}

/** Extract common credential formats without guessing a website from secret content. */
export function credentialValues(content: string): string[] {
  const values = new Set<string>([content]);
  const add = (value: string) => { if (value.trim()) values.add(value.trim()); };
  try {
    const visit = (value: any) => {
      if (typeof value === "string") add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) if (!/^(url|site|website|host|name|condition|description)$/i.test(key)) visit(child);
    };
    visit(JSON.parse(content));
  } catch {
    for (const line of content.split(/\r?\n/)) {
      add(line);
      const match = /^(?:user(?:name)?|account|login|email|password|passwd|pwd|token|api[\s_-]?key|secret|账号|帐号|账户|帐户|用户名|邮箱|密码|口令|密钥)\s*[:：=]\s*(.+)$/i.exec(line.trim());
      if (match) add(match[1].replace(/^(['"])(.*)\1$/, "$2"));
    }
  }
  return [...values].filter(Boolean);
}

// Scope comes from this execution's observed page, not a website field in the vault.
export type CredentialBinding = { site: string; values: string[] };

export function credentialOrigins(text: unknown, bindings: CredentialBinding[]) {
  assertCredentialInput(text);
  const matches = new Map<string, Set<string>>();
  if (typeof text !== "string") return [];
  for (const binding of bindings) for (const value of binding.values) {
    if (!(value.length >= 4 ? text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)) : text === value)) continue;
    let sites = matches.get(value);
    if (!sites) matches.set(value, sites = new Set());
    if (binding.site) sites.add(binding.site);
  }
  return [...matches.values()];
}
