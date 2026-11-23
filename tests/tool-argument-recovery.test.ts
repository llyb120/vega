import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers, type Tool } from "../server/core/provider";
import { nativeArguments } from "../server/core/util";
import { resolveModel } from "../server/core/config";
import { envelope, fieldBytes, fieldNumber } from "../server/core/devin";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

const raw = '{"tab":"C1","screenshot": false';
const tool: Tool = { name: "browser_view", description: "view", parameters: { type: "object", properties: { tab: { type: "string" }, screenshot: { type: "boolean" } }, required: [] } };
type Packet = { body: string | Buffer; type: string };
const sse = (frames: any[]): Packet => ({ type: "text/event-stream", body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n" });
const json = (body: any): Packet => ({ type: "application/json", body: JSON.stringify(body) });
const call = (id: string, name: string, args: any) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const completion = (calls: any[] = [], text = ""): Packet => sse([{ choices: [{ delta: { content: text, ...(calls.length ? { tool_calls: calls.map((value, index) => ({ index, ...value })) } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }] }]);
const config = (url: string, api = "openai-completions") => ({
  model: "p/m",
  scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
  provider: { p: { api, baseURL: url, models: { m: { limit: { context: 200000, output: 4096 }, modalities: { input: ["text", "image"] } } } } },
});

async function http(t: TestContext, packets: Packet[]) {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    requests.push(request.headers["content-type"]?.includes("application/json") ? JSON.parse(body.toString("utf8")) : body);
    const packet = packets[requests.length - 1];
    if (!packet) { response.writeHead(400); response.end("Fixture exhausted"); return; }
    response.setHeader("Content-Type", packet.type);
    response.end(packet.body);
  });
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(yes => server.close(() => yes()));
  });
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests };
}

async function fixture(t: TestContext, packets: Packet[]) {
  const { url, requests } = await http(t, packets);
  const store = await Store.open(":memory:"), cwd = await mkdtemp(join(tmpdir(), "vega-tool-json-"));
  const chrome = new Chrome(store, new ChromeBridge(), "");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), chrome);
  engine.employee.closed = true;
  t.after(async () => { await engine.close(); await store.close(); await rm(cwd, { recursive: true, force: true }); });
  await store.put("config", config(url));
  return { engine, store, cwd, chrome, requests };
}

async function taskFixture(t: TestContext, packets: Packet[]) {
  const fixture_ = await fixture(t, packets), { engine, store, cwd } = fixture_;
  const employee = await engine.employee.for((await engine.employee.create({ name: "参数纠错", cwd }, "owner")).id);
  const session = await store.newSession({ cwd, employeeId: employee.employeeId, taskId: "t-json", ownerId: "owner", scene: "computer" });
  await employee.update(state => {
    state.tasks.push({ id: "t-json", text: "执行验证：只运行一次命令并核对页面", status: "running", profile: "lightweight", cwd, createdAt: Date.now(), owner: { token: "", name: "owner" }, workSession: session.id, plan: [{ content: "执行验证：运行一次命令并核对页面", status: "in_progress" }] });
  });
  const task = await employee.findTask("t-json");
  assert(task);
  employee.busy.set(task.id, { computer: false, session: session.id });
  const recover = t.mock.method(employee, "recover");
  return { ...fixture_, employee, task, session, recover };
}

test("invalid model JSON is preserved verbatim only when a conversation can return an error receipt", () => {
  for (const value of [raw, "{", "[]", "null", "42", JSON.stringify("not JSON"), '{"value":undefined}']) {
    assert.throws(() => nativeArguments(value));
    assert.deepEqual(nativeArguments(value, true), { __invalidJson: value });
  }
  const wrapped = JSON.stringify(JSON.stringify({ visual: "none" }));
  assert.deepEqual(nativeArguments(wrapped, true), { visual: "none" });
});

