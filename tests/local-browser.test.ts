import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { LocalAgentUnavailable } from "../server/core/local-agent";
import { Tools } from "../server/core/tools";
import { resolveModel } from "../server/core/config";

const client = { instance: "a".repeat(32), clientId: "d".repeat(32), name: "Local PC", cwd: "C:\\only-on-client", platform: "windows" };
function fixture(t: TestContext) {
  const store = new Store(":memory:"), engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  t.after(async () => { await engine.close(); store.close(); });
  engine.localAgents.connect("alice", client);
  const session = store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
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

test("local Chrome tools and employee tasks use only their selected native browser and local uploads", async (t) => {
  const { engine, store, session, calls } = fixture(t);
  const tools = new Tools(engine, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  const result = await tools.execute({ id: "tabs", name: "chrome", arguments: { operation: "tabs" } }, {} as any);
  assert.equal(result.value.tabs[0].tag, "local-a");
  const chrome = await engine.chromeFor({ ...session, employeeId: "employee", taskId: "task" });
  assert.equal(chrome, await engine.chromeFor(store.session(session.id)));
  assert.equal(await chrome.workspaceFile(session.cwd, "upload.txt"), "C:\\only-on-client\\upload.txt");
  const upload = calls.find((c) => c.operation === "workspace_file");
  assert.deepEqual(upload.args, { cwd: client.cwd, path: "upload.txt" });
  assert.equal(new Set(calls.map((c) => c.session)).size, 1, "same session keeps a lease across tool calls");
  await engine.localBrowsers.release(session.id);
  assert.equal(calls.at(-1).operation, "release");
});

test("competing sessions pause without input; releasing a turn admits the next session", async (t) => {
  const { engine, store, session, calls } = fixture(t);
  await engine.chromeFor(session);
  const second = store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
  const tools = new Tools(engine, second, { model: "", provider: {} }, new AbortController().signal, () => {});
  const result = await tools.execute({ id: "busy", name: "chrome", arguments: { operation: "open", url: "https://example.com" } }, {} as any);
  assert.equal(result.stop, true);
  assert.match(result.pause!, /独占/);
  assert(!calls.some((call) => call.operation === "open"));
  await engine.localBrowsers.release(session.id);
  await engine.chromeFor(second);
  assert.notEqual(calls[0].session, calls.at(-1).session);
});

test("offline, unbound and old clients never fall back to any server browser", async (t) => {
  const { engine, session } = fixture(t);
  await assert.rejects(engine.chromeFor({ ...session, clientId: undefined }), /尚未绑定/);
  engine.localAgents.request = async () => ({ error: "Unknown operation" });
  await assert.rejects(engine.chromeFor(session), /升级客户端/);
  engine.localAgents.disconnect("alice");
  await assert.rejects(engine.chromeFor(session), LocalAgentUnavailable);
});

test("server sessions keep their server browser even when clients are online", async (t) => {
  const { engine, store } = fixture(t);
  assert.equal(await engine.chromeFor(store.newSession({ ownerId: "alice" })), engine.chrome);
});

test("native browser leases survive model/tool roundtrips and release on completion, failure or cancellation", async (t) => {
  for (const mode of ["finish", "failure", "cancel"]) await t.test(mode, async (t) => {
    const { engine, store, session, calls } = fixture(t);
    const config = { model: "fixture/model", provider: { fixture: { baseURL: "https://unused.test", models: { model: { supportsImages: true } } } } };
    store.put("config", config);
    engine.catalog.resolve = async () => resolveModel(config);
    const next = store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: client.cwd, scene: "computer" });
    let turns = 0;
    engine.providers.chat = async () => {
      if (++turns === 1) return { role: "assistant", calls: [{ id: "local-tabs", name: "chrome", arguments: { operation: "tabs" } }] };
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
