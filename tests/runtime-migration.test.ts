import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store, type Message } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Context, estimate } from "../server/core/context";
import { attachDynamic } from "../server/core/prompt";
import { ProviderError, bodyFor } from "../server/core/provider";
import { resolveModel } from "../server/core/config";
import { beginAgent, reserveAgent, resetAgents, takeReadyAgents, finishAgent, type AgentChild } from "../server/core/spawn-agent";

afterEach(resetAgents);
const config: any = {
  contextMode: "acp",
  scenes: { lightweight: ["p/m"], coding: [{ model: "p/m", allowSpawn: true }], computer: ["p/m"] },
  provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: {
    m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } },
  } } },
};
async function fixture(t: any) {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", structuredClone(config));
  const session = await store.newSession({ scene: "lightweight", model: "p/m", ownerId: "owner" });
  t.after(async () => { await engine.close(); await store.close(); });
  return { store, engine, session };
}

for (const cleanup of [false, true]) test(`parent ${cleanup ? "cleanup" : "provider"} failure cancels children and discards their late results`, async (t) => {
  const { engine, session } = await fixture(t);
  const child: AgentChild = { name: "probe", path: "/root/probe", sessionId: "child", status: "running", running: true, cancelled: false, abort: new AbortController() };
  beginAgent(session.id, child);
  engine.providers.chat = async () => {
    if (!cleanup) throw new ProviderError("fixture failure", 400);
    return { role: "assistant", text: "done" };
  };
  const release = engine.localBrowsers.release;
  if (cleanup) {
    // Avoid waiting for the deliberately unfinished child at the ordinary no-tool exit.
    engine.settleBackground = async () => false;
    engine.localBrowsers.release = async () => { engine.localBrowsers.release = release; throw Error("fixture cleanup failure"); };
  }
  await assert.rejects(engine.run(session.id, { role: "user", text: "inspect" }), /fixture/);
  assert.equal(child.abort!.signal.aborted, true);
  assert.equal(child.cancelled, true);
  assert.throws(() => reserveAgent(session.id, "new", "must not start"), /调度已停止/);
  finishAgent(session.id, child.path, "completed", "late");
  assert.deepEqual(takeReadyAgents(session.id), []);
});

test("restart closes pending calls once and gives the model a turn marker, without changing user messages", async (t) => {
  const { store, engine, session } = await fixture(t);
  await store.append(session.id, { role: "user", text: "原任务" });
  await store.append(session.id, { role: "assistant", calls: [{ id: "uncertain", name: "write", arguments: {} }] });
  await engine.recoverPending(session.id);
  await engine.recoverPending(session.id, "restart");
  const recovered = await store.messages(session.id);
  assert.equal(recovered.filter(m => m.runtime === "turn_aborted").length, 1);
  assert.equal(recovered.find(m => m.role === "tool")!.error, true);
  assert.equal(recovered.find(m => m.runtime === "turn_aborted")!.role, "system");
  assert.doesNotMatch(recovered.at(-1)!.text!, /用户主动中断/);
  engine.providers.chat = async (_model, _system, messages) => {
    assert.equal(messages.filter(m => m.runtime === "turn_aborted").length, 1);
    assert.equal(messages.find(m => m.runtime === "turn_aborted")!.role, "user");
    assert(messages.some(m => m.text?.includes("原任务")));
    return { role: "assistant", text: "continued" };
  };
  await engine.run(session.id, { role: "user", text: "继续" });
  assert.equal((await store.session(session.id)).turnInProgress, false);
});

test("a restart during generation is detected even without a tool call", async (t) => {
  const { store, engine, session } = await fixture(t);
  session.turnInProgress = true;
  await store.saveSession(session);
  await store.append(session.id, { role: "user", text: "original request" });
  engine.providers.chat = async (_model, _system, messages) => {
    assert.match(messages.find(m => m.runtime === "turn_aborted")!.text!, /进程或服务中断/);
    return { role: "assistant", text: "ok" };
  };
  await engine.run(session.id, { role: "user", text: "continue" });
});

test("cancellation marks the interrupted turn without turning it into completion", async (t) => {
  const { store, engine, session } = await fixture(t);
  engine.providers.chat = async (_model, _system, _messages, _tools, signal) => {
    engine.cancel(session.id);
    signal.throwIfAborted();
    throw Error("unreachable");
  };
  await assert.rejects(engine.run(session.id, { role: "user", text: "work" }), /Cancelled/);
  const rows = await store.messages(session.id);
  assert.equal(rows.filter(m => m.runtime === "turn_aborted").length, 1);
  assert.match(rows.at(-1)!.text!, /请求停止/);
  assert.equal((await store.session(session.id)).turnInProgress, false);
});

test("fork, history clear and /new do not inherit a pending turn from the old context", async (t) => {
  const { store, engine, session } = await fixture(t);
  session.turnInProgress = true;
  await store.saveSession(session);
  await store.append(session.id, { role: "user", text: "old goal" });
  await store.append(session.id, { role: "assistant", calls: [{ id: "old", name: "read", arguments: {} }] });
  const fork = await store.fork(session.id);
  assert.equal(fork.turnInProgress, false);
  assert.equal((await store.session(session.id)).turnInProgress, true);
  await engine.newChatContext(session.id);
  await engine.recoverPending(session.id);
  assert.equal((await store.session(session.id)).turnInProgress, false);
  assert.equal((await store.messages(session.id)).filter(m => m.runtime === "turn_aborted").length, 0);
  await store.clearSessionHistory(fork.id);
  assert.equal((await store.session(fork.id)).turnInProgress, false);
});

