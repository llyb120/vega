import type { Obj } from "./util";
import { assert, expand, httpURL, object, clone } from "./util";
import { validateMcpServer } from "../../shared/mcp-config";
import { modelContext, validateContextRules } from "../../shared/context-rules";
export type SchedulerConfig = {
  /** Site-wide max concurrently running employee tasks. Default 3. */
  globalSlots?: number;
  /** Per-employee max concurrently running tasks. Default 3. */
  perEmployeeSlots?: number;
};
export type SceneModelRow = string | { model: string; allowSpawn?: boolean };
export type SceneModelSelection = { model: string; allowSpawn: boolean };
export type Config = {
  model: string;
  provider: Record<string, Obj>;
  scenes?: Record<string, SceneModelRow[]>;
  systemPrompt?: string;
  contextMode?: string;
  mcp?: Record<string, Obj>;
  skills?: Obj[];
  employeeId?: string;
  skillsDirectory?: string;
  ponytail?: string;
  scheduler?: SchedulerConfig;
};
export const DEFAULT_GLOBAL_SLOTS = 3;
export const DEFAULT_PER_EMPLOYEE_SLOTS = 3;
/** Clamp scheduler slot settings; invalid values fall back to defaults. */
export function schedulerLimits(config: { scheduler?: SchedulerConfig } | null | undefined) {
  const clamp = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 64 ? n : fallback;
  };
  return {
    global: clamp(config?.scheduler?.globalSlots, DEFAULT_GLOBAL_SLOTS),
    perEmployee: clamp(config?.scheduler?.perEmployeeSlots, DEFAULT_PER_EMPLOYEE_SLOTS),
  };
}
export type Model = {
  selection: string;
  provider: string;
  id: string;
  api: string;
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  reasoning?: boolean;
  localAuth?: string;
  options: Obj;
};
export function modelEntries(models: Obj, prefix = ""): Record<string, Obj> {
  const result: Record<string, Obj> = {};
  for (const [key, v] of Object.entries(models || {})) {
    const row = object(v);
    if (
      !Object.keys(row).length ||
      [
        "name",
        "api",
        "reasoning",
        "modalities",
        "limit",
        "options",
        "variants",
        "contextWindow",
        "contextSource",
        "supportsImages",
      ].some((k) => k in row)
    )
      result[prefix + key] = row;
    else Object.assign(result, modelEntries(row, prefix + key + "/"));
  }
  return result;
}
export const protocols = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "codebuddy",
  "devin",
];

