import builtinModelCapabilities from "../../shared/builtin-model-capabilities.json";
import { assert, object, type Obj } from "./util";

type BuiltinModelCapability = {
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  modalities?: { input?: string[] };
  variants?: Record<string, { reasoningEffort?: string }>;
  options?: Record<string, unknown>;
};

const BUILTIN_BY_ID = new Map(
  Object.entries(builtinModelCapabilities as Record<string, BuiltinModelCapability>).map(
    ([id, caps]) => [id.toLowerCase(), caps],
  ),
);

/** Fill missing catalog fields from the built-in id table. Gateway values always win. */
export function enrichBuiltinModelCapabilities(models: Obj): Obj {
  for (const [id, model] of Object.entries(models) as [string, Obj][]) {
    const bare = id.split("/").at(-1)?.toLowerCase();
    if (!bare) continue;
    const builtin = BUILTIN_BY_ID.get(bare);
    if (!builtin) continue;

    if (builtin.limit) {
      const limit = { ...(model.limit || {}) };
      if (limit.context == null && builtin.limit.context != null)
        limit.context = builtin.limit.context;
      if (limit.output == null && builtin.limit.output != null)
        limit.output = builtin.limit.output;
      if (Object.keys(limit).length) model.limit = limit;
    }

    if (model.reasoning == null && builtin.reasoning != null)
      model.reasoning = builtin.reasoning;

    if (!model.modalities && builtin.modalities)
      model.modalities = structuredClone(builtin.modalities);

    if (!model.variants && builtin.variants && Object.keys(builtin.variants).length)
      model.variants = structuredClone(builtin.variants);

    if (builtin.options)
      model.options = { ...builtin.options, ...(model.options || {}) };

    if (
      model.reasoning &&
      model.variants &&
      Object.keys(model.variants).length &&
      model.options?.supportsReasoningEffort == null
    ) {
      model.options = { ...model.options, supportsReasoningEffort: true };
    }
  }
  return models;
}