test("streaming, JSON and native providers defer bad arguments for sessions but keep one-shot calls strict", async t => {
  const c = call("bad", "browser_view", raw);
  const cases: [string, Packet, string][] = [
    ["openai-completions", completion([c]), raw],
    ["openai-completions", json({ choices: [{ message: { tool_calls: [c] }, finish_reason: "tool_calls" }] }), raw],
    ["openai-completions", json({ choices: [{ message: { tool_calls: [call("bad", "browser_view", "42")] }, finish_reason: "tool_calls" }] }), "42"],
    ["openai-responses", sse([{ type: "response.completed", response: { id: "r-bad", status: "completed", output: [{ type: "function_call", id: "item-bad", call_id: "bad", name: "browser_view", arguments: raw }] } }]), raw],
    ["openai-responses", json({ status: "completed", output: [{ type: "function_call", call_id: "bad", name: "browser_view", arguments: raw }] }), raw],
    ["anthropic-messages", sse([{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad", name: "browser_view", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }]), raw],
    ["anthropic-messages", json({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "bad", name: "browser_view", input: null }] }), "null"],
    ["devin", { type: "application/connect+proto", body: Buffer.concat([envelope(Buffer.concat([fieldNumber(5, 10), fieldBytes(6, Buffer.concat([fieldBytes(1, "bad"), fieldBytes(2, "browser_view"), fieldBytes(3, raw)]))])), envelope(Buffer.from("{}"), 2)]) }, raw],
  ];
  for (const [api, packet, expected] of cases) {
    const { url } = await http(t, [packet, packet]);
    const model = resolveModel(config(url, api), "p/m"), signal = new AbortController().signal;
    model.apiKey = "fixture";
    await assert.rejects(new Providers().chat(model, "sys", [], [tool], signal), Error, `${api} ${packet.type} stays strict outside sessions`);
    const reply = await new Providers().chat(model, "sys", [], [tool], signal, undefined, "", undefined, true);
    assert.equal(reply.calls?.length, 1, api);
    assert.equal(reply.calls![0].name, tool.name);
    assert.match(reply.calls![0].id, /^bad(?:\||$)/);
    assert.deepEqual(reply.calls![0].arguments, { __invalidJson: expected }, `${api} ${packet.type}`);
  }
});

test("sessions still reject unfinished streams before dispatching any tool", async t => {
  const incomplete: [string, Packet][] = [
    ["openai-completions", { type: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call("bad", tool.name, raw) }] } }] })}\n\n` }],
    ["openai-responses", sse([{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item-bad", call_id: "bad", name: tool.name, arguments: raw } }])],
    ["anthropic-messages", sse([{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad", name: tool.name, input: {} } }])],
    ["devin", { type: "application/connect+proto", body: Buffer.concat([envelope(Buffer.concat([fieldNumber(5, 3), fieldBytes(6, Buffer.concat([fieldBytes(1, "bad"), fieldBytes(2, tool.name), fieldBytes(3, raw)]))])), envelope(Buffer.from("{}"), 2)]) }],
  ];
  for (const [api, packet] of incomplete) {
    const { url } = await http(t, [packet]);
    const model = resolveModel(config(url, api), "p/m");
    model.apiKey = "fixture";
    await assert.rejects(new Providers().chat(model, "sys", [], [tool], new AbortController().signal, undefined, "", undefined, true), Error, api);
  }
});

const first = (cwd: string) => completion([call("once", "bash", { command: `cd '${cwd}'; node -e "require('node:fs').appendFileSync('once.txt','x')"`, timeout: 5 }), call("bad", "browser_view", raw)]);
const inspect = call("fixed", "browser_view", { tab: "C1", screenshot: false });

for (const taskMode of [false, true]) test(`bad arguments are corrected in the same ${taskMode ? "employee run" : "conversation"} without replaying successful work`, { timeout: 30000 }, async t => {
  const packets = [completion([]), completion([inspect])];
  if (taskMode) packets.push(
    completion([call("progress", "task_progress", { message: "命令和页面已验证", plan: [{ content: "执行验证：运行一次命令并核对页面", status: "completed" }] })]),
    completion([call("complete", "task_complete", { evidence: "命令成功，页面夹具确认正确", summary: "已完成验证", deliverableRefs: [] })]),
  );
  else packets.push(completion([], "已完成验证"));
  const job = taskMode ? await taskFixture(t, packets) : undefined;
  const { engine, store, cwd, chrome, requests } = job || await fixture(t, packets);
  packets[0] = first(cwd);
  const browser = t.mock.method(engine, "chromeFor", async () => chrome);
  t.mock.method(engine.handoffs, "ensureBrowserState", async () => {});
  const execute = t.mock.method(chrome, "execute", async () => ({ tabTag: "C1", pages: [{ title: "fixture" }] }));
  let sessionId: string;
  if (job) { sessionId = job.session.id; await job.employee.run(job.task); }
  else {
    const session = await store.newSession({ cwd, scene: "computer" });
    sessionId = session.id;
    await engine.run(sessionId, { role: "user", text: "执行验证：只运行一次命令并核对页面" });
  }
  assert.equal(requests.length, packets.length, "no task restart or extra provider request");
  assert.equal(await readFile(join(cwd, "once.txt"), "utf8"), "x", "the successful command is never replayed");
  assert.equal(browser.mock.callCount(), 1, "bad arguments never reach browser acquisition");
  assert.equal(execute.mock.callCount(), 1, "only the corrected call reaches the browser");
  assert.equal(execute.mock.calls[0].arguments[2]!.screenshot, false);
  const rows = await store.messages(sessionId);
  const bad = rows.find(message => message.role === "tool" && message.callId === "bad")!;
  assert.equal(bad.error, true);
  assert.match(bad.text!, /本次调用未执行/);
  assert.match(bad.text!, /不要重放已成功/);
  assert.deepEqual(rows.find(message => message.calls?.some(c => c.id === "bad"))!.calls!.find(c => c.id === "bad")!.arguments, { __invalidJson: raw });
  assert(requests[1].messages.some((message: any) => message.role === "tool" && message.tool_call_id === "bad" && message.content.includes("本次调用未执行")), "the next model request sees the tool error");
  assert.equal(rows.filter(message => message.role === "user").length, 1);
  assert(!rows.some(message => message.runtime === "turn_aborted"));
  if (job) {
    const state = await job.employee.state(), task = await job.employee.findTask(job.task.id);
    assert(task);
    assert.equal(task.status, "done");
    assert.equal(state.runs.length, 1);
    assert.equal(task.recovery, undefined);
    assert.equal(job.recover.mock.callCount(), 0, "generic task self-healing is not involved");
  }
});

test("malformed scene and completion calls cannot switch scenes or return to a caller", { timeout: 30000 }, async t => {
  const packets = [completion([call("scene-bad", "switch_scene", '{"scene": coding}')]), completion([call("complete-bad", "task_complete", '{"evidence": none}')]), completion([call("wait", "task_ask_user", { question: "等待夹具补充" })])];
  const { engine, store, employee, task, session, recover, requests } = await taskFixture(t, packets);
  session.sceneStack = [{ scene: "coding", model: "p/m", resume: "继续原调用方的任务" }];
  await store.saveSession(session);
  const events: any[] = [];
  engine.events.on("event", event => events.push(event));
  await employee.run(task);
  assert.equal(requests.length, packets.length);
  for (const id of ["scene-bad", "complete-bad"]) {
    const receipt = (await store.messages(session.id)).find(message => message.callId === id)!;
    assert.equal(receipt.error, true);
    assert.match(receipt.text!, /本次调用未执行/);
  }
  const saved = await store.session(session.id);
  assert.equal(saved.scene, "computer");
  assert.deepEqual(saved.sceneStack, session.sceneStack);
  assert(!events.some(event => event.type === "scene"));
  assert.equal((await employee.findTask(task.id))?.status, "waiting");
  assert.equal(recover.mock.callCount(), 0);
});
