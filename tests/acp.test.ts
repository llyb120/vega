import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Message } from "../server/core/store";
import { Context, estimate, ACP_GUIDE } from "../server/core/context";
import { units, protectedStart, promptHistory } from "../server/core/history";
function fixture(count = 10, size = 6000) {
  const store = new Store(":memory:"),
    session = store.newSession(),
    ctx = new Context(store, session.id);
  store.append(session.id, { role: "user", text: "original requirement" });
  for (let n = 0; n < count; n++) {
    store.append(session.id, {
      role: "assistant",
      calls: [{ id: "c" + n, name: "read", arguments: { path: "f" + n } }],
    });
    store.append(session.id, {
      role: "tool",
      callId: "c" + n,
      name: "read",
      text: ("evidence " + n + "\n").repeat(size),
    });
    store.append(session.id, {
      role: "assistant",
      text: "observed result " + n,
    });
  }
  store.append(session.id, { role: "user", text: "continue unfinished work" });
  return { store, session, ctx };
}
const summary =
  "Finished inspection: required files were read, relevant evidence and decisions recorded. No changes or external submissions are inferred.";
test("ACP uses stable atomic refs, protects two units and never splits multi-tool calls/results", () => {
  const { store, session, ctx } = fixture(5, 100);
  try {
    const all = store.messages(session.id);
    const atomic = units(all);
    assert.equal(atomic[1].start, 2);
    assert.equal(atomic[1].ref, 3);
    assert.equal(atomic[1].end, 4);
    assert.equal(protectedStart(all), 14);
    assert.match(ctx.view()[2].text!, /^\[m00003\]/);
    assert.throws(() =>
      ctx.compress([{ startRef: "m00002", endRef: "m00002", summary }]),
    );
    assert.throws(() =>
      ctx.compress([{ startRef: "m00015", endRef: "m00015", summary }]),
    );
    const blocks = ctx.compress([
      { startRef: "m00003", endRef: "m00006", summary },
    ]);
    assert.equal(blocks[0].start, 2);
    assert.equal(blocks[0].end, 7);
    assert.deepEqual(store.messages(session.id), all);
  } finally {
    store.close();
  }
});
test("ACP partial range success, 70% benefit guard and minimum summary are enforced", () => {
  const { store, ctx } = fixture(7, 100);
  try {
    const blocks = ctx.compress([
      { startRef: "m00003", endRef: "m00006", summary },
      { startRef: "m00009", endRef: "m00012", summary: "too short" },
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks.rejected?.length, 1);
    assert.throws(
      () =>
        ctx.compress([
          {
            startRef: "m00009",
            endRef: "m00012",
            summary: "verbose ".repeat(10000),
          },
        ]),
      /70%/,
    );
    assert.equal(ctx.live().length, 1);
    assert.match(
      ctx.view().find((m) => m.text?.includes("<acp-block"))!.text!,
      /b1/,
    );
  } finally {
    store.close();
  }
});
test("T1/T2/T3 nested blocks restore exact earlier blocks and canonical history", () => {
  const { store, ctx, session } = fixture(10, 200);
  try {
    const originals = store.messages(session.id),
      a = ctx.compress([{ startRef: "m00003", endRef: "m00006", summary }])[0],
      b = ctx.compress([{ startRef: "m00009", endRef: "m00012", summary }])[0];
    assert.equal(ctx.groups(1)[0].count, 2);
    const t2 = ctx.compress([{ startRef: a.id, endRef: b.id, summary }])[0];
    assert.equal(t2.tier, 2);
    const t3 = ctx.compress([
      { startRef: t2.id, endRef: "m00018", summary },
    ])[0];
    assert.equal(t3.tier, 3);
    ctx.decompress(t3.id);
    assert(ctx.live().some((f) => f.id === t2.id));
    ctx.decompress(t2.id);
    assert.deepEqual(
      ctx.live().map((f) => f.id),
      [a.id, b.id],
    );
    ctx.decompress(a.id);
    ctx.decompress(b.id);
    assert.deepEqual(store.messages(session.id), originals);
    assert.equal(ctx.view().length, originals.length);
  } finally {
    store.close();
  }
});
test("growth nudge respects45%/75% pressure bands, persists stamps and resets after compression", () => {
  const { store, ctx } = fixture(8, 4500);
  try {
    ctx.configure(200000, 32000, 100, "p/m");
    let status = ctx.status();
    assert(
      status.used > 90000 && status.used < 150000,
      JSON.stringify(status.used),
    );
    const notice = ctx.nudge();
    assert(notice?.includes("<context-budget>"));
    assert(notice?.includes("m00001"));
    assert.equal(
      new Context(store, ctx.session).state().nudgeShown,
      ctx.state().nudgeShown,
    );
    assert.equal(ctx.nudge(), undefined);
    ctx.compress([{ startRef: "m00003", endRef: "m00015", summary }]);
    assert.equal(ctx.state().nudgeShown, 0);
    assert.equal(ctx.state().baseline, 0);
    assert(ACP_GUIDE.includes("T3"));
  } finally {
    store.close();
  }
});
test("ACP emergency shortens old tool outputs then degrades mechanically, never mutates originals", () => {
  const { store, ctx, session } = fixture(8, 3000);
  try {
    const original = store.messages(session.id);
    ctx.configure(70000, 10000, 100, "p/m");
    assert(ctx.shouldEmergency());
    const receipt = ctx.emergency();
    assert.equal(receipt.status, "applied");
    assert(receipt.truncated > 0);
    assert(receipt.savedTokens > 0);
    assert.deepEqual(store.messages(session.id), original);
    const trunc = ctx.state().truncated[0];
    ctx.configure(200000, 32000, 100, "p/m");
    assert.equal(
      ctx.recall({ positions: [trunc] }).messages.find((m) => m.seq === trunc)
        ?.text === original.find((m) => m.seq === trunc)?.text,
      true,
    );
    const nonTools = store.newSession(),
      other = new Context(store, nonTools.id);
    for (let i = 0; i < 10; i++) {
      store.append(nonTools.id, { role: "user", text: "requirement " + i });
      store.append(nonTools.id, {
        role: "assistant",
        text: "finished facts ".repeat(2000),
      });
    }
    other.configure(15000, 2000, 10, "p/m");
    const r = other.emergency(true);
    assert.equal(r.mechanical, true);
    assert.match(other.view()[0].text!, /degraded="mechanical"/);
    const before = other.folds()[0];
    other.decompress(before.id);
    assert.equal(store.messages(nonTools.id).length, 20);
  } finally {
    store.close();
  }
});
test("provider usage anchors token estimates, scene changes reset calibration, ledger survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-acp-")),
    path = join(dir, "state.db");
  let store = new Store(path);
  try {
    const session = store.newSession(),
      ctx = new Context(store, session.id);
    store.append(session.id, { role: "user", text: "request" });
    ctx.configure(200000, 32000, 200, "p/m");
    const sent = ctx.promptView(),
      local = estimate(sent) + 200;
    ctx.recordUsage(sent, {
      input: local,
      cacheRead: local / 2,
      cacheWrite: local / 2,
    });
    assert.equal(ctx.promptTokens(sent), local * 2);
    store.append(session.id, { role: "assistant", text: "new output" });
    assert(ctx.promptTokens() > local * 2);
    const before = ctx.state().lastUsage;
    ctx.recordUsage(sent, {});
    assert.deepEqual(ctx.state().lastUsage, before);
    store.close();
    store = new Store(path);
    const restored = new Context(store, session.id);
    restored.configure(200000, 32000, 200, "p/m");
    assert.equal(restored.state().calibration, 2);
    restored.configure(200000, 32000, 200, "p/new-model");
    assert.equal(restored.state().calibration, 1);
    assert.equal(restored.state().anchor, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("projection repairs missing/orphan pairs, trims old Chrome DOM and strips only completed OpenAI reasoning", () => {
  const rows: Message[] = [
    {
      seq: 1,
      role: "assistant",
      model: "p/m",
      thinking: "old secret reasoning",
      calls: [{ id: "missing", name: "read", arguments: {} }],
    },
    { seq: 2, role: "user", text: "continue" },
    { seq: 3, role: "tool", callId: "orphan", text: "must not be sent" },
    { seq: 4, role: "assistant", thinking: "current thinking" },
  ];
  for (let n = 0; n < 4; n++) {
    rows.push(
      {
        seq: 5 + n * 2,
        role: "assistant",
        calls: [{ id: "c" + n, name: "chrome", arguments: {} }],
      },
      {
        seq: 6 + n * 2,
        role: "tool",
        name: "chrome",
        callId: "c" + n,
        text:
          `[m000${n}] ` +
          JSON.stringify({
            tabTag: "C1",
            pages: [{ text: "dom-" + n }],
            documentPath: "sqlite:observation/x",
            completedActions: 1,
          }),
      },
    );
  }
  const fixed = promptHistory(rows, {
    completedBefore: 2,
    stripReasoning: true,
  });
  assert(fixed.some((m) => m.callId === "missing" && m.error));
  assert(!fixed.some((m) => m.callId === "orphan"));
  assert.equal(fixed[0].thinking, undefined);
  assert(fixed.some((m) => m.thinking === "current thinking"));
  const chrome = fixed.filter((m) => m.name === "chrome");
  assert(!chrome[0].text?.includes("dom-0"));
  assert(chrome[2].text?.includes("dom-2"));
  assert(chrome[0].text?.includes("completedActions"));
  assert(rows[0].thinking === "old secret reasoning");
  assert(rows.at(-7)?.text?.includes("dom-0"));
});
