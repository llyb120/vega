export type ContextRule = { keyword: string; context: number };
export type ContextRuleDraft = { keyword: string; context: string };

export function parseContextTokens(text: string): number | null {
  const match = /^(\d+)(k)?$/i.exec(text.trim());
  const tokens = match ? Number(match[1]) * (match[2] ? 1000 : 1) : NaN;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

export function validateContextRules(value: unknown): ContextRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Error("contextRules 必须是数组");
  return value.map((rule, index) => {
    if (
      !rule || typeof rule !== "object" || Array.isArray(rule) ||
      Object.keys(rule).some((key) => !["keyword", "context"].includes(key)) ||
      typeof rule.keyword !== "string" || !rule.keyword.trim() ||
      !Number.isSafeInteger(rule.context) || rule.context < 1024
    ) throw Error(`上下文规则 ${index + 1} 需要非空关键词和至少 1024 tokens 的整数窗口（如 100k / 100000）`);
    return { keyword: rule.keyword.trim(), context: rule.context };
  });
}

export function serializeContextRules(rules: ContextRuleDraft[]): ContextRule[] {
  return validateContextRules(rules.map((rule) => ({
    keyword: rule.keyword.trim(), context: parseContextTokens(rule.context),
  })));
}

// 自动目录中的窗口不是手动覆盖；只标记来源，不改写原始窗口。
export function catalogContextModels(models: Record<string, any> = {}): Record<string, any> {
  return Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { ...model, contextSource: "catalog" }]));
}

export function modelContext(provider: { contextRules?: unknown }, id: string, model: Record<string, any>) {
  const rules = validateContextRules(provider.contextRules);
  // 旧配置未记录来源时按手填保留，避免覆盖已有显式窗口。
  const explicit = model.contextSource !== "catalog" && (model.limit?.context || model.contextWindow);
  if (explicit) return { context: explicit as number, source: "manual", keyword: undefined };
  const name = String(model.name || "").toLowerCase(), key = id.toLowerCase();
  const rule = rules.find(({ keyword }) => {
    const word = keyword.toLowerCase();
    return key.includes(word) || name.includes(word);
  });
  return {
    context: (rule?.context || model.limit?.context || model.contextWindow || 200000) as number,
    source: rule ? "rule" : "catalog",
    keyword: rule?.keyword,
  };
}
