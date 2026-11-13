import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store, type Message } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Context, estimate } from "../server/core/context";

const config: any = {
  contextMode: "acp",
  scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
  provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: {
    m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } },
  } } },
};
async function fixture(t: TestContext) {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", structuredClone(config));
  const session = await store.newSession({ scene: "lightweight", model: "p/m", ownerId: "owner" });
  t.after(async () => { await engine.close(); await store.close(); });
  return { store, engine, session };
}

test("retained runtime snapshots and notices enter token accounting exactly once", async (t) => {
  const { store, engine, session } = await fixture(t), ctx = await Context.open(store, session.id), fixed = 100;
  await store.append(session.id, { role: "user", text: "one" });
  engine.providers.dynamicPrompt(session.id, await ctx.promptView(), "first snapshot");
  await store.append(session.id, { role: "assistant", text: "done" });
  await store.append(session.id, { role: "user", text: "two" });
  const base = await ctx.promptView(), sent = engine.providers.dynamicPrompt(session.id, base, "second snapshot", "budget notice");
  const runtimeTokens = sent.filter(message => message.runtime === "dynamic").reduce((n, message) => n + estimate(message), 0);
  await ctx.configure(200000, 32000, fixed, "p/m", runtimeTokens - estimate(sent.at(-1)));
  const raw = estimate(sent) + fixed;
  await ctx.recordUsage(sent, { input: raw * 2 }, base);
  assert.equal(ctx.dynamicTokens, runtimeTokens);
  assert.equal(ctx.overhead, fixed + runtimeTokens);
  assert.equal((await ctx.state()).lastUsage!.localEstimate, raw);
  assert.equal(await ctx.promptTokens(base), raw * 2);
  const anchor = (await ctx.state()).anchor;
  await ctx.tool("context_budget", {});
  assert.deepEqual((await ctx.state()).anchor, anchor);
  const restored = await Context.open(store, session.id);
  assert.equal(restored.dynamicTokens, runtimeTokens);
  assert.equal(await restored.promptTokens(base), raw * 2);
});

for (const [api, label] of [["openai-responses", "Responses"], ["openai-completions", "Chat Completions"]] as const)
test(`${label} keeps user-bound dynamic snapshots through tool rounds, notices and the next user turn`, { timeout: 15000 }, async (t) => {
  const { store, engine, session } = await fixture(t), requests: any[] = [], views: Message[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const n = requests.length, events: any[] = [];
    if (api === "openai-completions") {
      const tool = [1, 2, 4].includes(n);
      const delta = tool ? { content: "checking " + n, tool_calls: [{ index: 0, id: "call-" + n, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "package.json", offset: 1, limit: 1 }) } }] } : { content: "done" };
      response.setHeader("Content-Type", "text/event-stream");
      response.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    if (n === 6) { response.writeHead(404); response.end("previous response not found"); return; }
    if ([1, 2, 4].includes(n)) events.push({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call-" + n, name: "read", arguments: JSON.stringify({ path: "package.json", offset: 1, limit: 1 }) } });
    else events.push({ type: "response.output_text.delta", delta: "done" });
    events.push({ type: "response.completed", response: { status: "completed", id: "response-" + n, usage: { input_tokens: 10000, output_tokens: 10 } } });
    response.setHeader("Content-Type", "text/event-stream");
    response.end(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const cfg = structuredClone(config);
  cfg.provider.p.api = api;
  cfg.provider.p.baseURL = "http://127.0.0.1:" + (server.address() as any).port;
  await store.put("config", cfg);
  let runtimeLabel = "runtime-v1";
  const dynamicPrompt = engine.providers.dynamicPrompt.bind(engine.providers);
  engine.providers.dynamicPrompt = (owner, messages, text, notice) => dynamicPrompt(owner, messages, text + "\n" + runtimeLabel, notice);
  const chat = engine.providers.chat.bind(engine.providers);
  engine.providers.chat = async (...args) => {
    views.push(structuredClone(args[2]));
    const reply = await chat(...args);
    if (views.length === 1) runtimeLabel = "runtime-v2";
    return reply;
  };
  const compact = engine.compact.bind(engine);
  engine.compact = async (...args) => {
    const result = await compact(...args);
    if (views.length === 1) args[0].context.nudge = async () => "<context-budget>fixture notice</context-budget>";
    return result;
  };
  await engine.run(session.id, { role: "user", text: "first task" });
  await engine.run(session.id, { role: "user", text: "follow-up" });
  assert.equal(requests.length, 5);
  if (api === "openai-responses") {
    assert.deepEqual(requests.map(request => request.previous_response_id), [undefined, "response-1", "response-2", "response-3", "response-4"]);
    assert.deepEqual(requests[1].input.map((item: any) => item.type || item.role), ["function_call_output", "user"]);
    assert.match(requests[1].input[1].content[0].text, /fixture notice/);
    assert.deepEqual(requests[2].input.map((item: any) => item.type || item.role), ["function_call_output", "user"]);
    assert.deepEqual(requests[3].input.map((item: any) => item.type || item.role), ["user", "user"]);
    assert.deepEqual(requests[4].input.map((item: any) => item.type || item.role), ["function_call_output"]);
  } else {
    assert.deepEqual(requests[0].messages.map((message: any) => message.role), ["system", "user", "user"]);
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1];
      assert.deepEqual(requests[i].messages.slice(0, previous.messages.length), previous.messages, `request ${i + 1} must retain the serialized prefix, including prior tool calls and results`);
      assert.deepEqual(requests[i].tools, requests[0].tools);
      assert.equal(requests[i].prompt_cache_key, requests[0].prompt_cache_key);
    }
    assert.match(requests[0].messages[2].content, /runtime-v1/);
    assert.match(requests[1].messages.at(-1).content, /fixture notice/);
    assert.match(requests[3].messages.at(-1).content, /runtime-v2/);
  }
  const firstDynamic = views[0].find(message => message.runtime === "dynamic")!;
  assert.match(firstDynamic.text!, /runtime-v1/);
  assert.deepEqual(views[1].slice(0, views[0].length), views[0]);
  assert.deepEqual(views[1][1], firstDynamic, "changed runtime context cannot replace a sent snapshot");
  const nextDynamic = views[3].findLast(message => message.runtime === "dynamic")!;
  assert.match(nextDynamic.text!, /runtime-v2/);
  assert(views[3].some(message => message.text?.includes("fixture notice")), "budget notices remain in the request prefix");
  const canonical = await store.messages(session.id);
  assert(!canonical.some(message => message.runtime === "dynamic"));
  assert.deepEqual(canonical.filter(message => message.role === "user").map(message => message.text), ["first task", "follow-up"]);
  assert(canonical.every(message => !message.text?.includes("fixture notice")));
  if (api !== "openai-responses") return;
  await engine.run(session.id, { role: "user", text: "fallback" });
  assert.equal(requests.length, 7, "an unavailable continuation falls back only once");
  assert.equal(requests[5].previous_response_id, "response-5");
  assert.equal(requests[6].previous_response_id, undefined);
  assert.deepEqual(requests[6].input[1], requests[0].input[1], "full fallback retains the original dynamic snapshot");
  assert.equal((await store.messages(session.id)).filter(message => message.role === "tool").length, 3, "full history is replayed to the model, not executed again");
});
