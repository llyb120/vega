import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { LocalAgents, LocalAgentUnavailable } from "../server/core/local-agent";
import { Tools } from "../server/core/tools";
import { resolveModel } from "../server/core/config";
import { chromeCall } from "./public-call";

const client = { instance: "a".repeat(32), clientId: "d".repeat(32), name: "Local PC", cwd: "C:\\only-on-client", platform: "windows" };
async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  t.after(async () => { await engine.close(); await store.close(); });
  engine.localAgents.connect("alice", client);
  const session = await store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
  const calls: any[] = [];
  let holder = "";
  engine.localAgents.request = async (agent, op, args) => {
    assert.equal(agent.clientId, client.clientId);
    assert.equal(op, "browser");
    calls.push(args);
    if (args.operation === "release") { if (holder === args.session) holder = ""; return { result: { ok: true } }; }
    if (holder && holder !== args.session) return { status: "busy", error: "本地浏览器由其他会话独占，本步未执行" };
    if (args.operation === "acquire") holder = args.session;
    return { result: args.operation === "tabs" ? { tabs: [{ tag: "local-a" }, { tag: "local-b" }] } : args.operation === "workspace_file" ? { path: "C:\\only-on-client\\upload.txt" } : { connected: true, browser: "Google Chrome", browsers: ["Google Chrome"] } };
  };
  engine.chrome.execute = async () => { throw Error("Must not use the server browser"); };
  engine.browsers.get = async () => { throw Error("Must not start an employee server browser"); };
  return { store, engine, session, calls };
}

