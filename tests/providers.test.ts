import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Store, type Message } from "../server/core/store";
import { promptHistory, archivedResult } from "../server/core/history";
import { Providers, ProviderError, bodyFor, type Tool } from "../server/core/provider";
import { resolveModel } from "../server/core/config";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import {
  ConnectDecoder,
  decodeProto,
  encodeDevin,
  envelope,
  fieldBytes,
  fieldNumber,
} from "../server/core/devin";
import { Vault } from "../server/core/vault";
const cleanup: (() => any)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function http(body: string | Buffer, type = "text/event-stream") {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", type);
    for (let i = 0; i < body.length; i += 17)
      res.write(
        typeof body === "string"
          ? body.slice(i, i + 17)
          : body.subarray(i, i + 17),
      );
    res.end();
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  cleanup.push(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
const tool: Tool = {
  name: "read",
  description: "read",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
function model(api: string, url: string) {
  return resolveModel({
    model: "p/m",
    provider: {
      p: {
        api,
        baseURL: url,
        models: {
          m: {
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text", "image"] },
          },
        },
      },
    },
  });
}
test("thinking-only and blank replies are incomplete across native, streaming and JSON providers", async () => {
  const sse = (frames: any[]) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const cases: [string, string | Buffer, string][] = [
    ["devin", Buffer.concat([envelope(Buffer.concat([fieldBytes(9, "I should create a task"), fieldNumber(5, 1)])), envelope(Buffer.from("{}"), 2)]), "application/connect+proto"],
    ["devin", Buffer.concat([envelope(Buffer.concat([fieldBytes(9, "Output budget spent thinking"), fieldNumber(5, 3)])), envelope(Buffer.from("{}"), 2)]), "application/connect+proto"],
    ["openai-completions", sse([{ choices: [{ delta: { reasoning_content: "I should create a task", content: " \n\t" }, finish_reason: "stop" }] }]), "text/event-stream"],
    ["anthropic-messages", sse([{ type: "content_block_start", content_block: { type: "thinking", thinking: "I should create a task" } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]), "text/event-stream"],
    ["openai-responses", sse([{ type: "response.completed", response: { status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "I should create a task" }] }] } }]), "text/event-stream"],
    ["openai-completions", JSON.stringify({ choices: [{ message: { reasoning_content: "I should create a task", content: " \n" }, finish_reason: "stop" }] }), "application/json"],
    ["anthropic-messages", JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "I should create a task" }] }), "application/json"],
    ["openai-responses", JSON.stringify({ status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "I should create a task" }] }] }), "application/json"],
  ];
  for (const [api, payload, type] of cases) {
    const m = model(api, await http(payload, type));
    m.apiKey = "fixture";
    await assert.rejects(new Providers().chat(m, "sys", [{ role: "user", text: "please handle this" }], [tool], new AbortController().signal), (error: any) => error instanceof ProviderError && error.kind === "empty", `${api} ${type} cannot silently complete with thinking only`);
  }
});

