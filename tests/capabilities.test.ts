import { test } from "node:test";
import assert from "node:assert/strict";
import { convertCatalog } from "../server/core/model-capabilities";
import { wireOptions } from "../server/core/config";
test("original CommandCode endpoint fixture: mixed protocols, agent-only filtering", () => {
  const models = convertCatalog({
    data: [
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        context_length: 1000000,
        supported_endpoints: ["/messages"],
      },
      {
        id: "deepseek/deepseek-v4-pro",
        context_length: 1000000,
        supported_endpoints: ["/chat/completions", "/responses"],
      },
      { id: "jev-1", supported_endpoints: ["/systemone"] },
      { id: "odd", supported_endpoints: ["/systemone"] },
    ],
  });
  assert.deepEqual(models["claude-opus-5-5"], {
    api: "anthropic-messages",
    name: "Claude Opus 5.5",
    limit: { context: 1000000 },
  });
  assert.deepEqual(models["deepseek/deepseek-v4-pro"], {
    limit: { context: 1000000 },
  });
  assert(!models["jev-1"] && !models.odd);
});
test("original models.dev fallback fixture: no /models, deprecated/non-agent filtering", () => {
  const meta = {
    npm: "@ai-sdk/anthropic",
    models: {
      m3: { name: "M3", interleaved: { field: "reasoning_content" } },
      old: { status: "deprecated" },
      research: { tool_call: false },
    },
  };
  assert.deepEqual(convertCatalog(null, meta), {
    m3: {
      api: "anthropic-messages",
      name: "M3",
      options: { requiresReasoningContentOnAssistantMessages: true },
    },
  });
});
test("own provider output limits take priority over cross-provider capabilities", () => {
  const id = "deepseek/deepseek-v4.1-flash",
    catalog = {
      deepseek: {
        models: {
          "deepseek-v4.1-flash": {
            limit: { context: 1048576, output: 1048576 },
          },
        },
      },
      commandcode: {
        models: {
          [id]: {
            canonical_model_id: id,
            limit: { context: 1000000, output: 384000 },
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["high"] }],
          },
        },
      },
    };
  const result = convertCatalog(
    {
      data: [
        {
          id,
          context_length: 1000000,
          supported_endpoints: ["/chat/completions"],
        },
      ],
    },
    undefined,
    catalog,
    "commandcode",
  );
  assert.deepEqual(result[id].limit, { context: 1000000, output: 384000 });
  assert.equal(result[id].api, undefined);
  assert(result[id].variants.high);
});
test("vendor thinking parameters are translated rather than leaking capability metadata", () => {
  const base: any = {
    selection: "p/m",
    provider: "p",
    id: "m",
    api: "openai-completions",
    baseURL: "https://example.com",
    apiKey: "x",
    headers: {},
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsImages: false,
  };
  const qwen = wireOptions({
    ...base,
    options: {
      thinkingFormat: "qwen",
      reasoningEffort: "none",
      supportsThinkingToggle: true,
    },
  });
  assert.equal(qwen.enable_thinking, false);
  assert.equal(qwen.thinkingFormat, undefined);
  assert.equal(qwen.reasoning_effort, undefined);
  const zai = wireOptions({
    ...base,
    options: {
      thinkingFormat: "zai",
      reasoningEffort: "none",
      supportsThinkingToggle: false,
    },
  });
  assert.equal(zai.thinking.type, "enabled");
  const router = wireOptions({
    ...base,
    options: { thinkingFormat: "openrouter", reasoningEffort: "high" },
  });
  assert.equal(router.reasoning.effort, "high");
});
