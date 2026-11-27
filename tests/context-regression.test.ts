import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Tools } from "../server/core/tools";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { resolveModel } from "../server/core/config";
import { Context } from "../server/core/context";
test("automatic compaction summarizes current folded view, not archived binary images or old originals", async () => {
  const store = await Store.open(":memory:"),
    auth = new Subscriptions(store, ""),
    engine = await Engine.create(store, new Catalog(store, auth), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const config: any = {
      model: "p/m",
      provider: {
        p: {
          api: "openai-completions",
          baseURL: "https://unused.test",
          models: { m: { limit: { context: 128000, output: 8192 } } },
        },
      },
      contextMode: "auto",
    },
    session = await store.newSession(),
    tools = await Tools.create(engine, session, config, new AbortController().signal, () => {}),
    model = resolveModel(config);
  let calls = 0;
  engine.providers.chat = async (_model, _system, messages) => {
    calls++;
    for (const rule of ["same language the user", "settled decisions and why", "rejected alternatives", "not execution evidence", "confirming tool results", "verification scope", "explicitly unverified", "merging earlier summaries", "untrusted source data"])
      assert(_system.includes(rule), rule);
    const text = messages[0].text!;
    assert(
      text.length < 16000,
      "Encoded image/signature leaked into summary input",
    );
    assert(!text.includes("a".repeat(1000)));
    assert(!text.includes("fixture-signature"));
    assert(text.includes("否决 Redis") && text.includes("并发未验证"), "decision memory must survive summary merging");
    if (calls === 2)
      assert(
        !text.includes("original-assistant-0"),
        "Previous fold originals were re-expanded",
      );
    return {
      role: "assistant",
      text:
        "检查点 " + calls + "：选择本地缓存，仅单进程；否决 Redis，不增加部署；并发未验证。保留用户要求与验证证据，旧图片已存档，不推断不可见内容。",
    };
  };
  try {
    for (let i = 0; i < 14; i++) {
      await store.append(session.id, { role: "user", text: "user-" + i });
      await store.append(session.id, {
                role: "assistant",
                text: "original-assistant-" + i,
                thinking: "选择本地缓存，仅单进程；否决 Redis，不增加部署；并发未验证。",
                signature: "fixture-signature",
                images: [{ mime: "image/png", data: "a".repeat(1000000) }],
                opaque: [{ type: "reasoning", encrypted_content: "a".repeat(1000000) }],
              });
    }
    await engine.compact(tools, model, "system", true);
    for (let i = 0; i < 8; i++) {
      await store.append(session.id, { role: "user", text: "later-" + i });
      await store.append(session.id, { role: "assistant", text: "later result" });
    }
    await engine.compact(tools, model, "system", true);
    assert.equal(calls, 2);
    assert(
      (await store
                .messages(session.id))
        .some((m) => m.images?.[0]?.data?.length === 1000000),
      "Archived image original was lost",
    );
    assert.equal(
      (await (await Context.open(store, session.id)).folds()).filter((f) => f.active).length,
      1,
    );
  } finally {
    await tools.close();
    await engine.close();
    await store.close();
  }
});
test("Stage never labels intermediate tool-call commentary as a source conclusion", async () => {
  const store = await Store.open(":memory:"),
    source = await store.newSession();
  await store.append(source.id, { role: "user", text: "do the task" });
  await store.append(source.id, {
        role: "assistant",
        text: "I am about to submit",
        calls: [{ id: "c", name: "write", arguments: { path: "x", content: "y" } }],
      });
  assert(
    !(await (await Context.open(store, source.id)).stage()).includes("I am about to submit"),
  );
  await store.append(source.id, { role: "tool", callId: "c", text: "done" });
  await store.append(source.id, { role: "assistant", text: "verified complete" });
  assert((await (await Context.open(store, source.id)).stage()).includes("verified complete"));
  await store.close();
});

test("coding compaction injects code checkpoint rules and preserves host-verified ledger block in saved fold", async () => {
  const store = await Store.open(":memory:"),
    auth = new Subscriptions(store, ""),
    engine = await Engine.create(store, new Catalog(store, auth), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const config: any = {
      model: "p/m",
      provider: {
        p: {
          api: "openai-completions",
          baseURL: "https://unused.test",
          models: { m: { limit: { context: 128000, output: 8192 } } },
        },
      },
      contextMode: "auto",
    },
    session = await store.newSession({ scene: "coding", phaseRole: "code_agent" }),
    tools = await Tools.create(engine, session, config, new AbortController().signal, () => {}),
    model = resolveModel(config);

  let sawCodingSystem = false;
  let sawLedgerInput = false;
  engine.providers.chat = async (_model, system, messages) => {
    sawCodingSystem = system.includes("Coding checkpoint requirements:") && system.includes("DO NOT RE-RUN");
    sawLedgerInput = (messages[0].text || "").includes("### 宿主核验代码还原点");
    return { role: "assistant", text: "阶段总结：已完成服务端修改与基础测试。" };
  };

  try {
    await store.append(session.id, { role: "user", text: "Fix mobile revenue commission and run tests." });
    await store.append(session.id, {
      role: "assistant",
      calls: [
        { id: "c1", name: "edit", arguments: { path: "/ws/be/services/mobile.go" } },
        { id: "c2", name: "bash", arguments: { command: "set -eu\ncd /ws/be\ngo test -vet=off ./services" } },
        { id: "c3", name: "bash", arguments: { command: "set -eu\ncd /ws/be\ngo test -vet=off ./router" } },
      ],
    });
    await store.append(session.id, { role: "tool", callId: "c1", name: "edit", text: JSON.stringify({ path: "/ws/be/services/mobile.go" }) });
    await store.append(session.id, { role: "tool", callId: "c2", name: "bash", text: JSON.stringify({ exitCode: 0, output: "ok\tdashboard-backend/services\t0.2s\n" + "x".repeat(4000) }) });
    await store.append(session.id, { role: "tool", callId: "c3", name: "bash", error: true, text: JSON.stringify({ exitCode: 1, output: "services/datamap: compile: signal: killed" }) });
    // Add recent protected-tail units so the earlier coding span is eligible for folding.
    for (let i = 0; i < 3; i++) {
      await store.append(session.id, { role: "user", text: "follow-up-" + i });
      await store.append(session.id, { role: "assistant", text: "ack-" + i });
    }

    await engine.compact(tools, model, "system", true);
    assert.equal(sawCodingSystem, true);
    assert.equal(sawLedgerInput, true);
    const folds = await (await Context.open(store, session.id)).folds();
    assert.equal(folds.length, 1);
    assert(folds[0].summary.includes("### 宿主核验代码还原点"));
    assert(folds[0].summary.includes("/ws/be/services/mobile.go"));
    assert(folds[0].summary.includes("go test -vet=off ./services"));
    assert(folds[0].summary.includes("services/datamap: compile: signal: killed"));
  } finally {
    await tools.close();
    await engine.close();
    await store.close();
  }
});