test("all three standard protocols stream tools, thinking and usage", async () => {
  const cases = [
    [
      "openai-completions",
      `data: {"choices":[{"index":0,"delta":{"reasoning_content":"consider"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read","arguments":"{\\\"path\\\":\\\"a\\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":42}}\n\ndata: [DONE]\n\n`,
    ],
    [
      "openai-responses",
      [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "i",
            call_id: "c",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "i",
          delta: '{"path":"a"}',
        },
        {
          type: "response.completed",
          response: {
            id: "r",
            status: "completed",
            usage: { total_tokens: 42 },
          },
        },
      ]
        .map((v) => "data: " + JSON.stringify(v) + "\n\n")
        .join(""),
    ],
    [
      "anthropic-messages",
      [
        { type: "message_start", message: { usage: { input_tokens: 20 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "consider" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "signed" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "c", name: "read", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 22 },
        },
        { type: "message_stop" },
      ]
        .map((v) => "data: " + JSON.stringify(v) + "\n\n")
        .join(""),
    ],
  ];
  for (const [api, body] of cases) {
    const url = await http(body);
    const result = await new Providers().chat(
      model(api, url),
      "sys",
      [],
      [tool],
      new AbortController().signal,
    );
    assert.equal(result.calls?.length, 1, api);
    assert.deepEqual(result.calls![0].arguments, { path: "a" }, api);
  }
});
test("truncated, malformed or incomplete streams never dispatch tools", async () => {
  const bodies = [
    [
      "openai-completions",
      "data: " +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }) +
        "\n\n",
    ],
    [
      "openai-responses",
      "data: " +
        JSON.stringify({
          type: "response.incomplete",
          response: { status: "incomplete" },
        }) +
        "\n\n",
    ],
    [
      "anthropic-messages",
      "data: " +
        JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "c", name: "read", input: {} },
        }) +
        "\n\n",
    ],
  ];
  for (const [api, body] of bodies) {
    const url = await http(body);
    await assert.rejects(() =>
      new Providers().chat(
        model(api, url),
        "sys",
        [],
        [tool],
        new AbortController().signal,
      ),
    );
  }
});
test("wire history preserves tool-call IDs, images and signed reasoning without leaking connection options", async () => {
  for (const api of [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
  ]) {
    const m = model(api, "https://example.com/v1");
    m.apiKey = "private-key";
    m.options = {
      apiKey: "private-key",
      baseURL: "https://example.com/v1",
      reasoningEffort: "high",
    };
    const { body } = await bodyFor(
          m,
          "sys",
          [
            {
              role: "assistant",
              model: m.selection,
              thinking: "why",
              opaque: [{ type: "thinking", thinking: "why", signature: "sig" }],
              calls: [{ id: "call|item", name: "read", arguments: { path: "x" } }],
            },
            {
              role: "tool",
              callId: "call|item",
              name: "read",
              text: "done",
              images: [{ mime: "image/png", data: "abc" }],
            },
          ],
          [tool],
        );
    assert(!JSON.stringify(body).includes("private-key"));
    assert(
      JSON.stringify(body).includes("data") ||
        JSON.stringify(body).includes("base64"),
    );
    assert(!JSON.stringify(body).includes("call|item"));
  }
});
test("Chrome history keeps only the latest two image results per tab through ACP and every provider", async () => {
  const rows: Message[] = [];
  const observe = (tab: string, images: { path: string; frameStream?: string; tile?: number; readOnlyImage?: boolean }[], name = "chrome_act") => {
    const callId = "shot-" + rows.length;
    rows.push(
      { role: "assistant", calls: [{ id: callId, name, arguments: {} }] },
      { role: "tool", name, callId,
        text: `[m${String(rows.length + 1).padStart(5, "0")}] ` + JSON.stringify({
          tabTag: tab, snapshotId: callId, pages: [{ text: callId }], completedActions: 1,
          documentPath: "/files/" + callId + ".json",
          images,
        }),
        images: images.map(({ path }) => ({ mime: "image/webp", path })),
      },
    );
  };
  observe("C1", [{ path: "view-old", frameStream: "C1:viewport" }], "chrome_navigate");
  observe("C1", [{ path: "tile0", frameStream: "C1:document:0", tile: 0 }, { path: "tile1", frameStream: "C1:document:1", tile: 1 }], "chrome_screenshot");
  observe("C1", [{ path: "crop" }], "chrome_screenshot");
  observe("C1", [{ path: "scroll", readOnlyImage: true }], "chrome_screenshot");
  observe("C1", [{ path: "view-a", frameStream: "C1:viewport" }], "chrome_navigate");
  observe("C1", [{ path: "tile0-new", frameStream: "C1:document:0", tile: 0 }, { path: "tile1-new", frameStream: "C1:document:1", tile: 1 }], "chrome_screenshot");
  observe("C1", [{ path: "view-b", frameStream: "C1:viewport" }]);
  observe("C1", [{ path: "view-b", frameStream: "C1:viewport" }]);
  observe("C2", [{ path: "other-tab", frameStream: "C2:viewport" }]);
  rows.push(
    { role: "assistant", calls: [{ id: "plain", name: "read", arguments: {} }] },
    { role: "tool", name: "read", callId: "plain", text: "image file", images: [{ mime: "image/png", blobId: "plain-1" }, { mime: "image/png", blobId: "plain-2" }, { mime: "image/png", blobId: "plain-3" }] },
  );
  const original = structuredClone(rows);
  // Older captures (viewport, tiles, crop, read-only scroll area) are stale; one capture's tiles stay together,
  // an unchanged repeated frame counts once, other tabs and non-Chrome images are untouched.
  const expected = ["tile0-new", "tile1-new", "view-b", "other-tab", "plain-1", "plain-2", "plain-3"];
  const projected = promptHistory(rows);
  assert.deepEqual(projected.flatMap(m => (m.images || []).map(image => image.path || image.blobId)), expected);
  assert.deepEqual(promptHistory(projected), projected, "repeated projection must keep attachment/metadata alignment");
  const old = JSON.parse(projected[1].text!.replace(/^\[m\d+\]\s*/, ""));
  assert.equal(old.pages, undefined);
  assert.equal(old.completedActions, 1);
  assert.equal(old.documentPath, "/files/shot-0.json");
  assert.equal(old.domOmitted, "[DOM 已移出上下文：/files/shot-0.json，需要时用 read 分页读回]");
  // Omitted screenshots are replaced by their paths; metadata goes with them.
  assert.equal(old.images, undefined);
  assert.equal(old.imagesOmitted, "[截图已移出上下文：view-old，需要时用 read 读回；看页面现状请重新截图]");
  const tiles = JSON.parse(projected[3].text!.replace(/^\[m\d+\]\s*/, ""));
  assert.match(tiles.imagesOmitted, /截图已移出上下文：tile0，tile1，/);
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    for (const history of [rows, projected]) {
      const resolved: string[] = [];
      await bodyFor(model(api, "https://example.test/v1"), "", history, [], async image => {
                resolved.push(image.path || image.blobId!);
                return { mime: image.mime, data: "AA==" };
              });
      assert.deepEqual(resolved, expected, api);
    }
  }
  assert.deepEqual(rows, original, "canonical history and image metadata remain archived intact");
});

