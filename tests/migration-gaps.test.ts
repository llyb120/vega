import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPath, textSlice } from "../server/core/file-read";
import { builtinCommand, expandBuiltin } from "../server/core/builtins";
import { Store } from "../server/core/store";
import { Context } from "../server/core/context";
import { Engine, recoveryModel } from "../server/core/engine";
import { Tools } from "../server/core/tools";
import { ProviderError } from "../server/core/provider";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { resolveModel } from "../server/core/config";
function engine() {
  const store = new Store(":memory:"),
    auth = new Subscriptions(store, ""),
    e = new Engine(
      store,
      new Catalog(store, auth),
      new Chrome(store, new ChromeBridge(), ""),
    );
  e.employee.closed = true;
  const config: any = {
    model: "p/m",
    contextMode: "acp",
    provider: {
      p: {
        api: "openai-completions",
        baseURL: "https://unused.test",
        models: {
          m: {
            reasoning: true,
            options: { reasoningEffort: "high" },
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    },
  };
  store.put("config", config);
  return { e, store, config };
}
test("output-length recovery lowers effort only once and never replays already completed mutations", async () => {
  const { e, store, config } = engine(),
    dir = await mkdtemp(join(tmpdir(), "vega-recovery-")),
    session = store.newSession({ cwd: dir });
  let n = 0,
    writes = 0;
  const efforts: string[] = [];
  e.events.on("event", (event) => {
    if (event.type === "tool_start" && event.data.name === "write") writes++;
  });
  e.providers.chat = async (model) => {
    n++;
    efforts.push(model.options.reasoningEffort);
    if (n === 1)
      return {
        role: "assistant",
        calls: [
          {
            id: "write",
            name: "write",
            arguments: { path: "once", content: "only once" },
          },
        ],
      };
    if (n === 2) throw new ProviderError("length", 0, "length");
    return {
      role: "assistant",
      text: "done",
      usage: { input: 100, output: 2 },
    };
  };
  try {
    await e.run(session.id, { role: "user", text: "do work" });
    assert.equal(writes, 1);
    assert.deepEqual(efforts, ["high", "high", "low"]);
    assert.equal(await readFile(join(dir, "once"), "utf8"), "only once");
    assert.equal(config.provider.p.models.m.options.reasoningEffort, "high");
    const model = resolveModel(config);
    model.api = "anthropic-messages";
    model.options.supportsThinkingToggle = true;
    assert.equal(recoveryModel(model)?.options.reasoningEffort, "none");
    model.options.reasoningEffort = "none";
    assert.equal(recoveryModel(model), undefined);
  } finally {
    await e.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("setup virtual config is explicit-authorized, section-scoped and secret-preserving", async () => {
  const { e, store, config } = engine(),
    session = store.newSession(),
    model = resolveModel(config),
    tools = new Tools(
      e,
      session,
      config,
      new AbortController().signal,
      () => {},
    );
  try {
    const value = {
      ...config,
      image: {
        baseURL: "https://images.test/v1",
        apiKey: "test-key",
        models: ["real-id"],
      },
    };
    await assert.rejects(() =>
      tools.execute(
        {
          id: "x",
          name: "write",
          arguments: { path: "sqlite:config", content: JSON.stringify(value) },
        },
        model,
      ),
    );
    tools.setupAccess = "image";
    const result = await tools.execute(
      {
        id: "x",
        name: "write",
        arguments: { path: "sqlite:config", content: JSON.stringify(value) },
      },
      model,
    );
    assert.equal(result.value.image.apiKey, "__stored_secret__");
    assert.equal(e.config().image?.apiKey, "test-key");
    const bad = { ...value, systemPrompt: "injected" };
    await assert.rejects(() =>
      tools.execute(
        {
          id: "y",
          name: "write",
          arguments: { path: "sqlite:config", content: JSON.stringify(bad) },
        },
        model,
      ),
    );
    const read = await tools.read({ path: "sqlite:config" });
    assert(!read.value.text.includes("test-key"));
    assert.equal(builtinCommand("/plan x")?.goal, "x");
    assert.throws(() => builtinCommand("/easy"));
    assert(
      (
        await expandBuiltin(
          { role: "user", text: "[m00001] /plan build thing" },
          config,
        )
      )?.includes("实施计划"),
    );
    assert(
      (
        await expandBuiltin({ role: "user", text: "/easy fix type" }, config)
      )?.includes("不要运行或新增测试"),
    );
    assert(
      (
        await expandBuiltin({ role: "user", text: "/setup-image" }, config)
      )?.includes("不自动发起收费"),
    );
  } finally {
    await tools.close();
    await e.close();
    store.close();
  }
});
test("file read uses actual returned line boundary at50KiB, reports oversized lines without skipping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-read-"));
  try {
    await writeFile(join(dir, "it's.txt"), "abc");
    assert.equal(await readPath(dir, "@it’s.txt"), join(dir, "it's.txt"));
    const value = textSlice(
      Array.from(
        { length: 1000 },
        (_, n) => String(n) + ":" + ".".repeat(100),
      ).join("\n"),
    );
    assert(value.hasMore);
    assert(value.nextOffset < 1001);
    assert(Buffer.byteLength(value.text) <= 50 * 1024);
    assert(value.text.endsWith("."));
    const next = textSlice(
      Array.from(
        { length: 1000 },
        (_, n) => String(n) + ":" + ".".repeat(100),
      ).join("\n"),
      value.nextOffset,
      1,
    );
    assert(next.text.startsWith(String(value.nextOffset) + "|"));
    assert.equal(textSlice("x".repeat(60000)).nextOffset, 1);
    assert(textSlice("x".repeat(60000)).firstLineExceedsLimit);
    assert.throws(() => textSlice("x", 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("fork copies the reversible block ledger without sharing mutable context state or Fire identity", () => {
  const store = new Store(":memory:");
  try {
    const session = store.newSession({ fireRoot: "not-inherited" }),
      ctx = new Context(store, session.id);
    for (let i = 0; i < 16; i++) {
      store.append(session.id, { role: "user", text: "requirement " + i });
      store.append(session.id, {
        role: "assistant",
        text: "evidence ".repeat(600),
      });
    }
    const fold = ctx.compress([
      {
        startRef: "m00001",
        endRef: "m00007",
        summary:
          "Finished checkpoint preserves original requirements, relevant evidence, decisions and all remaining follow-up work.",
      },
    ])[0];
    const copy = store.fork(session.id),
      forked = new Context(store, copy.id);
    assert.equal(forked.live()[0].id, fold.id);
    forked.decompress(fold.id);
    assert.equal(forked.live().length, 0);
    assert.equal(ctx.live().length, 1);
    assert.equal(copy.fireRoot, undefined);
    assert.equal(
      store.messages(copy.id).length,
      store.messages(session.id).length,
    );
  } finally {
    store.close();
  }
});
test("session MCP connection/discovery survives normal turns, refreshes onconfig/cwd and closes at shutdown", async () => {
  const { e, store, config } = engine(),
    session = store.newSession(),
    first = new Tools(
      e,
      session,
      config,
      new AbortController().signal,
      () => {},
    );
  first.mcp.described.set("service/tool", "definition");
  await first.close();
  const next = new Tools(
    e,
    session,
    config,
    new AbortController().signal,
    () => {},
  );
  try {
    assert.equal(next.mcp, first.mcp);
    assert.equal(next.mcp.described.get("service/tool"), "definition");
    const changed = new Tools(
      e,
      session,
      { ...config, mcp: { different: { command: "not-started" } } },
      new AbortController().signal,
      () => {},
    );
    assert.notEqual(changed.mcp, next.mcp);
    await changed.close();
  } finally {
    await e.close();
    assert.equal(e.mcpSessions.size, 0);
    store.close();
  }
});