test("setup failure does not relabel the previous completed conversation as interrupted", async (t) => {
  const { store, engine, session } = await fixture(t);
  await store.append(session.id, { role: "user", text: "previous goal" });
  await store.append(session.id, { role: "assistant", text: "previous completed result" });
  engine.catalog.resolve = async () => { throw new ProviderError("fixture setup failure", 400); };
  await assert.rejects(engine.run(session.id, { role: "user", text: "not started" }), /fixture setup failure/);
  assert.equal((await store.messages(session.id)).filter(m => m.runtime === "turn_aborted").length, 0);
});

test("steer is framed only in the model projection, retaining raw text, attribution, and the original goal", async (t) => {
  const { store, engine, session } = await fixture(t);
  let phase = 0;
  engine.providers.chat = async (_model, _system, messages) => {
    assert.equal(messages.at(-1)!.runtime, "dynamic");
    if (++phase === 1) engine.steer(session.id, { role: "user", text: "改成只读，不要写入", actorId: "owner", clientMessageId: "supplement-id" });
    else {
      assert(messages.some(m => m.text?.includes("原目标")));
      const steer = messages.find(m => m.runtime === "steer")!;
      assert.match(steer.text!, /主任务尚未结束[\s\S]*明确的停止[\s\S]*改成只读/);
    }
    return { role: "assistant", text: "ok" };
  };
  await engine.run(session.id, { role: "user", text: "原目标" });
  const steer = (await store.messages(session.id)).find(m => m.runtime === "steer")!;
  assert.equal(steer.text, "改成只读，不要写入");
  assert.equal(steer.actorId, "owner");
  assert.equal(steer.clientMessageId, "supplement-id");
});

test("runtime tails are counted once, usage anchors survive expanded inputs, tools, turns and dynamic changes", async (t) => {
  const { store, session } = await fixture(t);
  const ctx = await Context.open(store, session.id);
  await store.append(session.id, { role: "user", text: "one" });
  const base = await ctx.promptView(), fixed = 100;
  const tail = attachDynamic([], "runtime-a")[0];
  await ctx.configure(200000, 32000, fixed, "p/m", estimate(tail));
  const sent = attachDynamic([{ ...base[0], text: base[0].text + " expanded skill" }], tail.text!);
  const raw = estimate(sent) + fixed;
  await ctx.recordUsage(sent, { input: raw * 2 }, base);
  assert.equal((await ctx.state()).lastUsage!.localEstimate, raw);
  assert.equal((await ctx.state()).calibration, 2);
  assert.equal(await ctx.promptTokens(base), raw * 2);
  await store.append(session.id, { role: "assistant", calls: [{ id: "c", name: "read", arguments: {} }] });
  await store.append(session.id, { role: "tool", callId: "c", text: "done" });
  await store.append(session.id, { role: "user", text: "next" });
  const after = await ctx.promptView(), nextTail = attachDynamic([], "runtime-b-longer")[0];
  await ctx.configure(200000, 32000, fixed, "p/m", estimate(nextTail));
  const expected = raw * 2 + (estimate(nextTail) - estimate(tail)) * 2 + Math.ceil(estimate(after.slice(base.length)) * 2);
  assert.equal(await ctx.promptTokens(after), expected);
  const anchor = (await ctx.state()).anchor;
  await ctx.tool("context_budget", {});
  assert.deepEqual((await ctx.state()).anchor, anchor);
  assert.equal(await ctx.promptTokens(after), expected);
  const restored = await Context.open(store, session.id);
  assert.equal(await restored.promptTokens(after), expected);
  await restored.recordUsage([], {});
  assert.deepEqual((await restored.state()).anchor, anchor);
  await restored.configure(200000, 32000, fixed, "p/new", estimate(nextTail));
  assert.equal((await restored.state()).anchor, undefined);
});

test("Anthropic preserves user boundaries without breaking contiguous tool results", async () => {
  const model = resolveModel({ ...config, provider: { p: { ...config.provider.p, api: "anthropic-messages" } } }, "p/m");
  const messages: Message[] = [
    { role: "user", text: "original" }, { role: "user", text: "stop" },
    { role: "assistant", calls: [{ id: "a", name: "read", arguments: {} }, { id: "b", name: "read", arguments: {} }] },
    { role: "tool", callId: "a", text: "A" }, { role: "tool", callId: "b", text: "B" },
  ];
  const before = structuredClone(messages), { body } = await bodyFor(model, "sys", messages, []);
  assert.deepEqual(body.messages[0].content.map((p: any) => p.text), ["original", "\n\n[以下是另一条消息]\n\n", "stop"]);
  assert.deepEqual(body.messages[2].content.map((p: any) => p.type), ["tool_result", "tool_result"]);
  assert.deepEqual(messages, before);
});
