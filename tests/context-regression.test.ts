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
  const store = new Store(":memory:"),
    auth = new Subscriptions(store, ""),
    engine = new Engine(
      store,
      new Catalog(store, auth),
      new Chrome(store, new ChromeBridge(), ""),
    );
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
    session = store.newSession(),
    tools = new Tools(
      engine,
      session,
      config,
      new AbortController().signal,
      () => {},
    ),
    model = resolveModel(config);
  let calls = 0;
  engine.providers.chat = async (_model, _system, messages) => {
    calls++;
    const text = messages[0].text!;
    assert(
      text.length < 16000,
      "Encoded image/signature leaked into summary input",
    );
    assert(!text.includes("a".repeat(1000)));
    if (calls === 2)
      assert(
        !text.includes("original-assistant-0"),
        "Previous fold originals were re-expanded",
      );
    return {
      role: "assistant",
      text:
        "Finished work checkpoint " +
        calls +
        ": preserve original user requirements and evidence; older images remain archived, with no inferred content.",
    };
  };
  try {
    for (let i = 0; i < 14; i++) {
      store.append(session.id, { role: "user", text: "user-" + i });
      store.append(session.id, {
        role: "assistant",
        text: "original-assistant-" + i,
        images: [{ mime: "image/png", data: "a".repeat(1000000) }],
        opaque: [{ type: "reasoning", encrypted_content: "a".repeat(1000000) }],
      });
    }
    await engine.compact(tools, model, "system", true);
    for (let i = 0; i < 8; i++) {
      store.append(session.id, { role: "user", text: "later-" + i });
      store.append(session.id, { role: "assistant", text: "later result" });
    }
    await engine.compact(tools, model, "system", true);
    assert.equal(calls, 2);
    assert(
      store
        .messages(session.id)
        .some((m) => m.images?.[0]?.data?.length === 1000000),
      "Archived image original was lost",
    );
    assert.equal(
      new Context(store, session.id).folds().filter((f) => f.active).length,
      1,
    );
  } finally {
    await tools.close();
    await engine.close();
    store.close();
  }
});
test("Stage never labels intermediate tool-call commentary as a source conclusion", () => {
  const store = new Store(":memory:"),
    source = store.newSession();
  store.append(source.id, { role: "user", text: "do the task" });
  store.append(source.id, {
    role: "assistant",
    text: "I am about to submit",
    calls: [{ id: "c", name: "write", arguments: { path: "x", content: "y" } }],
  });
  assert(
    !new Context(store, source.id).stage().includes("I am about to submit"),
  );
  store.append(source.id, { role: "tool", callId: "c", text: "done" });
  store.append(source.id, { role: "assistant", text: "verified complete" });
  assert(new Context(store, source.id).stage().includes("verified complete"));
  store.close();
});