test("oversized Chrome results stay prunable after archiving", () => {
  const rows: Message[] = [];
  const observe = (id: string, big: boolean) => {
    const value = {
      tabTag: "C1", snapshotId: id, documentPath: "/files/" + id + ".json",
      images: [{ path: id, frameStream: "C1:viewport" }],
      pages: [{ text: (id + " ").repeat(big ? 20000 : 1) }],
    };
    const raw = JSON.stringify(value);
    rows.push(
      { role: "assistant", calls: [{ id, name: "chrome_inspect", arguments: {} }] },
      { role: "tool", name: "chrome_inspect", callId: id, images: [{ mime: "image/webp", path: id }],
        text: big ? archivedResult("chrome_inspect", value, raw, "/files/output-" + id + ".json") : raw },
    );
  };
  observe("big", true);
  const archived = JSON.parse(rows[1].text!);
  assert.equal(archived.tabTag, "C1");
  assert.equal(archived.archivePath, "/files/output-big.json");
  assert(archived.preview.length < 33000 && archived.preview.includes("big big"));
  assert.equal(archived.images[0].frameStream, "C1:viewport");
  assert(JSON.parse(archivedResult("read", { x: "y".repeat(40000) }, "z".repeat(40000), "/files/output-r.json")).preview);
  for (const id of ["a", "b"]) observe(id, false);
  const projected = promptHistory(rows);
  const old = JSON.parse(projected[1].text!);
  assert.equal(old.preview, undefined);
  assert(old.domOmitted && old.imagesOmitted);
  assert.equal(old.archivePath, "/files/output-big.json");
  assert.deepEqual(projected.flatMap(m => (m.images || []).map(image => image.path)), ["a", "b"]);
});