export const SCENE_KEYS = ["lightweight", "coding", "computer"] as const;
export function isDeepseekFlash(modelId: string) {
  const id = String(modelId || "").toLowerCase();
  return id.includes("deepseek") && id.includes("flash");
}
export function variantLabel(variant: string) {
  return variant === "niu-m" ? "Epic" : variant;
}
/** Normalize a scene row from the legacy string or { model, allowSpawn? } shape. */
export function sceneModelSelection(row: SceneModelRow | null | undefined, scene?: string): SceneModelSelection | undefined {
  if (row == null) return;
  const model = typeof row === "string" ? row.trim() : String((row as any).model || "").trim();
  if (!model) return;
  const allowSpawn = scene !== "computer" && typeof row === "object" && !!(row as any).allowSpawn;
  return { model, allowSpawn };
}
export function sceneModelRows(config: Config | { scenes?: Record<string, SceneModelRow[]> } | null | undefined, scene: string): SceneModelSelection[] {
  const ids = config?.scenes?.[scene];
  return Array.isArray(ids) ? ids.map((row) => sceneModelSelection(row, scene)).filter((row): row is SceneModelSelection => !!row) : [];
}
export function sceneModels(config: Config, scene: string): string[] {
  return sceneModelRows(config, scene).map((row) => row.model);
}
export function sceneAllowSpawn(config: Config, scene: string, selection?: string) {
  if (scene === "computer") return false;
  const rows = sceneModelRows(config, scene);
  const row = selection ? rows.find((item) => item.model === selection) : rows[0];
  return !!row?.allowSpawn;
}
export function requireSceneModel(config: Config, scene: string): string {
  const id = sceneModels(config, scene)[0];
  assert(id, `场景「${scene}」未配置模型，请在设置里为该场景选择模型后再运行（不再使用默认模型回退）`);
  return id;
}
export function resolveModel(config: Config, selection = config.model): Model {
  assert(
    typeof selection === "string" && selection.includes("/"),
    "Select a configured provider/model",
  );
  const [base, variant] = selection.split("/variant/");
  const index = base.indexOf("/"),
    provider = base.slice(0, index),
    key = base.slice(index + 1),
    p = config.provider?.[provider];
  assert(p, `Provider not found: ${provider}`);
  const m = modelEntries(p.models)[key];
  assert(m, `Model not found: ${base}`);
  const modelId = String(m.localModel || key);
  const epic = variant === "niu-m" && isDeepseekFlash(modelId);
  assert(
    !variant || m.variants?.[variant] || epic,
    `Variant not configured: ${variant}`,
  );
  const opts = {
    ...object(p.options),
    ...object(m.options),
    ...object(m.variants?.[variant]),
    ...(epic ? { reasoningEffort: "max" } : {}),
  } as Record<string, any>;
  const api =
    m.api ||
    p.api ||
    (String(p.npm).includes("anthropic")
      ? "anthropic-messages"
      : "openai-completions");
  assert(protocols.includes(api), `Unsupported protocol ${api}`);
  let baseURL = expand(opts.baseURL || opts.baseUrl || p.baseURL || "");
  if (p.localAuth === "codex")
    baseURL = "https://chatgpt.com/backend-api/codex";
  if (p.localAuth === "claude-code") baseURL = "https://api.anthropic.com";
  httpURL(baseURL);
  const contextWindow = modelContext(p, key, m).context,
    maxOutputTokens = m.limit?.output || m.maxOutputTokens || 32000;
  assert(
    Number.isSafeInteger(contextWindow) &&
      Number.isSafeInteger(maxOutputTokens) &&
      contextWindow >= 1024 &&
      maxOutputTokens >= 1,
    "Invalid model token limits",
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...p.headers,
    ...p.options?.headers,
    ...m.options?.headers,
    ...m.variants?.[variant || ""]?.headers,
    ...m.headers,
  })) {
    if (v === null) continue;
    assert(
      typeof v === "string" && !/[\r\n]/.test(v),
      "Invalid provider headers",
    );
    headers[k] = expand(v);
  }
  return {
    selection,
    provider,
    id: m.localModel || key,
    api,
    baseURL: baseURL.replace(/\/$/, ""),
    apiKey: expand(opts.apiKey || p.apiKey || ""),
    headers,
    contextWindow,
    maxOutputTokens,
    reasoning: m.reasoning ?? Object.keys(m.variants || {}).length > 0,
    supportsImages:
      m.supportsImages ?? m.modalities?.input?.includes("image") ?? false,
    localAuth: p.localAuth,
    options: opts,
  };
}
export function validateConfig(c: Config) {
  for (const p of Object.values(c.provider || {})) validateContextRules(p.contextRules);
  if (c.model) resolveModel(c);
  assert(
    !c.contextMode || ["auto", "acp"].includes(c.contextMode),
    "contextMode must be auto or acp",
  );
  for (const [scene, models] of Object.entries(c.scenes || {})) {
    assert(
      ["lightweight", "coding", "computer"].includes(scene) &&
        Array.isArray(models),
      "Invalid scene",
    );
    for (const row of models) {
      assert(
        scene !== "computer" || typeof row !== "object" || !row || !(row as any).allowSpawn,
        "Computer scene cannot enable 分身",
      );
      const selection = sceneModelSelection(row, scene);
      if (!selection) continue;
      const m = resolveModel(c, selection.model);
      assert(
        scene !== "computer" || m.supportsImages,
        "Computer scene must support images",
      );
    }
  }
  assert(c.mcp === undefined || (c.mcp && typeof c.mcp === "object" && !Array.isArray(c.mcp)), "MCP configuration must be an object");
  for (const [name, cfg] of Object.entries(c.mcp || {})) validateMcpServer(cfg, name);
}
export function maskedConfig(config: Config) {
  const copy = clone(config);
  delete (copy as Obj).image;
  const mask = (s: any) =>
    typeof s === "string" && s && !s.includes("{env:") && !s.includes("${")
      ? "__stored_secret__"
      : s;
  for (const p of Object.values(copy.provider || {})) {
    p.apiKey = mask(p.apiKey);
    if (p.options?.apiKey) p.options.apiKey = mask(p.options.apiKey);
    for (const h of [p.headers, p.options?.headers])
      if (h) for (const k in h) h[k] = mask(h[k]);
  }
  for (const m of Object.values(copy.mcp || {}))
    for (const h of [m.env, m.headers])
      if (h) for (const k in h) h[k] = mask(h[k]);
  return copy;
}
export function mergeSecrets(next: any, old: any) {
  if (!next || typeof next !== "object") return;
  for (const k in next) {
    if (next[k] === "__stored_secret__") next[k] = old?.[k] ?? "";
    else if (next[k] && typeof next[k] === "object")
      mergeSecrets(next[k], old?.[k]);
  }
}
const aliases: Obj = {
  topP: "top_p",
  serviceTier: "service_tier",
  maxTokensField: "max_tokens_field",
};
const clientKeys = new Set([
  "__nativeSupportsToolCall",
  "__devinVersion",
  "tokenizer",
  "responsesContinuation",
  "supportsPreviousResponseId",
  "baseURL",
  "baseUrl",
  "apiKey",
  "headers",
  "thinkingFormat",
  "clearThinking",
  "supportsReasoningEffort",
  "supportsThinkingToggle",
  "supportsLongCacheRetention",
  "requiresReasoningContentOnAssistantMessages",
  "sendSessionAffinityHeaders",
  "supportsImages",
  "cacheRetention",
  "codebuddySource",
  "codebuddyModel",
  "codebuddyPackage",
  "codebuddyProxy",
  "devinCli",
  "devinModel",
  "devinProxy",
]);
export function wireOptions(m: Model) {
  const opts: Obj = {};
  for (const [k, v] of Object.entries(m.options)) {
    if (!clientKeys.has(k)) opts[aliases[k] || k] = v;
  }
  if ("reasoningEffort" in opts) {
    const effort =
      ["none", "off"].includes(opts.reasoningEffort) &&
      m.options.supportsThinkingToggle === false
        ? "high"
        : opts.reasoningEffort;
    delete opts.reasoningEffort;
    if (m.api === "openai-responses")
      opts.reasoning = { ...opts.reasoning, effort };
    else opts.reasoning_effort = effort;
  }
  if ("clearThinking" in m.options)
    opts.thinking = {
      ...opts.thinking,
      clear_thinking: m.options.clearThinking,
    };
  const format = m.options.thinkingFormat,
    effort = opts.reasoning_effort || opts.reasoning?.effort,
    disabled =
      ["none", "off"].includes(effort) &&
      m.options.supportsThinkingToggle !== false;
  if (effort && m.options.supportsReasoningEffort === false) {
    delete opts.reasoning_effort;
    if (opts.reasoning) delete opts.reasoning.effort;
  }
  if (["deepseek", "zai", "moonshot", "volcengine"].includes(format)) {
    opts.thinking = {
      ...opts.thinking,
      type: disabled ? "disabled" : "enabled",
    };
    if (format === "moonshot") delete opts.reasoning_effort;
  }
  if (format === "qwen") {
    opts.enable_thinking = !disabled;
    delete opts.reasoning_effort;
  }
  if (format === "openrouter") {
    opts.reasoning = {
      ...opts.reasoning,
      ...(effort ? { effort: disabled ? "none" : effort } : {}),
      ...(disabled ? { enabled: false } : {}),
    };
    delete opts.reasoning_effort;
  }
  if (format === "kimi") {
    delete opts.thinking;
    if (effort) opts.reasoning_effort = effort;
  }
  for (const k of Object.keys(opts)) if (opts[k] === null) delete opts[k];
  return opts;
}