test("local sessions never create a SOCKS proxy or send NetworkRelay jobs", async (t) => {
  const { engine, session, calls } = await fixture(t);
  const relayJobs: any[] = [];
  const proxyCalls: string[] = [];
  engine.relay.proxy = async (userId: string) => {
    proxyCalls.push(userId);
    throw Error("local sessions must not open SOCKS");
  };
  const agent = engine.localAgents.active("alice", client.clientId)!;
  agent.transport = {
    send(value: any) { if (value?.type === "relay") relayJobs.push(value); },
    close() {},
  } as any;
  await engine.chromeFor(session);
  const tools = await Tools.create(engine, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  await tools.execute({ id: "tabs", ...chromeCall({ operation: "tabs" }) }, {} as any);
  assert.equal(proxyCalls.length, 0, "local Chrome must not open the owner's SOCKS listener");
  assert.deepEqual(relayJobs, [], "local Chrome must not enqueue NetworkRelay tunnel jobs");
  assert(calls.some((c) => c.operation === "acquire"), "ops go through the local-agent browser bridge");
  assert(!calls.some((c) => c.operation === "relay"));
});

test("local Chrome tools and employee tasks use only their selected native browser and local uploads", async (t) => {
  const { engine, store, session, calls } = await fixture(t);
  const tools = await Tools.create(engine, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  const result = await tools.execute({ id: "tabs", ...chromeCall({ operation: "tabs" }) }, {} as any);
  assert.equal(result.value.tabs[0].tag, "local-a");
  const chrome = await engine.chromeFor({ ...session, employeeId: "employee", taskId: "task" });
  assert.equal(chrome, await engine.chromeFor(await store.session(session.id)));
  assert.equal(await chrome.workspaceFile(session.cwd, "upload.txt"), "C:\\only-on-client\\upload.txt");
  const upload = calls.find((c) => c.operation === "workspace_file");
  assert.deepEqual(upload.args, { cwd: client.cwd, path: "upload.txt" });
  assert.equal(new Set(calls.map((c) => c.session)).size, 1, "same session keeps a lease across tool calls");
  const agent = engine.localAgents.active("alice", client.clientId)!;
  assert.deepEqual([...agent.browserLeases], [calls[0].session]);
  await engine.localBrowsers.release(session.id);
  assert.equal(calls.at(-1).operation, "release");
  assert.equal(agent.browserLeases.size, 0);
});

test("local navigation invalidates other sessions on the same client without sharing their input context", async (t) => {
  const { engine, store, session } = await fixture(t);
  const second = await store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
  const firstBrowser = await engine.chromeFor(session);
  const observation = { id: "old", tabTag: "local-a", frames: [], pages: [], images: [], coverageGaps: [], captured: Date.now(), fullPage: false, screenshot: false };
  firstBrowser.observations.set(session.id + ":local-a", observation);
  firstBrowser.observations.set(session.id + ":unrelated", { ...observation, tabTag: "unrelated" });
  await engine.localBrowsers.release(session.id);
  const secondBrowser = await engine.chromeFor(second);
  assert(!secondBrowser.observations.has(second.id + ":local-a"), "another session's observation is never borrowed");
  let captured = 0;
  secondBrowser.settleNavigation = async () => [{ tag: "local-a", loading: false }];
  secondBrowser.observe = async () => {
    captured++;
    return { ...observation, id: "fresh", frames: [{ id: "main", context: 1 }], pages: [{ url: "https://example.test/new", document: "fresh-document" }] };
  };
  secondBrowser.evaluate = async (_tag, _frame, expression) => {
    assert.match(expression, /fresh-document/);
    return { status: "executed", value: "local" };
  };
  const result = await secondBrowser.execute(second.id, second.cwd, { operation: "evaluate", tabTag: "local-a", expression: "1", feedback: "none" });
  assert.equal(result.value, "local"); assert.equal(result.basedOnSnapshotId, "fresh"); assert.equal(captured, 1);
  assert.equal(firstBrowser.observations.get(session.id + ":local-a"), observation);
  assert(!secondBrowser.observations.has(second.id + ":local-a"));
  secondBrowser.observations.set(second.id + ":local-a", observation);
  secondBrowser.observations.set(second.id + ":unrelated", { ...observation, tabTag: "unrelated" });

  const otherClient = { ...client, instance: "b".repeat(32), clientId: "e".repeat(32) };
  engine.localAgents.connect("alice", otherClient);
  const request = engine.localAgents.request;
  engine.localAgents.request = async (agent, ...args) => agent.clientId === otherClient.clientId ? { result: { connected: true } } : request(agent, ...args);
  const other = await store.newSession({ localAgent: true, clientId: otherClient.clientId, ownerId: "alice", cwd: client.cwd });
  const otherBrowser = await engine.chromeFor(other);
  otherBrowser.observations.set(other.id + ":local-a", observation);

  await secondBrowser.execute(second.id, second.cwd, { operation: "goto", tabTag: "local-a", url: "https://example.test/next", observe: "none" });
  assert(!firstBrowser.observations.has(session.id + ":local-a"));
  assert(!secondBrowser.observations.has(second.id + ":local-a"));
  assert(firstBrowser.observations.has(session.id + ":unrelated"));
  assert(otherBrowser.observations.has(other.id + ":local-a"), "another client is a separate browser");
  await engine.localBrowsers.release(second.id, true);
  assert(!firstBrowser.observations.has(second.id + ":unrelated"), "closing a session discards only its input context");
  assert(firstBrowser.observations.has(session.id + ":unrelated"));
});

test("a computer task keeps its task-bound local Chrome for new and legacy sessions", async (t) => {
  for (const legacy of [false, true]) await t.test(legacy ? "legacy session" : "new session", async (t) => {
    const { engine, store, calls } = await fixture(t);
    const employee = await engine.employee.for((await engine.employee.create({ name: "Chrome tester" }, "alice")).id);
    const config = { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: { fixture: { baseURL: "https://unused.test", models: { model: { supportsImages: true, modalities: { input: ["text", "image"] } } } } } };
    await store.put("config", config);
    engine.catalog.resolve = async (_c, selection) => resolveModel(config, selection || config.scenes.lightweight[0]);
    const added = await employee.execute("", { action: "add", kind: "todo", text: "Use the existing local Chrome tab" });
    const id = added.value.id;
    // 任务已绑定到这台客户端（交接后的状态）：电脑侧任务与浏览器都落在本机。
    await employee.update((state) => { employee.task(state, id).execution = { localAgent: true, localBrowser: true, clientId: client.clientId, browserClientId: client.clientId, clientName: client.name, browserClientName: client.name, localPlatform: client.platform, ownerId: "alice" }; employee.task(state, id).cwd = client.cwd; });
    let turns = 0;
    engine.providers.chat = async () => {
      if (++turns === 1) return { role: "assistant", calls: [{ id: "local-tabs", ...chromeCall({ operation: "tabs" }) }] };
      return { role: "assistant", text: "Verified the selected local Chrome" };
    };
    let previous = "";
    if (legacy) {
      previous = (await store.newSession({ localAgent: false, cwd: process.cwd(), taskId: id, employeeId: employee.employeeId, scene: "computer", model: "fixture/model" })).id;
      await store.append(previous, { role: "user", text: "Previous server browser handoff" });
      await store.append(previous, { role: "assistant", text: "Previously observed a server tab; do not replay submissions" });
    }
    await employee.update((state) => {
            const job = employee.task(state, id);
            job.side = "computer";
            if (previous) job.computerSession = previous;
            job.status = "running";
          });
    assert.equal(employee.task(await employee.state(), id).side, "computer", "电脑侧任务以 computer 执行");
    employee.busy.set(id, { computer: true, session: "" });
    await employee.run(employee.task(await employee.state(), id));
    const job = employee.task(await employee.state(), id), computer = await store.session(job.computerSession);
    assert.equal(computer.localAgent, true);
    assert.equal(computer.clientId, client.clientId);
    assert.equal(computer.ownerId, "alice");
    assert.equal(computer.localPlatform, client.platform);
    assert.equal(computer.cwd, client.cwd);
    assert(!job.workSession, "电脑侧任务不另建工作会话");
    assert.equal(job.side, "work", "电脑会话结束后回到主任务等待交付");
    assert.match(job.answer, /Verified the selected local Chrome/);
    assert(calls.some((call) => call.operation === "tabs"));
    assert.equal(calls.at(-1).operation, "release");
    if (legacy) {
      assert.equal(job.computerSession, previous, "repair keeps the original session and its history");
      assert.match((await store.messages(previous)).findLast((message) => message.role === "user")!.text!, /历史网页结果来自服务端/);
    }
  });
});

test("browser acquisition waits through a short outage instead of its old independent 15-second timeout", async (t) => {
  const { engine, session } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  engine.localAgents.request = LocalAgents.prototype.request;
  const jobs: any[] = [];
  const transport = { send: (job: any) => {
    jobs.push(job);
    if (job.op !== "cancel") queueMicrotask(() => engine.localAgents.result("alice", { instance: client.instance, id: job.id, result: { result: { connected: true } } }));
  }, close: () => {} };
  engine.localAgents.connect("alice", client, transport);
  const agent = engine.localAgents.active("alice", client.clientId)!;
  engine.localAgents.suspend("alice", client.instance);
  const acquiring = engine.chromeFor(session);
  t.mock.timers.tick(16000);
  await Promise.resolve();
  assert.equal(agent.pending.size, 1);
  assert.equal(jobs.length, 0);
  engine.localAgents.connect("alice", client, transport);
  await acquiring;
  assert.equal(jobs[0].args.operation, "acquire");
  await engine.localBrowsers.release(session.id);
});

test("ending a browser turn during an outage clears its retained lease even if cleanup cannot be delivered", async (t) => {
  const { engine, session } = await fixture(t);
  await engine.chromeFor(session);
  const agent = engine.localAgents.active("alice", client.clientId)!;
  assert.equal(agent.browserLeases.size, 1);
  engine.localAgents.suspend("alice", client.instance);
  engine.localAgents.request = async () => { throw Error("cleanup offline"); };
  await assert.rejects(engine.localBrowsers.release(session.id), /cleanup offline/);
  assert.equal(agent.browserLeases.size, 0, "reconnect must not retain a finished turn's browser lease");
});

test("competing sessions pause without input; releasing a turn admits the next session", async (t) => {
  const { engine, store, session, calls } = await fixture(t);
  await engine.chromeFor(session);
  const second = await store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
  const tools = await Tools.create(engine, second, { model: "", provider: {} }, new AbortController().signal, () => {});
  const result = await tools.execute({ id: "busy", ...chromeCall({ operation: "open", url: "https://example.com" }) }, {} as any);
  assert.equal(result.stop, true);
  assert.match(result.pause!, /独占/);
  assert(!calls.some((call) => call.operation === "open"));
  await engine.localBrowsers.release(session.id);
  await engine.chromeFor(second);
  assert.notEqual(calls[0].session, calls.at(-1).session);
});

test("offline, unbound and old clients never fall back to any server browser", async (t) => {
  const { engine, session } = await fixture(t);
  await assert.rejects(engine.chromeFor({ ...session, clientId: undefined }), /本机浏览器需要绑定/);
  engine.localAgents.request = async () => ({ error: "Unknown operation" });
  await assert.rejects(engine.chromeFor(session), /升级客户端/);
  assert.equal(engine.localAgents.active("alice", client.clientId)!.browserLeases.size, 0);
  engine.localAgents.disconnect("alice");
  await assert.rejects(engine.chromeFor(session), LocalAgentUnavailable);
});

test("server sessions keep their server browser even when clients are online", async (t) => {
  const { engine, store } = await fixture(t);
  assert.equal(await engine.chromeFor(await store.newSession({ ownerId: "alice" })), engine.chrome);
});

test("native browser leases survive model/tool roundtrips and release on completion, failure or cancellation", async (t) => {
  for (const mode of ["finish", "failure", "cancel"]) await t.test(mode, async (t) => {
    const { engine, store, session, calls } = await fixture(t);
    const config = { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: { fixture: { baseURL: "https://unused.test", models: { model: { supportsImages: true, modalities: { input: ["text", "image"] } } } } } };
    await store.put("config", config);
    engine.catalog.resolve = async (_c, selection) => resolveModel(config, selection || config.scenes.lightweight[0]);
    const next = await store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
    let turns = 0;
    engine.providers.chat = async () => {
      if (++turns === 1) return { role: "assistant", calls: [{ id: "local-tabs", ...chromeCall({ operation: "tabs" }) }] };
      await assert.rejects(engine.chromeFor(next), /独占/);
      if (mode === "failure") throw Error("fixture provider failure");
      if (mode === "cancel") engine.cancel(session.id);
      return { role: "assistant", text: "done" };
    };
    const run = engine.run(session.id, { role: "user", text: "list local tabs" });
    if (mode === "failure") await assert.rejects(run, /fixture provider failure/);
    else await run;
    assert.equal(calls.at(-1).operation, "release");
    assert.equal(engine.active.has(session.id), false);
    await engine.chromeFor(next);
    await engine.localBrowsers.release(next.id);
  });
});
