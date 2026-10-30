import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Context } from "../server/core/context";
test("billion-context pressure chooses T2/T3 distillation when block summaries dominate remaining raw history", () => {
  const store = new Store(":memory:"),
    session = store.newSession(),
    ctx = new Context(store, session.id);
  try {
    store.append(session.id, { role: "user", text: "original goal" });
    for (let n = 0; n < 10; n++) {
      store.append(session.id, {
        role: "assistant",
        calls: [{ id: "c" + n, name: "read", arguments: {} }],
      });
      store.append(session.id, {
        role: "tool",
        callId: "c" + n,
        name: "read",
        text: "historical facts ".repeat(6000),
      });
      store.append(session.id, { role: "assistant", text: "done" });
    }
    store.append(session.id, { role: "user", text: "latest request" });
    const first = ctx.compress([
      {
        startRef: "m00003",
        endRef: "m00006",
        summary: "source checkpoint one ".repeat(900),
      },
      {
        startRef: "m00009",
        endRef: "m00012",
        summary: "source checkpoint two ".repeat(900),
      },
      {
        startRef: "m00015",
        endRef: "m00018",
        summary: "source checkpoint tri ".repeat(900),
      },
      {
        startRef: "m00021",
        endRef: "m00027",
        summary: "source checkpoint for ".repeat(900),
      },
    ]);
    ctx.configure(60000, 8000, 10, "p/m");
    assert(ctx.nudge()?.includes("tier-1 blocks into tier-2"));
    const left = ctx.compress([
        {
          startRef: first[0].id,
          endRef: first[1].id,
          summary: "distilled left facts ".repeat(700),
        },
      ])[0],
      right = ctx.compress([
        {
          startRef: first[2].id,
          endRef: first[3].id,
          summary: "distilled right facts ".repeat(700),
        },
      ])[0];
    ctx.configure(40000, 8000, 10, "p/m");
    assert(ctx.nudge()?.includes("tier-2 blocks into tier-3"));
    const top = ctx.compress([
      {
        startRef: left.id,
        endRef: right.id,
        summary:
          "All finished work is distilled into one checkpoint retaining original scope, significant facts, decisions and remaining work.",
      },
    ])[0];
    assert.equal(top.tier, 3);
    assert(ctx.promptTokens() < 40000);
  } finally {
    store.close();
  }
});
