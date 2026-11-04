import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Context } from "../server/core/context";
test("actual agent loop delivers ACP guide/refs/nudge, executes model compression and uses the new block next request", async () => {
  const store = await Store.open(":memory:"),
    auth = new Subscriptions(store, ""),
    engine = await Engine.create(store, new Catalog(store, auth), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", {
        scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
        model: "p/m",
        contextMode: "acp",
        provider: {
          p: {
            api: "openai-completions",
            baseURL: "https://unused.test",
            models: { m: { limit: { context: 200000, output: 8192 } } },
          },
        },
      });
  const session = await store.newSession();
  await store.append(session.id, { role: "user", text: "Original authorized goal" });
  for (let i = 0; i < 8; i++) {
    await store.append(session.id, {
            role: "assistant",
            calls: [
              { id: "r" + i, name: "read", arguments: { path: "evidence-" + i } },
            ],
          });
    await store.append(session.id, {
            role: "tool",
            callId: "r" + i,
            name: "read",
            text: "evidence for the original goal\n".repeat(1600),
          });
    await store.append(session.id, {
            role: "assistant",
            text: "finished observation " + i,
          });
  }
  const originals = await store.messages(session.id);
  let requests = 0;
  engine.providers.chat = async (_model, system, messages) => {
    requests++;
    assert(system.includes("billion-context/acp-kernel"));
    if (requests === 1) {
      assert(messages.some((m) => m.text?.includes("<context-budget>")));
      assert(messages.some((m) => m.text?.startsWith("[m00003]")));
      return {
        role: "assistant",
        calls: [
          {
            id: "compress",
            name: "compress",
            arguments: {
              ranges: [
                {
                  startRef: "m00003",
                  endRef: "m00015",
                  summary:
                    "Finished evidence review for the original goal. Keep the authorized scope, observed paths, decisions and remaining work; do not infer successful changes or resubmit external operations.",
                },
              ],
            },
          },
        ],
      };
    }
    const visible = JSON.stringify(messages);
    assert(visible.includes('<acp-block id=\\"b1\\"'));
    assert(visible.includes("(folded; the summary now lives in its block)"));
    assert(!messages.some((m) => m.name === "read" && m.callId === "r0"));
    return { role: "assistant", text: "next work finished" };
  };
  try {
    await engine.run(session.id, {
      role: "user",
      text: "Continue only the remaining task",
    });
    assert.equal(requests, 2);
    assert.equal((await (await Context.open(store, session.id)).live()).length, 1);
    assert.deepEqual(
      (await store.messages(session.id)).slice(0, originals.length),
      originals,
    );
    assert((await (await Context.open(store, session.id)).status()).window === 200000);
  } finally {
    await engine.close();
    await store.close();
  }
});