function npmAPI(npm: string) {
  return npm.includes("google")
    ? undefined
    : npm === "@ai-sdk/anthropic"
      ? "anthropic-messages"
      : npm === "@ai-sdk/openai"
        ? "openai-responses"
        : "openai-completions";
}
export function catalogModel(catalog: Obj | undefined, id: string) {
  const entries = Object.entries(catalog || {}).flatMap(
    ([provider, p]: [string, any]) =>
      Object.entries(p.models || {}).map(([key, m]: [string, any]) => ({
        provider,
        key,
        m,
      })),
  );
  return (
    entries.find(
      (e) => (e.provider + "/" + e.key).toLowerCase() === id.toLowerCase(),
    )?.m ||
    entries.find(
      (e) =>
        e.key.toLowerCase() === id.toLowerCase() &&
        e.m.canonical_model_id?.startsWith(e.provider + "/"),
    )?.m ||
    entries.find(
      (e) =>
        e.key.toLowerCase() === id.toLowerCase() ||
        e.m.canonical_model_id?.toLowerCase() === id.toLowerCase(),
    )?.m
  );
}
export function configureReasoning(
  model: Obj,
  key: string,
  api: string,
  preset: string,
  caps?: Obj[],
) {
  const id = key.toLowerCase().replace(/\[1m\]$|-1m$/, ""),
    effort = caps?.some((c) => c.type === "effort"),
    toggle = caps?.some(
      (c) =>
        c.type === "toggle" ||
        (api === "anthropic-messages" && c.type === "budget_tokens") ||
        c.values?.includes("none"),
    );
  let format: string | undefined;
  if (
    api === "anthropic-messages" &&
    id.includes("claude") &&
    effort &&
    (!caps?.some((c) => c.type === "budget_tokens") ||
      /(opus|sonnet)-4[-.]6$/.test(id))
  )
    format = "anthropic";
  else if (preset === "deepseek") format = "deepseek";
  else if (/^(zai|zhipuai)(-coding-plan)?$/.test(preset)) format = "zai";
  else if (
    ["moonshotai", "moonshotai-cn", "kimi-code-plan-cn"].includes(preset)
  )
    format = id.startsWith("kimi-k2") ? "moonshot" : "kimi";
  else if (/^alibaba/.test(preset) && /^(qwen|qwq)/.test(id)) format = "qwen";
  else if (
    preset === "siliconflow-cn" &&
    /qwen3-|hunyuan-a13b-instruct|glm-5v-turbo|glm-4\.[56]v|deepseek-v3\.[12]/.test(
      id,
    )
  )
    format = "qwen";
  else if (preset === "minimax-cn") format = "minimax";
  else if (/^volcengine/.test(preset)) format = "volcengine";
  else if (preset === "openrouter") format = "openrouter";
  const o = { ...model.options };
  if (format) {
    o.thinkingFormat = format;
    if (!["openrouter", "volcengine"].includes(format))
      o.maxTokensField = "max_tokens";
  }
  if (caps) {
    o.supportsReasoningEffort = !!effort;
    o.supportsThinkingToggle = !!toggle;
  }
  if (format === "anthropic") {
    const defaultEffort = /(opus|haiku)-5[-.]5$/.test(id) ? "medium" : "high";
    if (
      caps?.some(
        (c) => c.type === "effort" && c.values?.includes(defaultEffort),
      )
    )
      o.reasoningEffort = defaultEffort;
  }
  if (
    ["deepseek", "zai", "moonshot", "kimi", "volcengine"].includes(format || "")
  )
    o.requiresReasoningContentOnAssistantMessages = true;
  if (format === "zai" && id.startsWith("glm-5.3"))
    o.supportsThinkingToggle = false;
  if (preset === "siliconflow-cn" && id.endsWith("deepseek-v3.1"))
    Object.assign(o, {
      enable_thinking: false,
      supportsThinkingToggle: false,
      supportsReasoningEffort: false,
    });
  if (format === "moonshot")
    Object.assign(o, {
      supportsReasoningEffort: false,
      supportsThinkingToggle: ["kimi-k2.5", "kimi-k2.6"].includes(id),
    });
  if (format === "kimi") o.supportsThinkingToggle = false;
  if (["moonshot", "kimi"].includes(format || ""))
    Object.assign(o, { temperature: null, top_p: null, topP: null });
  if (format === "minimax")
    Object.assign(o, {
      supportsThinkingToggle: id === "minimax-m3",
      supportsReasoningEffort: id === "minimax-m3.1-flash-preview",
    });
  if (Object.keys(o).length) model.options = o;
}
export function convertCatalog(
  list: Obj | null,
  meta?: Obj,
  catalog?: Obj,
  preset = "",
) {
  const source = meta || catalog?.[preset],
    known = source?.models || {},
    npm = source?.npm || "",
    entries: Obj[] = Array.isArray(list?.data)
      ? list!.data
      : Object.entries(known)
          .filter(([, v]: [string, any]) => v.status !== "deprecated")
          .map(([id]) => ({ id }));
  const out: Obj = {};
  for (const entry of entries) {
    const id = entry.id;
    if (!id || id.startsWith("jev-")) continue;
    const providerInfo = known[id],
      info = providerInfo || catalogModel(catalog, id),
      toolCall = entry.supported_parameters
        ? entry.supported_parameters.includes("tools")
        : (info?.tool_call ?? true);
    if (!toolCall) continue;
    const endpoints = entry.supported_endpoints;
    const special = ["gpt-6-astra", "gpt-6.1-sol"].includes(
      id.split("/").at(-1),
    );
    let api: string | undefined;
    if (Array.isArray(endpoints))
      api =
        endpoints.includes("/responses") && special
          ? "openai-responses"
          : endpoints.includes("/chat/completions") && !special
            ? "openai-completions"
            : endpoints.includes("/responses")
              ? "openai-responses"
              : endpoints.includes("/messages")
                ? "anthropic-messages"
                : undefined;
    else api = npmAPI(providerInfo?.provider?.npm || npm);
    if (!api) continue;
    const model: Obj = {};
    if (api !== "openai-completions") model.api = api;
    const name = entry.name || entry.display_name || info?.name;
    if (name) model.name = name;
    const metadata = preset === "opendesign" ? entry.metadata || {} : {},
      context =
        entry.context_length ||
        entry.context_window ||
        metadata.context_limit ||
        info?.limit?.context,
      output =
        entry.top_provider?.max_completion_tokens ||
        entry.max_output_tokens ||
        metadata.output_budget ||
        info?.limit?.output;
    if (context || output)
      model.limit = {
        ...(context ? { context } : {}),
        ...(output ? { output } : {}),
      };
    const images =
      entry.architecture?.input_modalities ||
      entry.input_modalities ||
      info?.modalities?.input;
    if (images?.includes("image"))
      model.modalities = { input: ["text", "image"] };
    const reasoningInfo =
      info ||
      catalogModel(
        catalog,
        id.replace(/\[1m\]$|-1m$|-fast$|-paid$|:free$/, ""),
      );
    if (reasoningInfo?.interleaved?.field === "reasoning_content")
      model.options = { requiresReasoningContentOnAssistantMessages: true };
    const caps = entry.reasoning_options || reasoningInfo?.reasoning_options;
    const router =
      preset === "openrouter" && typeof entry.reasoning === "object"
        ? entry.reasoning
        : undefined;
    let efforts = router
      ? router.supported_efforts === null
        ? ["max", "xhigh", "high", "medium", "low", "minimal", "none"]
        : router.supported_efforts
      : caps?.find((c: Obj) => c.type === "effort")?.values;
    efforts = (efforts || []).filter(
      (e: string) => e && !(e === "none" && router?.mandatory),
    );
    const variants = Object.fromEntries(
      efforts.map((e: string) => [e, { reasoningEffort: e }]),
    );
    const reasoning =
      typeof entry.reasoning === "boolean"
        ? entry.reasoning
        : router
          ? true
          : entry.reasoning_options?.length
            ? true
            : (reasoningInfo?.reasoning ?? !!efforts.length);
    if (reasoning) {
      model.reasoning = true;
      configureReasoning(model, id, api, preset, caps);
      if (router) {
        model.options ??= {};
        model.options.supportsThinkingToggle = !router.mandatory;
        model.options.supportsReasoningEffort = !!efforts.length;
        if (variants[router.default_effort])
          model.options.reasoningEffort = router.default_effort;
      }
      if (model.options?.supportsThinkingToggle === false) delete variants.none;
      if (
        model.options?.supportsReasoningEffort !== false &&
        Object.keys(variants).length
      )
        model.variants = variants;
    }
    out[id] = model;
  }
  for (const [id, m] of Object.entries(out)) {
    if (/\[1m\]$|-1m$/.test(id) && !m.limit?.context)
      m.limit = { ...m.limit, context: 1000000 };
    const base = out[id.replace(/\[1m\]$|-1m$|-fast$|-paid$|:free$/, "")];
    if (!base || base === m) continue;
    for (const key of ["modalities", "reasoning", "options", "variants"])
      if (!(key in m) && key in base) m[key] = structuredClone(base[key]);
    for (const key of ["context", "output"])
      if (!m.limit?.[key] && base.limit?.[key])
        m.limit = { ...m.limit, [key]: base.limit[key] };
  }
  return enrichBuiltinModelCapabilities(out);
}
