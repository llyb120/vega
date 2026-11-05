import { convertCatalog } from "./model-capabilities";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import presets from "../../shared/provider-presets.json";
import snapshot from "../../shared/devin-models.json";
import type { Store } from "./store";
import type { Config, Model } from "./config";
import { modelEntries, resolveModel } from "./config";
import { catalogContextModels, modelContext, validateContextRules } from "../../shared/context-rules";
import { Subscriptions } from "./subscriptions";
import {
  assert,
  clone,
  expand,
  httpURL,
  jsonRequest,
  localJSON,
  object,
  type Obj,
} from "./util";
const exec = promisify(execFile);
export class Catalog {
  cache = new Map<
    string,
    { at: number; models: Obj; version?: string; raw?: Obj[] }
  >();
  constructor(
    public store: Store,
    public auth: Subscriptions,
  ) {}
  async provider(raw: Obj, config: Config) {
    validateContextRules(raw.contextRules);
    const p = clone(raw);
    // Keep legacy provider IDs/model references, but use one preset and an explicit login channel.
    if (p.preset === "workbuddy") {
      p.preset = "codebuddy";
      p.options = { ...p.options, codebuddySource: "workbuddy" };
    }
    const preset = presets.find((v) => v.id === p.preset);
    const source =
      p.preset === "local-codex"
        ? "codex"
        : p.preset === "local-claude-code"
          ? "claude-code"
          : p.preset === "codebuddy"
            ? p.options?.codebuddySource === "workbuddy" ? "workbuddy" : "codebuddy"
            : p.preset === "devin" ? "devin" : undefined;
    if (source) {
      const local = await this.auth.load(source, await this.store.get("paths", {}));
      const subscription = !!local.localAuth;
      const options = { ...local.options, ...p.options };
      options.apiKey = local.options.apiKey;
      if (["codebuddy", "workbuddy"].includes(source)) options.codebuddySource = source;
      if (subscription) {
        options.baseURL = local.options.baseURL;
        options.headers = local.options.headers;
      }
      return {
        ...local,
        ...p,
        api: subscription ? local.api : local.api,
        localAuth: local.localAuth,
        options,
        models: { ...catalogContextModels(local.models), ...modelEntries(p.models) },
      };
    }
    p.options = { ...p.options };
    if (!p.options.baseURL && !p.baseURL && preset)
      p.options.baseURL = preset.baseURL;
    p.api ??= /minimax|kimi-code/.test(p.preset || "")
      ? "anthropic-messages"
      : "openai-completions";
    p.models = modelEntries(p.models);
    return p;
  }
  identity(p: Obj) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          api: p.api,
          base: p.options?.baseURL || p.baseURL,
          key: expand(p.options?.apiKey || p.apiKey || ""),
          headers: p.options?.headers,
          options: p.options,
        }),
      )
      .digest("hex");
  }
  async models(
    p: Obj,
    force = false,
  ): Promise<{ models: Obj; version?: string; raw?: Obj[] }> {
    const identity = this.identity(p),
      cached = this.cache.get(identity),
      saved = await this.store.object<any>("model-cache", identity);
    if (!force && cached && Date.now() - cached.at < 60000) return cached;
    if (
      !force &&
      saved &&
      Date.now() - saved.at < 21600000 &&
      !["codebuddy", "devin"].includes(p.api)
    ) {
      this.cache.set(identity, saved);
      return saved;
    }
    let models: Obj = {},
      version: string | undefined,
      raw: Obj[] | undefined;
    if (p.api === "codebuddy") {
      const url = new URL("/v3/config", p.options.baseURL);
      const response = await jsonRequest(url.href, {
        headers: {
          Authorization: "Bearer " + p.options.apiKey,
          ...p.options.headers,
        },
      });
      assert(
        response.code === 0 && Array.isArray(response.data?.models),
        "Invalid CodeBuddy catalog",
      );
      const merged = new Map<string, Obj>();
      for (const m of response.data.models)
        if (typeof m?.id === "string") merged.set(m.id, { ...merged.get(m.id), ...m });
      const allowed = response.data.agents?.find((a: Obj) => a.name === "cli")?.models;
      raw = (Array.isArray(allowed) ? allowed : [...merged.keys()])
        .filter((id: unknown) => typeof id === "string")
        .map((id: string) => merged.get(id) || { id });
      assert(raw!.length, "CodeBuddy / WorkBuddy has no available models");
      for (const m of raw!) {
        const variants = Object.fromEntries(
          [
            ...(m.reasoning?.supportedEfforts || []),
            ...(m.reasoning?.canDisableThinking ? ["none"] : []),
          ].map((e) => [e, { reasoningEffort: e }]),
        );
        models[m.id] = {
          name: m.name || m.id,
          limit: {
            context:
              m.contextWindow?.defaultLength ||
              m.maxAllowedSize ||
              m.maxInputTokens ||
              128000,
            output: m.maxOutputTokens || 32000,
          },
          modalities: {
            input: m.supportsImages ? ["text", "image"] : ["text"],
          },
          reasoning: m.supportsReasoning || !!Object.keys(variants).length,
          variants,
          options: {
            supportsReasoningEffort: !!m.reasoning?.supportedEfforts,
            supportsThinkingToggle: !!m.reasoning?.canDisableThinking,
          },
        };
      }
      const defaultID = raw!.find((m) => m.id === p.options.codebuddyModel)?.id || raw![0].id;
      models[p.options.codebuddySource || "codebuddy"] = {
        ...models[defaultID],
        name: "CodeBuddy / WorkBuddy（默认模型）",
        localModel: defaultID,
      };
    } else if (p.api === "devin") {
      let data: Obj = clone(snapshot);
      version = "3000.11.228";
      try {
        const binary = p.options.devinCli || "devin";
        const [catalog, v] = await Promise.all([
          exec(binary, ["models", "list", "--format", "json"], {
            timeout: 30000,
            maxBuffer: 32 << 20,
            windowsHide: true,
          }),
          exec(binary, ["version"], {
            timeout: 30000,
            maxBuffer: 1024,
            windowsHide: true,
          }),
        ]);
        data = JSON.parse(catalog.stdout);
        version = v.stdout.match(/\d+\.\d+\.\d+/)?.[0] || version;
        assert(
          Array.isArray(data.families) && data.families.length,
          "Invalid Devin CLI catalog",
        );
      } catch {
        /* The reference provider uses the bundled versioned catalog when CLI is absent. */
      }
      raw = (data.families || []).filter((f: Obj) => f.slug !== "fusion");
      for (const family of raw!) {
        const bundled = snapshot.families.find((f) => f.slug === family.slug);
        for (const m of family.variants || [])
          if (m.model_uid && m.model_uid !== "adaptive") {
            const supportsImages =
              m.supports_images ??
              bundled?.variants?.find((v) => v.model_uid === m.model_uid)?.supports_images ??
              bundled?.variants?.[0]?.supports_images ??
              false;
            models[m.model_uid] = {
              name: m.label || m.model_uid,
              limit: {
                context: m.max_context_tokens || 128000,
                output: Math.min(128000, m.max_output_tokens || 128000),
              },
              // CLI models list 不含模态；快照 supports_images 来自 ACP cognition.ai/supportsImages。
              modalities: { input: supportsImages ? ["text", "image"] : ["text"] },
              options: {
                supportsReasoningEffort: false,
                supportsThinkingToggle: false,
              },
            };
          }
      }
      if (p.options.devinModel && p.options.devinModel !== "adaptive") {
        const uid = this.devinModel(raw!, p.options.devinModel);
        models.devin = {
          ...models[uid],
          localModel: uid,
          name: "Devin（跟随 CLI 默认模型）",
        };
      }
    } else {
      let base = expand(p.options?.baseURL || p.baseURL || ""),
        key = expand(p.options?.apiKey || p.apiKey || ""),
        headers = { ...p.headers, ...p.options?.headers };
      if (p.localAuth) {
        const auth = await this.auth.credentials(p.localAuth);
        key = auth.key;
        headers = auth.headers;
      }
      let url =
        base.replace(/\/$/, "") +
        (p.api === "anthropic-messages" && !base.endsWith("/v1")
          ? "/v1/models"
          : "/models");
      if (p.localAuth === "codex") url += "?client_version=0.134.0";
      const budget = { bytes: 16 << 20 };
      const preset = presets.find((v) => v.id === p.preset);
      let metadata = await this.store.get<any>("models.dev", null);
      const needsMetadata =
        !!preset?.modelsDev ||
        [
          "commandcode",
          "opendesign",
                    "local-codex",
          "local-claude-code",
        ].includes(p.preset);
      if (needsMetadata && (!metadata || Date.now() - metadata.at > 21600000)) {
        try {
          metadata = {
            at: Date.now(),
            data: await jsonRequest("https://models.dev/api.json", {}, 20000),
          };
          await this.store.put("models.dev", metadata);
        } catch {}
      }
      const entriesAll: Obj[] = [];
      let availability = true;
      let cursor = "";
      const seen = new Set<string>();
      for (let page = 0; page < 1000; page++) {
        const current = new URL(url);
        if (cursor) current.searchParams.set("after_id", cursor);
        const h: Obj = { ...headers };
        if (key)
          h[
            p.api === "anthropic-messages" && !p.localAuth
              ? "x-api-key"
              : "Authorization"
          ] =
            p.api === "anthropic-messages" && !p.localAuth
              ? key
              : "Bearer " + key;
        if (p.api === "anthropic-messages")
          h["anthropic-version"] = "2023-06-01";
        let data: Obj;
        try {
          data = await jsonRequest(current.href, { headers: h });
        } catch (e) {
          if (
            !entriesAll.length &&
            preset?.modelsDev &&
            metadata?.data?.[p.preset]
          ) {
            availability = false;
            break;
          }
          throw e;
        }
        budget.bytes -= Buffer.byteLength(JSON.stringify(data));
        assert(budget.bytes >= 0, "Model catalog exceeds 16MiB");
        const entries = p.localAuth === "codex" ? data.models : data.data;
        assert(Array.isArray(entries), "Model catalog missing data/models");
        entriesAll.push(
          ...entries
            .filter((m: Obj) => m.visibility !== "hide")
            .map((m: Obj) =>
              p.localAuth === "codex"
                ? {
                    ...m,
                    id: m.slug,
                    name: m.display_name,
                    reasoning_options: m.supported_reasoning_levels
                      ? [
                          {
                            type: "effort",
                            values: m.supported_reasoning_levels.map(
                              (v: Obj) => v.effort,
                            ),
                          },
                        ]
                      : m.reasoning_options,
                  }
                : m,
            ),
        );
        if (p.localAuth === "codex" || !data.has_more) break;
        assert(
          typeof data.last_id === "string" && !seen.has(data.last_id),
          "Invalid/repeated model cursor",
        );
        cursor = data.last_id;
        seen.add(cursor);
        assert(page < 999, "Model catalog page limit reached");
      }
      const catalogID =
        p.preset || "";
      models = convertCatalog(
        availability ? { data: entriesAll } : null,
        preset?.modelsDev ? metadata?.data?.[catalogID] : undefined,
        metadata?.data,
        catalogID,
      );
      for (const model of Object.values(models) as Obj[])
        if (!model.api) model.api = p.api;
      if (p.localAuth === "claude-code") {
        for (const alias of [
          "sonnet",
          "opus",
          "haiku",
          "sonnet[1m]",
          "opus[1m]",
        ]) {
          const family = alias.replace("[1m]", "");
          const candidates = Object.keys(models)
            .filter((key) => key.includes(family))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          if (candidates.length)
            models[alias] = {
              ...models[candidates[0]],
              localModel: candidates[0],
              limit: {
                ...models[candidates[0]].limit,
                ...(alias.endsWith("[1m]") ? { context: 1000000 } : {}),
              },
            };
        }
      }
    }
    const result = { at: Date.now(), models, version, raw };
    this.cache.set(identity, result);
    await this.store.save("model-cache", identity, result);
    return result;
  }
  devinModel(families: Obj[], requested: string, effort?: string) {
    let uid = requested;
    const variants = families.flatMap((f) => f.variants || []);
    if (!variants.some((v) => v.model_uid === uid)) {
      const family = families.find(
        (f) => f.slug === uid || f.aliases?.includes(uid),
      );
      if (family) uid = family.variants?.[0]?.model_uid;
    }
    assert(
      uid !== "adaptive",
      "Devin Adaptive is not implemented by the reference protocol; select a concrete model",
    );
    if (effort) {
      assert(
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          effort,
        ),
        "Invalid Devin effort",
      );
      const suffix = uid.endsWith("-priority") ? "-priority" : "";
      const base = uid.slice(0, uid.length - suffix.length || undefined);
      assert(
        /-(none|minimal|low|medium|high|xhigh|max)$/.test(base),
        "Model does not support effort selection",
      );
      uid =
        base.replace(
          /-(none|minimal|low|medium|high|xhigh|max)$/,
          "-" + effort,
        ) + suffix;
    }
    assert(
      variants.some((v) => v.model_uid === uid),
      "Devin model/effort not found",
    );
    return uid;
  }
  async resolve(config: Config, selection = config.model) {
    const base = selection.split("/variant/")[0],
      providerID = base.split("/")[0];
    assert(config.provider?.[providerID], "Provider not configured");
    const p = await this.provider(config.provider[providerID], config);
    let dynamic: any;
    if (
      p.preset ||
      ["codebuddy", "devin"].includes(p.api) ||
      !Object.keys(p.models || {}).length
    ) {
      dynamic = await this.models(p);
      p.models = { ...catalogContextModels(dynamic.models), ...modelEntries(p.models) };
      if (p.api === "codebuddy") {
        const alias = p.options.codebuddySource || "codebuddy";
        // Old saved alias mappings must not override the current account's available default.
        p.models[alias].localModel = dynamic.models[alias].localModel;
      }
    }
    const effective = {
        ...config,
        provider: { ...config.provider, [providerID]: p },
      },
      model = resolveModel(effective, selection);
    if (p.localAuth) {
      const auth = await this.auth.credentials(p.localAuth);
      model.apiKey = auth.key;
      model.headers = auth.headers;
    }
    if (model.api === "codebuddy") {
      dynamic ??= await this.models(p);
      const info = dynamic.raw?.find((v: Obj) => v.id === model.id);
      assert(info, "CodeBuddy model is unavailable");
      model.options.__nativeSupportsToolCall = info.supportsToolCall;
      const effort =
        model.options.reasoningEffort || model.options.reasoning_effort;
      if (effort)
        assert(
          info.reasoning?.supportedEfforts?.includes(effort) ||
            (effort === "none" && info.reasoning?.canDisableThinking),
          "CodeBuddy model does not support this reasoning effort",
        );
      model.maxOutputTokens = Math.min(
        model.maxOutputTokens,
        info.maxOutputTokens || Infinity,
      );
      model.headers = { ...model.headers, "X-Request-ID": randomUUID() };
      if (
        model.options.reasoning_summary === undefined &&
        (info.supportsReasoning || effort) &&
        !["none", "off"].includes(effort)
      )
        model.options.reasoning_summary = "auto";
    }
    if (model.api === "devin") {
      dynamic ??= await this.models(p);
      model.id = this.devinModel(
        dynamic.raw,
        model.id,
        model.options.reasoningEffort || model.options.reasoning_effort,
      );
      model.options.__devinVersion = dynamic.version;
      model.options.requiresReasoningContentOnAssistantMessages ??= true;
    }
    return model;
  }
  async list(config: Config, force = false) {
    const rows = [];
    for (const [id, raw] of Object.entries(config.provider || {})) {
      try {
        const p = await this.provider(raw, config);
        let models = modelEntries(p.models);
        if (p.preset || !Object.keys(models).length) {
          models = { ...catalogContextModels((await this.models(p, force)).models), ...models };
        }
        for (const [key, m] of Object.entries(models)) {
          if (
            raw.modelFilter?.length &&
            !raw.modelFilter.some((v: string) =>
              (key + " " + m.name).toLowerCase().includes(v.toLowerCase()),
            )
          )
            continue;
          rows.push({
            id: `${id}/${key}`,
            name: m.name || key,
            variants: Object.keys(m.variants || {}),
            api: m.api || p.api,
            supportsImages:
              m.supportsImages ??
              m.modalities?.input?.includes("image") ??
              false,
            context: modelContext(p, key, m).context,
            output: m.limit?.output,
            provider: id,
            available: true,
          });
        }
      } catch (e: any) {
        rows.push({ provider: id, error: e.message, available: false });
      }
    }
    return rows;
  }
}
