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

test("lean openai-compatible catalog: builtin table fills when models.dev misses", () => {
  const models = convertCatalog({
    data: [
      { id: "gpt-5.5", object: "model", created: 1, owned_by: "openai" },
      { id: "gpt-6.1-sol", object: "model", created: 1, owned_by: "openai" },
      { id: "grok-4.7", object: "model", created: 1, owned_by: "xai" },
      { id: "gpt-image-2", object: "model", created: 1, owned_by: "openai" },
      { id: "GPT-5.5", object: "model", created: 1, owned_by: "openai" },
    ],
  });
  for (const id of ["gpt-5.5", "gpt-6.1-sol", "grok-4.7"]) {
    assert.equal(models[id].limit.context, 200000, id + " context");
    assert.equal(models[id].limit.output, 128000, id + " output");
    assert.equal(models[id].reasoning, true, id + " reasoning");
    assert.equal(models[id].options.supportsReasoningEffort, true, id + " effort flag");
    assert.deepEqual(
      Object.keys(models[id].variants).sort(),
      ["high", "low", "medium"],
      id + " variants",
    );
  }
  assert.equal(models["gpt-image-2"].reasoning, false);
  assert.equal(models["gpt-image-2"].variants, undefined);
  assert.deepEqual(models["gpt-image-2"].modalities?.input, ["text", "image"]);
  assert.equal(models["gpt-image-2"].limit.context, 32000);
  // Case-insensitive exact id match still enriches.
  assert.equal(models["GPT-5.5"].reasoning, true);
  assert.ok(models["GPT-5.5"].variants.high);
});

test("openai-compatible lean catalog: models.dev enriches before builtin table", () => {
  const catalog = {
    openai: {
      npm: "@ai-sdk/openai",
      models: {
        "gpt-5.5": {
          limit: { context: 1050000, output: 128000 },
          reasoning: true,
          reasoning_options: [
            { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
          ],
        },
      },
    },
  };
  const models = convertCatalog(
    {
      data: [
        { id: "gpt-5.5", object: "model", created: 1, owned_by: "openai" },
        // Not in models.dev fixture → builtin last resort
        { id: "gpt-live-1-mini", object: "model", created: 1, owned_by: "openai" },
      ],
    },
    undefined,
    catalog,
    "openai-compatible",
  );
  assert.equal(models["gpt-5.5"].limit.context, 1050000);
  assert.equal(models["gpt-5.5"].limit.output, 128000);
  assert.equal(models["gpt-5.5"].reasoning, true);
  assert.deepEqual(
    Object.keys(models["gpt-5.5"].variants).sort(),
    ["high", "low", "medium", "none", "xhigh"],
  );
  // Builtin only fills ids models.dev did not cover.
  assert.equal(models["gpt-live-1-mini"].limit.context, 128000);
  assert.equal(models["gpt-live-1-mini"].options.reasoningEffort, "low");
  assert.ok(models["gpt-live-1-mini"].variants.medium);
});

test("priority: gateway fields > models.dev > builtin table", () => {
  const catalog = {
    openai: {
      models: {
        "gpt-5.5": {
          limit: { context: 1050000, output: 128000 },
          reasoning: true,
          reasoning_options: [
            { type: "effort", values: ["none", "low", "medium", "high"] },
          ],
        },
      },
    },
  };
  const models = convertCatalog(
    {
      data: [
        {
          id: "gpt-5.5",
          context_length: 400000,
          max_output_tokens: 50000,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["high", "low"] }],
          supported_endpoints: ["/chat/completions"],
        },
      ],
    },
    undefined,
    catalog,
    "openai-compatible",
  );
  assert.deepEqual(models["gpt-5.5"].limit, { context: 400000, output: 50000 });
  assert.deepEqual(Object.keys(models["gpt-5.5"].variants).sort(), ["high", "low"]);
});

test("gateway capability fields win over builtin table", () => {
  const models = convertCatalog({
    data: [
      {
        id: "gpt-5.5",
        context_length: 400000,
        max_output_tokens: 50000,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["high", "low"] }],
        supported_endpoints: ["/chat/completions"],
      },
    ],
  });
  assert.deepEqual(models["gpt-5.5"].limit, { context: 400000, output: 50000 });
  assert.deepEqual(Object.keys(models["gpt-5.5"].variants).sort(), ["high", "low"]);
});

test("gpt-6-astra / gpt-6.1-sol special responses selection stays intact with builtin enrich", () => {
  const models = convertCatalog({
    data: [
      {
        id: "gpt-6-astra",
        supported_endpoints: ["/responses", "/chat/completions"],
      },
      {
        id: "gpt-6.1-sol",
        supported_endpoints: ["/responses", "/chat/completions"],
      },
      {
        id: "other-model",
        supported_endpoints: ["/responses", "/chat/completions"],
      },
    ],
  });
  assert.equal(models["gpt-6-astra"].api, "openai-responses");
  assert.equal(models["gpt-6.1-sol"].api, "openai-responses");
  assert.equal(models["other-model"].api, undefined);
  assert.equal(models["gpt-6-astra"].reasoning, true);
  assert.ok(models["gpt-6-astra"].variants.medium);
});
