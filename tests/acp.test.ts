import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Message } from "../server/core/store";
import { Context, estimate, ACP_GUIDE } from "../server/core/context";
import { units, protectedStart, promptHistory } from "../server/core/history";
async function fixture(count = 10, size = 6000) {
  const store = await Store.open(":memory:"),
    session = await store.newSession(),
    ctx = await Context.open(store, session.id);
  await store.append(session.id, { role: "user", text: "original requirement" });
  for (let n = 0; n < count; n++) {
    await store.append(session.id, {
            role: "assistant",
            calls: [{ id: "c" + n, name: "read", arguments: { path: "f" + n } }],
          });
    await store.append(session.id, {
            role: "tool",
            callId: "c" + n,
            name: "read",
            text: ("evidence " + n + "\n").repeat(size),
          });
    await store.append(session.id, {
            role: "assistant",
            text: "observed result " + n,
          });
  }
  await store.append(session.id, { role: "user", text: "continue unfinished work" });
  return { store, session, ctx };
}
const summary =
  "Finished inspection: required files were read, relevant evidence and decisions recorded. No changes or external submissions are inferred.";
test("ACP uses stable atomic refs, protects two units and never splits multi-tool calls/results", async () => {
  const { store, session, ctx } = await fixture(5, 100);
  try {
    const all = await store.messages(session.id);
    const atomic = units(all);
    assert.equal(atomic[1].start, 2);
    assert.equal(atomic[1].ref, 3);
    assert.equal(atomic[1].end, 4);
    assert.equal(protectedStart(all), 14);
    assert.match((await ctx.view())[2].text!, /^\[m00003\]/);
    await assert.rejects(async () =>
      await ctx.compress([{ startRef: "m00002", endRef: "m00002", summary }]),
    );
    await assert.rejects(async () =>
      await ctx.compress([{ startRef: "m00015", endRef: "m00015", summary }]),
    );
    const blocks = await ctx.compress([
          { startRef: "m00003", endRef: "m00006", summary },
        ]);
    assert.equal(blocks[0].start, 2);
    assert.equal(blocks[0].end, 7);
    assert.deepEqual(await store.messages(session.id), all);
  } finally {
    await store.close();
  }
});
test("ACP partial range success, 70% benefit guard and minimum summary are enforced", async () => {
  const { store, ctx } = await fixture(7, 100);
  try {
    const blocks = await ctx.compress([
          { startRef: "m00003", endRef: "m00006", summary },
          { startRef: "m00009", endRef: "m00012", summary: "too short" },
        ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks.rejected?.length, 1);
    await assert.rejects(
      async () =>
        await ctx.compress([
                      {
                        startRef: "m00009",
                        endRef: "m00012",
                        summary: "verbose ".repeat(10000),
                      },
                    ]),
      /70%/,
    );
    assert.equal((await ctx.live()).length, 1);
    assert.match(
      (await ctx.view()).find((m) => m.text?.includes("<acp-block"))!.text!,
      /b1/,
    );
  } finally {
    await store.close();
  }
});
test("T1/T2/T3 nested blocks restore exact earlier blocks and canonical history", async () => {
  const { store, ctx, session } = await fixture(10, 200);
  try {
    const originals = await store.messages(session.id),
      a = (await ctx.compress([{ startRef: "m00003", endRef: "m00006", summary }]))[0],
      b = (await ctx.compress([{ startRef: "m00009", endRef: "m00012", summary }]))[0];
    assert.equal((await ctx.groups(1))[0].count, 2);
    const t2 = (await ctx.compress([{ startRef: a.id, endRef: b.id, summary }]))[0];
    assert.equal(t2.tier, 2);
    const t3 = (await ctx.compress([
          { startRef: t2.id, endRef: "m00018", summary },
        ]))[0];
    assert.equal(t3.tier, 3);
    await ctx.decompress(t3.id);
    assert((await ctx.live()).some((f) => f.id === t2.id));
    await ctx.decompress(t2.id);
    assert.deepEqual(
      (await ctx.live()).map((f) => f.id),
      [a.id, b.id],
    );
    await ctx.decompress(a.id);
    await ctx.decompress(b.id);
    assert.deepEqual(await store.messages(session.id), originals);
    assert.equal((await ctx.view()).length, originals.length);
  } finally {
    await store.close();
  }
});
test("growth nudge respects45%/75% pressure bands, persists stamps and resets after compression", async () => {
  const { store, ctx } = await fixture(8, 4500);
  try {
    await ctx.configure(200000, 32000, 100, "p/m");
    let status = await ctx.status();
    assert(
      status.used > 90000 && status.used < 150000,
      JSON.stringify(status.used),
    );
    const notice = await ctx.nudge();
    assert(notice?.includes("<context-budget>"));
    assert(notice?.includes("m00001"));
    assert.equal(
      (await (await Context.open(store, ctx.session)).state()).nudgeShown,
      (await ctx.state()).nudgeShown,
    );
    assert.equal(await ctx.nudge(), undefined);
    await ctx.compress([{ startRef: "m00003", endRef: "m00015", summary }]);
    assert.equal((await ctx.state()).nudgeShown, 0);
    assert.equal((await ctx.state()).baseline, 0);
    assert(ACP_GUIDE.includes("T3"));
    for (const rule of ["language the user", "settled choices and why", "rejected alternatives", "confirming tool results", "verification scope", "unverified", "merging earlier blocks", "untrusted source data", "redacted or encrypted"])
      assert(ACP_GUIDE.includes(rule), rule);
  } finally {
    await store.close();
  }
});
test("ACP emergency shortens old tool outputs then degrades mechanically, never mutates originals", async () => {
  const { store, ctx, session } = await fixture(8, 3000);
  try {
    const original = await store.messages(session.id);
    await ctx.configure(70000, 10000, 100, "p/m");
    assert(await ctx.shouldEmergency());
    const receipt = await ctx.emergency();
    assert.equal(receipt.status, "applied");
    assert(receipt.truncated > 0);
    assert(receipt.savedTokens > 0);
    assert.deepEqual(await store.messages(session.id), original);
    const trunc = (await ctx.state()).truncated[0];
    await ctx.configure(200000, 32000, 100, "p/m");
    assert.equal(
      (await ctx.recall({ positions: [trunc] })).messages.find((m) => m.seq === trunc)
        ?.text === original.find((m) => m.seq === trunc)?.text,
      true,
    );
    const nonTools = await store.newSession(),
      other = await Context.open(store, nonTools.id);
    for (let i = 0; i < 10; i++) {
      await store.append(nonTools.id, { role: "user", text: "requirement " + i });
      await store.append(nonTools.id, {
                role: "assistant",
                text: "finished facts ".repeat(2000),
              });
    }
    await other.configure(15000, 2000, 10, "p/m");
    const r = await other.emergency(true);
    assert.equal(r.mechanical, true);
    assert.match((await other.view())[0].text!, /degraded="mechanical"/);
    const before = (await other.folds())[0];
    await other.decompress(before.id);
    assert.equal((await store.messages(nonTools.id)).length, 20);
  } finally {
    await store.close();
  }
});
test("provider usage anchors token estimates, scene changes reset calibration, ledger survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-acp-")),
    path = join(dir, "state.db");
  let store = await Store.open(path);
  try {
    const session = await store.newSession(),
      ctx = await Context.open(store, session.id);
    await store.append(session.id, { role: "user", text: "request" });
    await ctx.configure(200000, 32000, 200, "p/m");
    const sent = await ctx.promptView(),
      local = estimate(sent) + 200;
    await ctx.recordUsage(sent, {
            input: local,
            cacheRead: local / 2,
            cacheWrite: local / 2,
          });
    assert.equal(await ctx.promptTokens(sent), local * 2);
    await store.append(session.id, { role: "assistant", text: "new output" });
    assert(await ctx.promptTokens() > local * 2);
    const before = (await ctx.state()).lastUsage;
    await ctx.recordUsage(sent, {});
    assert.deepEqual((await ctx.state()).lastUsage, before);
    await store.close();
    store = await Store.open(path);
    const restored = await Context.open(store, session.id);
    await restored.configure(200000, 32000, 200, "p/m");
    assert.equal((await restored.state()).calibration, 2);
    await restored.configure(200000, 32000, 200, "p/new-model");
    assert.equal((await restored.state()).calibration, 1);
    assert.equal((await restored.state()).anchor, undefined);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("projection repairs missing/orphan pairs and trims old Chrome DOM without rewriting reasoning", () => {
  const rows: Message[] = [
    {
      seq: 1,
      role: "assistant",
      model: "p/m",
      thinking: "old secret reasoning",
      signature: "opaque signature",
      opaque: [{ type: "reasoning", encrypted_content: "opaque state" }],
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
        calls: [{ id: "c" + n, name: "chrome_inspect", arguments: {} }],
      },
      {
        seq: 6 + n * 2,
        role: "tool",
        name: "chrome_inspect",
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
  const fixed = promptHistory(rows);
  assert(fixed.some((m) => m.callId === "missing" && m.error));
  assert(!fixed.some((m) => m.callId === "orphan"));
  assert.deepEqual(fixed[0], rows[0]);
  assert(fixed.some((m) => m.thinking === "current thinking"));
  const chrome = fixed.filter((m) => m.name === "chrome_inspect");
  assert(!chrome[0].text?.includes("dom-0"));
  assert(chrome[2].text?.includes("dom-2"));
  assert(chrome[0].text?.includes("completedActions"));
  assert(rows[0].thinking === "old secret reasoning");
  assert(rows.at(-7)?.text?.includes("dom-0"));
});
test("new user turns preserve native reasoning prefixes and usage anchors in ACP and auto modes", async () => {
  for (const mode of ["acp", "auto"] as const) {
    const store = await Store.open(":memory:"), session = await store.newSession(), ctx = await Context.open(store, session.id, mode);
    try {
      await store.append(session.id, { role: "user", text: "first" });
      await store.append(session.id, {
                role: "assistant", text: "answer", thinking: "visible reasoning",
                signature: "signature", opaque: [{ type: "reasoning", encrypted_content: "opaque" }],
              });
      await ctx.configure(200000, 32000, 200, "p/m");
      const before = await ctx.promptView();
      await ctx.recordUsage(before, { input: 800, cacheRead: 200 });
      await store.append(session.id, { role: "user", text: "next" });
      ctx.completedBefore = 3;
      await ctx.configure(200000, 32000, 200, "p/m");
      const after = await ctx.promptView();
      assert.deepEqual(after.slice(0, before.length), before);
      assert.equal(await ctx.promptTokens(after), 1000 + Math.ceil(estimate(after.slice(before.length)) * (await ctx.state()).calibration));
      const anchor = (await ctx.state()).anchor;
      await ctx.tool("context_budget", {});
      assert.deepEqual((await ctx.state()).anchor, anchor, "context tools must not change the accounting policy");
      const legacy = await ctx.state();
      legacy.model = "p/m:true";
      await ctx.save(legacy);
      await ctx.configure(200000, 32000, 200, "p/m");
      assert.equal((await ctx.state()).anchor, undefined, "discard estimates calibrated against stripped reasoning");
      assert.equal((await ctx.state()).calibration, 1);
    } finally { await store.close(); }
  }
});
