import { createHash } from "node:crypto";
import type { Message, Call } from "./store";
import { historyImages } from "./history";
import type { Model } from "./config";
import { wireOptions } from "./config";
import {
  assert,
  clip,
  object,
  bounded,
  request,
  sse,
  nativeArguments,
  type Obj,
} from "./util";
import { devinStream } from "./devin";
export type Tool = { name: string; description: string; parameters: Obj };
export function normalizeUsage(api: string, u: Obj) {
  if (typeof u.input === "number" && typeof u.output === "number") return u;
  const output = u.output_tokens ?? u.completion_tokens ?? 0,
    cacheRead =
      u.cache_read_input_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      u.prompt_cache_hit_tokens ??
      0,
    cacheWrite = u.cache_creation_input_tokens ?? 0,
    gross = u.input_tokens ?? u.prompt_tokens ?? 0,
    input =
      api === "anthropic-messages" ? gross : Math.max(0, gross - cacheRead);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: u.total_tokens ?? input + output + cacheRead + cacheWrite,
  };
}
export type Emit = (type: string, data?: any) => void;
export class ProviderError extends Error {
  constructor(
    message: string,
    public status = 0,
    public kind?: "length" | "empty",
  ) {
    super(message);
  }
}
function usableReply(reply: Message) {
  if (!reply.text?.trim() && !reply.calls?.length)
    throw new ProviderError("模型只返回了思考内容或空白，没有回复正文或工具调用", 0, "empty");
  return reply;
}
const hash = (v: any) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const historyHash = (rows: Message[]) =>
  hash(rows.map(({ seq, at, ...row }) => row));
const callID = (value: string) =>
  value.includes("|") ? "call_" + hash(value).slice(0, 24) : value;
