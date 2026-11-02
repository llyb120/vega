export function validateMcpServer(config: any, name: string) {
  const check = (ok: unknown, message: string) => {
    if (!ok) throw Error(`MCP「${name}」: ${message}`);
  };
  check(config && typeof config === "object" && !Array.isArray(config), "配置必须为 JSON 对象");
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  check((config.command !== undefined) !== (config.url !== undefined), "MCP requires exactly one command or URL");
  if (config.command !== undefined) check(text(config.command), "command 必须为非空字符串");
  if (config.url !== undefined) {
    check(text(config.url), "url 必须为 HTTP(S) 地址");
    let url: URL;
    try { url = new URL(config.url); }
    catch { throw Error(`MCP「${name}」: url 必须为 HTTP(S) 地址`); }
    check(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, "url 必须为不含凭据的 HTTP(S) 地址");
  }
  if (config.args !== undefined) check(Array.isArray(config.args) && config.args.every((v: unknown) => typeof v === "string"), "args 必须为字符串数组");
  for (const key of ["env", "headers"]) {
    const value = config[key];
    if (value !== undefined) check(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string"), `${key} 必须为字符串键值对象`);
  }
  if (config.cwd !== undefined) check(text(config.cwd), "cwd 必须为非空字符串");
  if (config.enabled !== undefined) check(typeof config.enabled === "boolean", "enabled 必须为布尔值");
  if (config.startupTimeoutMs !== undefined) check(Number.isSafeInteger(config.startupTimeoutMs) && config.startupTimeoutMs > 0, "startupTimeoutMs 必须为正整数");
}