test("native reasoning is replayed only to its source model and remains untouched in history", async () => {
  for (const api of ["openai-responses", "anthropic-messages"]) {
    const m = model(api, "https://example.test/v1");
    const opaque = api === "openai-responses"
      ? { type: "reasoning", id: "rs-native", encrypted_content: "native-secret", summary: [] }
      : { type: "thinking", thinking: "visible", signature: "native-secret" };
    const history = [{ role: "assistant" as const, model: m.selection, text: "answer", opaque: [opaque] }];
    const before = structuredClone(history);
    assert(JSON.stringify((await bodyFor(m, "sys", history, [])).body).includes("native-secret"));
    assert(!JSON.stringify((await bodyFor({ ...m, selection: "other/model" }, "sys", history, [])).body).includes("native-secret"));
    assert.deepEqual(history, before);
  }
});
test("Devin model resolution enables native reasoning replay for configured models", async () => {
  const store = await Store.open(":memory:");
  cleanup.push(async () => await store.close());
  const catalog = new Catalog(store, new Subscriptions(store, ""));
  catalog.models = async () => ({
    models: {}, raw: [{ variants: [{ model_uid: "m" }] }], version: "fixture-version",
  });
  const m = await catalog.resolve({
    model: "p/m", provider: { p: { api: "devin", baseURL: "https://fixture.test", models: { m: {} } } },
  });
  assert.equal(m.options.requiresReasoningContentOnAssistantMessages, true);
  const { body } = await bodyFor(m, "sys", [{ role: "assistant", text: "answer", thinking: "visible reasoning" }], []);
  assert.equal(body.messages[1].reasoning_content, "visible reasoning");
  const wire = encodeDevin(body, "fixture-key", "fixture-version");
  const message = decodeProto(wire.subarray(5)).find(([f]) => f === 3)![1] as Buffer;
  const thinking = decodeProto(message).find(([f]) => f === 5)![1] as Buffer;
  assert.equal(thinking.toString(), "visible reasoning");
});
test("Devin protobuf request fields and fragmented gzip Connect trailer validation", () => {
  const raw = encodeDevin(
    {
      model: "claude-model",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "fixture reasoning",
          tool_calls: [
            { id: "c", function: { name: "read", arguments: '{"path":"x"}' } },
          ],
        },
        { role: "tool", tool_call_id: "c", content: "result" },
      ],
      tools: [
        {
          function: {
            name: "read",
            description: "read",
            parameters: { type: "object" },
          },
        },
      ],
      max_tokens: 2000,
    },
    "secret-key",
    "3000.11.205",
  );
  assert.equal(raw[0], 0);
  const fields = decodeProto(raw.subarray(5));
  assert(
    fields.some(
      ([f, v]) =>
        f === 21 && Buffer.isBuffer(v) && v.toString() === "claude-model",
    ),
  );
  const metadata = fields.find(([f]) => f === 1)![1] as Buffer;
  assert(
    decodeProto(metadata).some(
      ([f, v]) =>
        f === 3 && Buffer.isBuffer(v) && v.toString() === "secret-key",
    ),
  );
  const thinking = fields.filter(([f]) => f === 3).flatMap(([, v]) => decodeProto(v as Buffer)).filter(([f]) => f === 5);
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0][1] as Buffer).toString(), "fixture reasoning");
  const text = fieldBytes(3, "answer"),
    good = Buffer.concat([
      envelope(gzipSync(text), 1),
      envelope(Buffer.from("{}"), 2),
    ]);
  const decoder = new ConnectDecoder(),
    frames: Buffer[] = [];
  for (let i = 0; i < good.length; i++)
    frames.push(...decoder.push(good.subarray(i, i + 1)));
  decoder.finish();
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], text);
  const truncated = new ConnectDecoder();
  truncated.push(envelope(text));
  assert.throws(() => truncated.finish());
  assert.throws(() =>
    new ConnectDecoder().push(
      envelope(Buffer.from('{"error":{"code":"unauthenticated"}}'), 2),
    ),
  );
  assert.throws(() => decodeProto(Buffer.from([0])));
  assert.throws(() =>
    decodeProto(
      Buffer.from([10, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
    ),
  );
});
test("Devin native HTTP validates all declared calls before returning any", async () => {
  const response = Buffer.concat([
    envelope(
      Buffer.concat([
        fieldNumber(5, 10),
        fieldBytes(
          6,
          Buffer.concat([
            fieldBytes(1, "c"),
            fieldBytes(2, "read"),
            fieldBytes(3, '{"path":"x"}'),
          ]),
        ),
      ]),
    ),
    envelope(Buffer.from("{}"), 2),
  ]);
  const url = await http(response, "application/connect+proto");
  const m = model("devin", url);
  m.options.__devinVersion = "3000.11.205";
  m.apiKey = "key";
  const result = await new Providers().chat(
    m,
    "sys",
    [{ role: "user", text: "work" }],
    [tool],
    new AbortController().signal,
  );
  assert.equal(result.calls![0].name, "read");
  const badURL = await http(
    Buffer.concat([
      envelope(
        Buffer.concat([
          fieldNumber(5, 10),
          fieldBytes(
            6,
            Buffer.concat([
              fieldBytes(1, "c"),
              fieldBytes(2, "unknown"),
              fieldBytes(3, "{}"),
            ]),
          ),
        ]),
      ),
      envelope(Buffer.from("{}"), 2),
    ]),
    "application/connect+proto",
  );
  await assert.rejects(() =>
    new Providers().chat(
      { ...m, baseURL: badURL },
      "sys",
      [],
      [tool],
      new AbortController().signal,
    ),
  );
});
test("CodeBuddy and WorkBuddy identities remain separate, CLI env credentials and catalog merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-buddy-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const env = {
    CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR,
    WORKBUDDY_CONFIG_DIR: process.env.WORKBUDDY_CONFIG_DIR,
    CODEBUDDY_AUTH_TOKEN: process.env.CODEBUDDY_AUTH_TOKEN,
    WORKBUDDY_AUTH_TOKEN: process.env.WORKBUDDY_AUTH_TOKEN,
    NOVA_CODEBUDDY_ENDPOINT: process.env.NOVA_CODEBUDDY_ENDPOINT,
    NOVA_WORKBUDDY_ENDPOINT: process.env.NOVA_WORKBUDDY_ENDPOINT,
  };
  Object.assign(process.env, {
    CODEBUDDY_CONFIG_DIR: dir,
    WORKBUDDY_CONFIG_DIR: dir,
    CODEBUDDY_AUTH_TOKEN: "codebuddy-key",
    WORKBUDDY_AUTH_TOKEN: "workbuddy-key",
  });
  cleanup.push(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const s = await Store.open(":memory:");
  cleanup.push(async () => await s.close());
  const auth = new Subscriptions(s, "");
  const code = await auth.load("codebuddy"),
    work = await auth.load("workbuddy");
  assert.equal(code.options.apiKey, "codebuddy-key");
  assert.equal(work.options.apiKey, "workbuddy-key");
  assert.equal(code.options.headers["X-Product"], "CodeBuddy");
  assert.equal(work.options.headers["X-Product"], "WorkBuddy");
  assert.equal(
    auth.normalizeAuth({ accessToken: "a", expiresIn: 60 }, "www.codebuddy.ai")
      .domain,
    "www.codebuddy.ai",
  );
  assert.throws(() => auth.normalizeAuth({ refreshToken: "r" }, "x"));
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer codebuddy-key");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          models: [
            {
              id: "m",
              supportsImages: true,
              supportsReasoning: true,
              maxOutputTokens: 1024,
              reasoning: { supportedEfforts: ["high"] },
            },
          ],
          agents: [{ name: "cli", models: ["m"] }],
        },
      }),
    );
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  cleanup.push(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  process.env.NOVA_CODEBUDDY_ENDPOINT = `http://127.0.0.1:${(server.address() as any).port}`;
  const catalog = new Catalog(s, auth),
    p = await auth.load("codebuddy"),
    models = await catalog.models(p, true);
  assert.equal(models.models.m.modalities.input[1], "image");
  assert.equal(models.models.m.variants.high.reasoningEffort, "high");
});
test("WorkBuddy original encrypted envelope decoder rejects key substitution", () => {
  const require = createRequire(import.meta.url),
    { decodeWorkBuddyToken } = require("../scripts/workbuddy-login.cjs");
  const secret = "workbuddy-build-key",
    key = createHash("sha256").update(secret).digest(),
    keyId = createHash("sha256").update(key).digest("hex").slice(0, 16),
    nonce = randomBytes(12),
    u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    },
    text = (s: string) =>
      Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.concat([
      Buffer.from("WB-AAD\0"),
      Buffer.from([1]),
      text("WBEV1"),
      text("sym-v1"),
      u32(1),
      text(keyId),
      Buffer.from([2, 0, 0]),
    ]),
  );
  const ciphertext = Buffer.concat([
      cipher.update("workbuddy-token"),
      cipher.final(),
    ]),
    sealed = {
      suite: 1,
      keyId,
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
    envelope = {
      $wbEncrypted: 1,
      envelope: Buffer.from(JSON.stringify(sealed)).toString("base64"),
    };
  assert.equal(decodeWorkBuddyToken(envelope, secret), "workbuddy-token");
  assert.throws(() => decodeWorkBuddyToken(envelope, "wrong"));
});
test("Devin login callback requires matching state and PKCE is persisted only as pending memory", async () => {
  const s = await Store.open(":memory:");
  cleanup.push(async () => await s.close());
  const auth = new Subscriptions(s, "");
  cleanup.push(() => auth.close());
  const start = await auth.loginStart("devin"),
    url = new URL(start.url),
    callback = url.searchParams.get("redirect_uri")!;
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const bad = await fetch(callback + "?state=wrong&code=bad");
  assert.equal(bad.status, 400);
  await bad.text();
  const good = await fetch(callback + "?state=" + start.state + "&code=good");
  assert.equal(good.status, 200);
  await good.text();
  assert.equal(auth.pending.get(start.state)?.code, "good");
  assert(!JSON.stringify(await s.objects("model-cache")).includes("code_verifier"));
});