const imageURL = (image: Obj) => `data:${image.mime};base64,${image.data}`;
export function outputBudget(
  model: Model,
  system: string,
  rows: Message[],
  tools: Tool[],
) {
  const plain = JSON.stringify([
    system,
    tools,
    rows.map(({ images, ...m }) => ({
      ...m,
      images: images?.map(() => ({ imageTokens: 1600 })),
    })),
  ]);
  const tokens =
    [...plain].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 1 : 0.25), 0) +
    rows.reduce((n, m) => n + (m.images?.length || 0) * 1600, 0);
  const available = Math.floor(model.contextWindow - tokens - 256);
  assert(available >= 32, "Context window input leaves no output budget");
  return Math.min(model.maxOutputTokens, available);
}
export async function bodyFor(
  model: Model,
  system: string,
  input: Message[],
  tools: Tool[],
  resolveImage?: (image: { mime: string; data?: string; blobId?: string; path?: string }) => Promise<{
    mime: string;
    data: string;
  }>,
) {
  const trimmed = historyImages(input),
    rows = resolveImage
      ? await Promise.all(trimmed.map(async (m) =>
          m.images?.length
            ? {
                ...m,
                images: await Promise.all(m.images.map((im) =>
                  im.data ? { mime: im.mime, data: im.data } : resolveImage(im),
                )),
              }
            : m,
        ))
      : trimmed,
    options = wireOptions(model),
    body: Obj = { ...options, model: model.id, stream: true };
  const api = model.api;
  const budget = outputBudget(model, system, rows, tools);
  if (api === "anthropic-messages") {
    delete body.max_tokens_field;
    body.model = model.id.replace(/\[1m\]$/, "");
    body.system = system;
    body.max_tokens = budget;
    const messages: Obj[] = [];
    for (const m of rows) {
      let role = m.role === "tool" || m.role === "system" ? "user" : m.role;
      const content: Obj[] = [];
      if (m.role === "tool") {
        const parts: Obj[] = [{ type: "text", text: clip(m.text || "") }];
        if (model.supportsImages)
          for (const image of m.images || [])
            parts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: image.mime,
                data: image.data,
              },
            });
        content.push({
          type: "tool_result",
          tool_use_id: callID(m.callId!),
          content: parts,
          is_error: !!m.error,
        });
      } else {
        if (m.model === model.selection) {
          content.push(
            ...(m.opaque || []).filter((v) =>
              ["thinking", "redacted_thinking"].includes(v.type),
            ),
          );
          if (
            m.thinking &&
            m.signature &&
            !content.some((v) => v.type === "thinking")
          )
            content.push({
              type: "thinking",
              thinking: m.thinking,
              signature: m.signature,
            });
        }
        if (m.text) content.push({ type: "text", text: m.text });
        for (const image of m.images || [])
          content.push(
            model.supportsImages
              ? {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mime,
                    data: image.data,
                  },
                }
              : { type: "text", text: "[image omitted: text-only model]" },
          );
        for (const call of m.calls || [])
          content.push({
            type: "tool_use",
            id: callID(call.id),
            name: call.name,
            input: call.arguments,
          });
      }
      if (!content.length) continue;
      const last = messages.at(-1);
      if (last?.role === role) last.content.push(...content);
      else messages.push({ role, content });
    }
    body.messages = messages;
    if (tools.length)
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));

    const format = model.options.thinkingFormat,
      minimax = format === "minimax",
      version = /(?:opus|sonnet|haiku)-(\d+)[.-](\d+)/.exec(model.id);
    const adaptive =
      format === "anthropic" ||
      (!!version &&
        (Number(version[1]) > 4 ||
          (Number(version[1]) === 4 && Number(version[2]) >= 6)));
    const effort = options.reasoning_effort;
    delete body.reasoning_effort;
    if (
      ["none", "off"].includes(effort) &&
      model.options.supportsThinkingToggle !== false
    )
      body.thinking = { type: "disabled" };
    else if (model.reasoning && !model.options.thinking) {
      if (minimax || adaptive) body.thinking = { type: "adaptive" };
      else if (budget > 1024)
        body.thinking = {
          type: "enabled",
          budget_tokens: Math.min(
            budget - 1,
            Math.max(
              1024,
              (
                {
                  minimal: 1024,
                  low: 2048,
                  medium: 8192,
                  high: 16384,
                  xhigh: 24000,
                  max: 31000,
                } as Obj
              )[effort] || 8192,
            ),
          ),
        };
    }
    if (
      body.thinking?.type === "adaptive" &&
      !body.output_config?.effort &&
      (!minimax || model.options.supportsReasoningEffort)
    ) {
      let level = effort || "high";
      if (
        format !== "anthropic" &&
        version &&
        Number(version[1]) === 4 &&
        Number(version[2]) < 7
      )
        level = ["minimal", "low"].includes(level)
          ? "low"
          : level === "medium"
            ? "medium"
            : ["max", "xhigh"].includes(level) && model.id.includes("opus")
              ? "max"
              : "high";
      body.output_config = {
        ...body.output_config,
        effort: level === "minimal" ? "low" : level,
      };
    }
    if (["adaptive", "enabled"].includes(body.thinking?.type) && !minimax) {
      body.thinking.display ??= "summarized";
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }
    if (body.thinking?.type === "enabled") {
      if (budget <= 1024) delete body.thinking;
      else
        body.thinking.budget_tokens = Math.min(
          budget - 1,
          Math.max(1024, body.thinking.budget_tokens || 8192),
        );
    }
    if (
      body.service_tier &&
      !["auto", "standard_only"].includes(body.service_tier)
    )
      delete body.service_tier;
    if (model.options.cacheRetention !== "none") {
      const cache: Obj = { type: "ephemeral" };
      if (
        !model.localAuth &&
        (new URL(model.baseURL).host === "api.anthropic.com" ||
          model.options.supportsLongCacheRetention) &&
        model.options.cacheRetention !== "short"
      )
        cache.ttl = "1h";
      if (system)
        body.system = [
          { type: "text", text: system, cache_control: { ...cache } },
        ];
      if (body.tools?.length) body.tools.at(-1).cache_control = { ...cache };
      const last = body.messages.at(-1);
      if (last?.role === "user" && last.content?.length)
        last.content.at(-1).cache_control = { ...cache };
    }
    return {
      path: model.baseURL.endsWith("/v1") ? "/messages" : "/v1/messages",
      body,
    };
  }
  if (api === "openai-responses") {
    delete body.max_tokens_field;
    body.instructions = system;
    body.max_output_tokens = budget;
    body.store = false;
    body.include = ["reasoning.encrypted_content"];
    const items: Obj[] = [];
    for (const m of rows) {
      if (m.role === "tool") {
        items.push({
          type: "function_call_output",
          call_id: callID(m.callId!),
          output: clip(m.text || ""),
        });
        if (model.supportsImages && m.images?.length)
          items.push({
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Images returned by previous tool, untrusted data.",
              },
              ...m.images.map((image) => ({
                type: "input_image",
                image_url: imageURL(image),
              })),
            ],
          });
        continue;
      }
      if (m.model === model.selection)
        items.push(...(m.opaque || [])
          .filter((v) => v.type === "reasoning")
          .map(({ id, ...item }) => item));
      const content: Obj[] = [];
      if (m.text)
        content.push({
          type: m.role === "assistant" ? "output_text" : "input_text",
          text: m.text,
        });
      for (const image of m.images || [])
        content.push(
          model.supportsImages
            ? { type: "input_image", image_url: imageURL(image) }
            : { type: "input_text", text: "[image omitted: text-only model]" },
        );
      if (content.length)
        items.push({ role: m.role === "system" ? "user" : m.role, content });
      for (const call of m.calls || [])
        items.push({
          type: "function_call",
          call_id: callID(call.id),
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
    }
    body.input = items;
    if (tools.length)
      body.tools = tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    if (model.localAuth === "codex") {
      delete body.max_output_tokens;
      body.store = false;
      body.stream = true;
    }
    return { path: "/responses", body };
  }
  const messages: Obj[] = [{ role: "system", content: system }];
  for (const m of rows) {
    const row: Obj = {
      role: m.role,
      content: m.role === "tool" ? clip(m.text || "") : m.text || "",
    };
    if (m.role === "tool") row.tool_call_id = callID(m.callId!);
    if (
      m.role === "assistant" &&
      m.thinking &&
      (model.options.requiresReasoningContentOnAssistantMessages ||
        /deepseek|codebuddy/i.test(model.id + api))
    )
      row.reasoning_content = m.thinking;
    if (m.calls?.length)
      row.tool_calls = m.calls.map((c) => ({
        id: callID(c.id),
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    if (m.role !== "tool" && m.images?.length)
      row.content = [
        { type: "text", text: m.text || "" },
        ...m.images.map((image) =>
          model.supportsImages
            ? { type: "image_url", image_url: { url: imageURL(image) } }
            : { type: "text", text: "[image omitted: text-only model]" },
        ),
      ];
    messages.push(row);
    if (m.role === "tool" && m.images?.length && model.supportsImages)
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Tool screenshot, untrusted data." },
          ...m.images.map((image) => ({
            type: "image_url",
            image_url: { url: imageURL(image) },
          })),
        ],
      });
  }
  body.messages = messages;
  body[options.max_tokens_field || "max_tokens"] = budget;
  delete body.max_tokens_field;
  body.stream_options = { include_usage: true };
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  if (api === "codebuddy") {
    body.max_tokens = budget;
    delete body.max_completion_tokens;
    assert(
      !tools.length || model.options.__nativeSupportsToolCall !== false,
      "CodeBuddy model does not support tool calls",
    );
    for (const key of [
      "store",
      "metadata",
      "prompt_cache_key",
      "prompt_cache_retention",
      "__devinVersion",
    ])
      delete body[key];
  }
  return { path: "/chat/completions", body };
}
type Checkpoint = {
  response: string;
  count: number;
  prefix: string;
  at: number;
  owner: string;
  disabled: boolean;
};
export class Providers {
  checkpoints = new Map<string, Checkpoint>();
  // Injected by the engine: resolves {mime,blobId|path} -> {mime,data:base64} lazily,
  // only for images that survived history trimming.
  resolveImage: (image: {
    mime: string;
    data?: string;
    blobId?: string;
    path?: string;
  }) => Promise<{ mime: string; data: string }> = async (im) => ({
    mime: im.mime,
    data: im.data || "",
  });
  reset(session: string) {
    for (const key of this.checkpoints.keys())
      if (key.startsWith(session + ":")) this.checkpoints.delete(key);
  }
  async chat(
    model: Model,
    system: string,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal,
    emit: Emit = () => {},
    session = "",
  ): Promise<Message> {
    const { path, body } = await bodyFor(
          model,
          system,
          messages,
          tools,
          this.resolveImage,
        );
    if (model.api === "devin")
      return usableReply(await devinStream(
        model,
        body,
        model.options.__devinVersion || "3000.11.228",
        signal,
        emit,
      ));
    const headers: Obj = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...model.headers,
    };
    if (model.api === "anthropic-messages") {
      headers["anthropic-version"] = "2023-06-01";
      if (model.apiKey) {
        if (model.localAuth) headers.Authorization = "Bearer " + model.apiKey;
        else headers["x-api-key"] = model.apiKey;
      }
    } else if (model.apiKey) headers.Authorization = "Bearer " + model.apiKey;
    if (model.api === "codebuddy")
      headers["X-Conversation-ID"] = session || crypto.randomUUID();
    if (model.options.sendSessionAffinityHeaders && session)
      headers["X-Session-ID"] = session;
    if (model.id.endsWith("[1m]") && model.api === "anthropic-messages") {
      const key =
        Object.keys(headers).find(
          (k) => k.toLowerCase() === "anthropic-beta",
        ) || "anthropic-beta";
      headers[key] = [headers[key], "context-1m-2025-08-07"]
        .filter(Boolean)
        .join(",");
    }
    const scope = hash({
        base: model.baseURL,
        model: model.id,
        system,
        tools,
        options: model.options,
        key: hash(model.apiKey),
        headers,
      }),
      cacheKey = session + ":" + scope;
    const previous = this.checkpoints.get(cacheKey);
    const owner = crypto.randomUUID();
    let continuation = false;
    if (session && model.api === "openai-responses") {
      for (const [key, v] of this.checkpoints)
        if (performance.now() - v.at > 1800000) this.checkpoints.delete(key);
      if (
        previous &&
        !previous.disabled &&
        previous.response &&
        historyHash(messages.slice(0, previous.count)) === previous.prefix
      ) {
        body.previous_response_id = previous.response;
        body.input = (await bodyFor(
                  model,
                  system,
                  messages.slice(previous.count),
                  tools,
                  this.resolveImage,
                )).body.input;
        continuation = true;
      }
      this.checkpoints.set(cacheKey, {
        response: "",
        count: 0,
        prefix: "",
        at: performance.now(),
        owner,
        disabled: previous?.disabled || false,
      });
      const same = [...this.checkpoints.keys()].filter((k) =>
        k.startsWith(session + ":"),
      );
      if (same.length > 4) this.checkpoints.delete(same[0]);
      if (this.checkpoints.size > 512)
        this.checkpoints.delete(this.checkpoints.keys().next().value!);
    }
    let response = await request(
      model.baseURL + path,
      {
        method: "POST",
        redirect:
          model.localAuth || model.api === "codebuddy" ? "manual" : "follow",
        headers,
        body: JSON.stringify(body),
        signal,
      },
      0,
    );
    if (
      !response.ok &&
      continuation &&
      [400, 404, 409, 422].includes(response.status)
    ) {
      await bounded(response, 4096);
      delete body.previous_response_id;
      body.input = (await bodyFor(
              model,
              system,
              messages,
              tools,
              this.resolveImage,
            )).body.input;
      response = await request(
        model.baseURL + path,
        {
          method: "POST",
          redirect:
            model.localAuth || model.api === "codebuddy" ? "manual" : "follow",
          headers,
          body: JSON.stringify(body),
          signal,
        },
        0,
      );
      continuation = false;
      const state = this.checkpoints.get(cacheKey);
      if (state?.owner === owner) state.disabled = true;
    }
    const signedRows = messages.some(
      (m) =>
        m.signature ||
        m.opaque?.some(
          (p) => p.type === "thinking" || p.type === "redacted_thinking",
        ),
    );
    if (
      !response.ok &&
      response.status === 400 &&
      model.api === "anthropic-messages" &&
      signedRows
    ) {
      const bytes = await bounded(response, 4096);
      if (/invalid.*signature/i.test(bytes.toString())) {
        const unsigned = messages.map((m) => ({
          ...m,
          signature: undefined,
          opaque: m.opaque?.filter(
            (p) => !["thinking", "redacted_thinking"].includes(p.type),
          ),
        }));
        const retry = await bodyFor(
                model,
                system,
                unsigned,
                tools,
                this.resolveImage,
              );
        response = await request(
          model.baseURL + retry.path,
          { method: "POST", headers, body: JSON.stringify(retry.body), signal },
          0,
        );
      } else
        response = new Response(bytes, {
          status: 400,
          headers: response.headers,
        });
    }
    if (!response.ok) {
      const data = (await bounded(response, 4096))
        .toString()
        .split(model.apiKey || "\u0000")
        .join("[redacted]");
      throw new ProviderError(
        `${model.localAuth || ["codebuddy", "devin"].includes(model.api) ? "Subscription authentication/upstream" : clip(data, 1000)} HTTP ${response.status}`,
        response.status,
      );
    }
    let result: Message = {
      role: "assistant",
      text: "",
      thinking: "",
      opaque: [],
      calls: [],
      model: model.selection,
      usage: {},
    };
    const fragments = new Map<
        number,
        { id: string; name: string; args: string }
      >(),
      blocks = new Map<number, Obj>(),
      itemIndexes = new Map<string, number>();
    let complete = false,
      finish = "",
      responseID = "";
    const delta = (kind: string, value: string) => {
      if (!value) return;
      if (kind === "thinking_delta") result.thinking += value;
      else result.text += value;
      emit(kind, value);
    };
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = JSON.parse((await bounded(response)).toString());
      result = this.jsonResult(model, data);
      complete = true;
    } else {
      for await (const frame of sse(response, signal)) {
        emit("activity");
        if (!frame.data) continue;
        if (frame.data === "[DONE]") {
          complete = true;
          continue;
        }
        let data: Obj;
        try {
          data = JSON.parse(frame.data);
        } catch {
          throw new ProviderError("Malformed provider stream");
        }
        if (data.error)
          throw new ProviderError(
            model.localAuth || model.api === "codebuddy"
              ? "Subscription provider stream error; check login, model permissions and quota"
              : clip(
                  JSON.stringify(data.error)
                    .split(model.apiKey || "\u0000")
                    .join("[provider key redacted]"),
                  1000,
                ),
          );
        const type = data.type || frame.event;
        if (model.api === "anthropic-messages") {
          const index = data.index || 0;
          if (type === "message_start")
            Object.assign(result.usage, data.message?.usage);
          if (type === "content_block_start") {
            const block = data.content_block;
            blocks.set(index, block);
            if (block.type === "tool_use")
              fragments.set(index, {
                id: block.id,
                name: block.name,
                args: Object.keys(block.input || {}).length
                  ? JSON.stringify(block.input)
                  : "",
              });
            if (block.type === "text") delta("text_delta", block.text || "");
            if (block.type === "thinking")
              delta("thinking_delta", block.thinking || "");
          }
          if (type === "content_block_delta") {
            const d = data.delta,
              b = blocks.get(index);
            if (d.type === "text_delta") delta("text_delta", d.text);
            if (d.type === "thinking_delta") {
              delta("thinking_delta", d.thinking);
              if (b) b.thinking = (b.thinking || "") + d.thinking;
            }
            if (d.type === "signature_delta" && b)
              b.signature = (b.signature || "") + d.signature;
            if (d.type === "input_json_delta") {
              assert(fragments.has(index), "Tool JSON delta without block");
              fragments.get(index)!.args += d.partial_json;
            }
          }
          if (type === "message_delta") {
            finish = data.delta?.stop_reason;
            Object.assign(result.usage, data.usage);
          }
          if (type === "message_stop") complete = true;
        } else if (model.api === "openai-responses") {
          if (type === "response.output_text.delta")
            delta("text_delta", data.delta);
          if (
            [
              "response.reasoning_summary_text.delta",
              "response.reasoning_text.delta",
            ].includes(type)
          )
            delta("thinking_delta", data.delta);
          if (type === "response.output_item.added") {
            const item = data.item,
              index = data.output_index;
            itemIndexes.set(item.id, index);
            if (item.type === "function_call")
              fragments.set(index, {
                id: item.call_id,
                name: item.name,
                args: item.arguments || "",
              });
          }
          if (type === "response.function_call_arguments.delta") {
            const index = itemIndexes.get(data.item_id) ?? data.output_index;
            assert(fragments.has(index), "Tool delta without function item");
            fragments.get(index)!.args += data.delta;
          }
          if (type === "response.output_item.done") {
            const item = data.item;
            if (item.type === "function_call")
              fragments.set(data.output_index, {
                id: item.call_id,
                name: item.name,
                args: item.arguments,
              });
            if (item.type === "reasoning") result.opaque!.push(item);
          }
          if (type === "response.completed") {
            assert(
              !data.response?.status || data.response.status === "completed",
              "Response did not complete",
            );
            complete = true;
            finish = "stop";
            responseID = data.response.id || "";
            result.usage = data.response.usage || {};
            if (!result.text)
              for (const item of data.response.output || [])
                for (const c of item.content || [])
                  if (c.type === "output_text") delta("text_delta", c.text);
            if (!fragments.size)
              for (const [i, item] of (data.response.output || []).entries())
                if (item.type === "function_call")
                  fragments.set(i, {
                    id: item.call_id,
                    name: item.name,
                    args: item.arguments,
                  });
          }
          if (
            type === "response.incomplete" &&
            data.response?.incomplete_details?.reason === "max_output_tokens"
          )
            throw new ProviderError(
              "Provider output length exhausted; tools not dispatched",
              0,
              "length",
            );
          if (
            ["response.failed", "response.incomplete", "error"].includes(type)
          )
            throw new ProviderError(
              `Provider ${type}: ${clip(
                JSON.stringify(data.response?.error || data.error || {})
                  .split(model.apiKey || "\u0000")
                  .join("[provider key redacted]"),
                1000,
              )}`,
            );
        } else {
          if (data.usage) result.usage = data.usage;
          for (const choice of data.choices || []) {
            if (choice.index && choice.index !== 0) continue;
            const d = choice.delta || {};
            delta("text_delta", d.content || "");
            delta("thinking_delta", d.reasoning_content || d.reasoning || "");
            if (choice.finish_reason) finish = choice.finish_reason;
            for (const call of d.tool_calls || []) {
              const index = call.index || 0;
              let f = fragments.get(index);
              if (!f) {
                f = { id: "", name: "", args: "" };
                fragments.set(index, f);
              }
              if (call.id && !f.id) f.id = call.id;
              f.name += call.function?.name || "";
              f.args += call.function?.arguments || "";
            }
          }
        }
      }
      assert(
        complete && finish,
        "Truncated provider stream; no tool was dispatched",
      );
      if (["length", "max_tokens"].includes(finish))
        throw new ProviderError(
          "Provider output length exhausted; tools not dispatched",
          0,
          "length",
        );
      assert(
        finish !== "content_filter",
        "Provider output blocked by content filter; tools not dispatched",
      );
      const seen = new Set<string>();
      const calls: Call[] = [];
      for (const [index, f] of [...fragments].sort(([a], [b]) => a - b)) {
        assert(f.id && f.name, "Invalid tool call");
        if (seen.has(f.id) && model.api === "codebuddy")
          f.id = callID("duplicate|" + f.id + "|" + index);
        assert(!seen.has(f.id), "Duplicate tool call");
        seen.add(f.id);
        const args = nativeArguments(f.args);
        assert(
          args && typeof args === "object" && !Array.isArray(args),
          "Tool arguments must be a complete JSON object",
        );
        assert(
          tools.some((t) => t.name === f.name),
          "Provider returned undeclared tool",
        );
        calls.push({ id: f.id, name: f.name, arguments: args });
      }
      result.calls = calls;
      if (model.api === "anthropic-messages")
        result.opaque = [...blocks]
          .sort(([a], [b]) => a - b)
          .map(([, b]) => b)
          .filter(
            (b) =>
              b.type === "redacted_thinking" ||
              (b.type === "thinking" && b.signature),
          );
    }
    result.usage = normalizeUsage(model.api, result.usage || {});
    const seenCalls = new Set<string>();
    for (const call of result.calls || []) {
      assert(
        call.id &&
          call.name &&
          tools.some((t) => t.name === call.name) &&
          !seenCalls.has(call.id),
        "Invalid/duplicate/undeclared tool call",
      );
      seenCalls.add(call.id);
    }
    signal.throwIfAborted();
    usableReply(result);
    if (responseID && session && model.api === "openai-responses") {
      const state = this.checkpoints.get(cacheKey);
      if (state?.owner === owner) {
        const history = [...messages, result];
        state.response = responseID;
        state.count = history.length;
        state.prefix = historyHash(history);
        state.at = performance.now();
      }
    }
    return result;
  }
  jsonResult(model: Model, data: Obj): Message {
    const r: Message = {
      role: "assistant",
      text: "",
      thinking: "",
      opaque: [],
      calls: [],
      model: model.selection,
      usage: data.usage || {},
    };
    if (
      data.stop_reason === "max_tokens" ||
      data.choices?.[0]?.finish_reason === "length" ||
      data.incomplete_details?.reason === "max_output_tokens"
    )
      throw new ProviderError(
        "Provider output length exhausted; tools not dispatched",
        0,
        "length",
      );
    if (model.api === "anthropic-messages") {
      assert(
        !["max_tokens", "content_filter"].includes(data.stop_reason),
        "Incomplete Anthropic response",
      );
      for (const p of data.content || []) {
        if (p.type === "text") r.text += p.text;
        if (p.type === "thinking") {
          r.thinking += p.thinking;
          r.opaque!.push(p);
        }
        if (p.type === "redacted_thinking") r.opaque!.push(p);
        if (p.type === "tool_use")
          r.calls!.push({ id: p.id, name: p.name, arguments: p.input });
      }
    } else if (model.api === "openai-responses") {
      assert(data.status === "completed", "Incomplete Responses result");
      for (const p of data.output || []) {
        if (p.type === "reasoning") r.opaque!.push(p);
        if (p.type === "function_call")
          r.calls!.push({
            id: p.call_id,
            name: p.name,
            arguments: JSON.parse(p.arguments),
          });
        for (const c of p.content || [])
          if (c.type === "output_text") r.text += c.text;
      }
    } else {
      const choice = data.choices?.[0];
      assert(
        choice && !["length", "content_filter"].includes(choice.finish_reason),
        "Incomplete completion",
      );
      const m = choice.message;
      r.text = m.content || "";
      r.thinking = m.reasoning_content || "";
      r.calls = (m.tool_calls || []).map((c: Obj) => ({
        id: c.id,
        name: c.function.name,
        arguments: JSON.parse(c.function.arguments),
      }));
    }
    for (const call of r.calls!)
      assert(
        call.id &&
          call.name &&
          call.arguments &&
          !Array.isArray(call.arguments),
        "Invalid tool call",
      );
    return r;
  }
}
