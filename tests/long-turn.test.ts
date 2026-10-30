import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
test("long Lyra turns are governed by completion/cancellation rather than an artificial80-step cutoff", async () => {
  const store = new Store(":memory:"),
    auth = new Subscriptions(store, ""),
    engine = new Engine(
      store,
      new Catalog(store, auth),
      new Chrome(store, new ChromeBridge(), ""),
    );
  engine.employee.closed = true;
  store.put("config", {
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
  let requests = 0;
  engine.providers.chat = async () =>
    ++requests <= 85
      ? {
          role: "assistant",
          calls: [
            { id: "status-" + requests, name: "context_budget", arguments: {} },
          ],
        }
      : { role: "assistant", text: "finished after85 read-only steps" };
  try {
    const s = store.newSession();
    await engine.run(s.id, {
      role: "user",
      text: "Complete this long read-only verification",
    });
    assert.equal(requests, 86);
    assert.equal(
      store.messages(s.id).filter((m) => m.role === "tool").length,
      85,
    );
  } finally {
    await engine.close();
    store.close();
  }
});
