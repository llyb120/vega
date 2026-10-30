import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine, redactMessage } from "../server/core/engine";
import { Redactor } from "../server/core/util";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Chrome } from "../server/core/chrome";
import { normalizeUsage } from "../server/core/provider";
import { resolveModel } from "../server/core/config";
test("credential redaction preserves wire roles/tool names/opaque signatures/images", () => {
  const r = new Redactor();
  r.add("a");
  const image = { mime: "image/png", data: "aaa_base64" },
    message = redactMessage(
      {
        role: "assistant",
        text: "a",
        model: "a/model",
        calls: [{ id: "a-call", name: "bash", arguments: { command: "a" } }],
        images: [image],
        opaque: [
          {
            type: "reasoning",
            id: "a-id",
            encrypted_content: "aaa",
            content: [{ type: "reasoning_text", text: "a" }],
            summary: [{ type: "summary_text", text: "a" }],
          },
        ],
      },
      r,
    );
  assert.equal(message.role, "assistant");
  assert.equal(message.model, "a/model");
  assert.equal(message.calls![0].id, "a-call");
  assert.equal(message.calls![0].name, "bash");
  assert.notEqual(message.calls![0].arguments.command, "a");
  assert.equal(message.images![0].data, "aaa_base64");
  assert.equal(message.opaque![0].content[0].type, "reasoning_text");
  assert.notEqual(message.opaque![0].content[0].text, "a");
  assert.equal(message.opaque![0].encrypted_content, "aaa");
});
test("a secret equal to event type cannot hide SSE completion or corrupt tool IDs", async () => {
  const store = new Store(":memory:"),
    auth = new Subscriptions(store, ""),
    engine = new Engine(
      store,
      new Catalog(store, auth),
      new Chrome(store, new ChromeBridge(), ""),
    );
  engine.employee.closed = true;
  const r = new Redactor();
  r.add("done");
  engine.redactors.set("session", r);
  let seen: any;
  engine.events.once("event", (event) => (seen = event));
  engine.emit({ type: "done", session: "session", data: { text: "done" } });
  assert.equal(seen.type, "done");
  assert.equal(seen.session, "session");
  assert.notEqual(seen.data.text, "done");
  await engine.close();
  store.close();
});
test("usage is normalized for cache reads/writes across all three protocols", () => {
  assert.deepEqual(
    normalizeUsage("openai-completions", {
      prompt_tokens: 20,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 5 },
    }),
    { input: 15, output: 8, cacheRead: 5, cacheWrite: 0, totalTokens: 28 },
  );
  assert.deepEqual(
    normalizeUsage("anthropic-messages", {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 4,
    }),
    { input: 10, output: 3, cacheRead: 7, cacheWrite: 4, totalTokens: 24 },
  );
  assert.equal(
    normalizeUsage("openai-responses", {
      input_tokens: 20,
      output_tokens: 8,
      total_tokens: 28,
      input_tokens_details: { cached_tokens: 5 },
    }).input,
    15,
  );
});
test("model header inheritance supports explicit null without losing unrelated headers", () => {
  const m = resolveModel({
    model: "p/m",
    provider: {
      p: {
        api: "openai-completions",
        options: {
          baseURL: "https://example.com",
          headers: { A: "keep", B: "remove" },
        },
        models: { m: { options: { headers: { B: null, C: "new" } } } },
      },
    },
  });
  assert.equal(m.headers.A, "keep");
  assert.equal(m.headers.B, undefined);
  assert.equal(m.headers.C, "new");
});
