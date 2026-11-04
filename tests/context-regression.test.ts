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
