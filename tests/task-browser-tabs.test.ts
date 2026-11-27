import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { sleep } from "../server/core/util";
import { TaskBrowserTabs } from "../server/core/task-browser-tabs";
import { browserScreenshot } from "../server/core/browser-preview";
import { chromeCall, employeeCall } from "./public-call";

class BrowserFixture extends ChromeBridge {
  tabs: any[] = [{ tag: "user-tab", url: "https://existing.test/", active: true, controllable: true }];
  closed: string[] = [];
  online = true;
  failClose = false;
  serial = 0;
  override status() { return { ...super.status(), connected: this.online }; }
  override async request(operation: string, args: any) {
    if (!this.online) throw Error("offline");
    if (operation === "tabs") return { tabs: this.tabs.map((tab) => ({ ...tab })) };
    if (operation === "open" || operation === "new_tab") {
      const tab = { tag: "created-" + ++this.serial, url: args.url, active: true, controllable: true };
      this.tabs.push(tab);
      return { tabTag: tab.tag, tabs: this.tabs };
    }
    if (operation === "goto") return { tabTag: args.tabTag };
    if (operation === "close_tab") {
      this.closed.push(args.tabTag);
      if (this.failClose) throw Error("close result unknown");
      this.tabs = this.tabs.filter((tab) => tab.tag !== args.tabTag);
      return { tabTag: args.tabTag };
    }
    if (operation === "act") {
      const popup = { tag: "popup", openerTag: args.tabTag, url: "https://task.test/", active: true, controllable: true };
      this.tabs.push(popup);
      return { ok: true, completed: (args.steps || []).length || 1, openedTabs: [popup] };
    }
    throw Error("unexpected operation " + operation);
  }
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await sleep(5); }
  assert.fail("condition did not become true");
}

async function fixture(t: TestContext) {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const employee = await engine.employee.for((await engine.employee.create({ name: "Tab owner" }, "alice")).id);
  const bridge = new BrowserFixture(), chrome = new Chrome(store, bridge, "");
  engine.browsers.get = async () => chrome;
  engine.browsers.peek = () => chrome;
  engine.handoffs.ensureBrowserState = async () => undefined;
  const config = { provider: {}, scenes: { computer: ["fixture/model"] } } as any;
  async function job() {
    const id = (await employee.execute("", { action: "add", kind: "todo", text: "browser work" })).value.id;
    const session = await store.newSession({ ownerId: "alice", employeeId: employee.employeeId, taskId: id, scene: "computer" });
    await employee.update((state) => { Object.assign(employee.task(state, id), { status: "running", workSession: session.id }); });
    const tools = await Tools.create(engine, session, config, new AbortController().signal, () => {});
    return { id, session, tools };
  }
  const open = async (tools: Tools) => {
    const result = await tools.execute({ id: "open", ...chromeCall({ operation: "open", url: "https://task.test/", observe: "none" }) }, {} as any);
    return (result.value.tab || result.value.tabTag) as string;
  };
  t.after(async () => { await engine.close(); await store.close(); });
  return { store, engine, employee, bridge, chrome, job, open };
}

test("an extension poll wakes deferred browser cleanup", async () => {
  const bridge = new ChromeBridge(true);
  await bridge.start();
  let polls = 0;
  bridge.onPoll = () => { polls++; };
  const cancel = new AbortController();
  const request = fetch(`http://127.0.0.1:${bridge.port}/poll`, {
    method: "POST",
    headers: { origin: "chrome-extension://" + bridge.status().extensionId, authorization: "Bearer " + bridge.token, "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID() }), signal: cancel.signal,
  }).catch(() => undefined);
  try { await until(async () => polls > 0); }
  finally { cancel.abort(); await request; bridge.close(); }
});

test("terminal tasks reclaim only their own new tabs; a paused task keeps them", async (t) => {
  const f = await fixture(t), work = await f.job();
  await work.tools.execute({ id: "existing", ...chromeCall({ operation: "goto", tabTag: "user-tab", url: "https://existing.test/next", observe: "none" }) }, {} as any);
  const created = await f.open(work.tools);
  assert(await f.store.object("task-browser-tab", created));
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "deferred"; });
  await sleep(40);
  assert.deepEqual(f.bridge.closed, [], "等待外部结果不是任务结束");
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "done"; });
  await until(async () => !(await f.store.object("task-browser-tabs", work.id)));
  assert.deepEqual(f.bridge.closed, [created]);
  assert(f.bridge.tabs.some((tab) => tab.tag === "user-tab"), "原有标签不能被回收");
});

test("active tasks isolate their tabs from other tasks, while human browser-view protects them without releasing task lock", async (t) => {
  const f = await fixture(t), first = await f.job(), second = await f.job();
  const shared = await f.open(first.tools), viewed = await f.open(first.tools), disposable = await f.open(first.tools);
  // While first is running, second cannot see or hijack first's tabs.
  const listed = await second.tools.execute({ id: "list", ...chromeCall({ operation: "tabs", visual: "none" }) }, {} as any);
  assert(!listed.value.tabs.some((tab: any) => [shared, viewed, disposable].includes(tab.tag)));
  await assert.rejects(
    second.tools.execute({ id: "steal", ...chromeCall({ operation: "goto", tabTag: shared, url: "https://task.test/steal", observe: "none" }) }, {} as any),
    /正由另一个未完成\/等待中的任务/,
  );

  // Human live view (browser-view:*) is never blocked and marks the tab shared so cleanup preserves it,
  // while still keeping first's cross-task lock intact until first ends.
  f.chrome.feedback = async () => ({ tabTag: viewed, pages: [{ title: "page", url: "https://task.test/" }], images: [{ url: "/image", pixelWidth: 10, pixelHeight: 10 }] }) as any;
  await browserScreenshot(f.chrome, "browser-view:alice", viewed);
  await assert.rejects(
    second.tools.execute({ id: "steal-viewed", ...chromeCall({ operation: "goto", tabTag: viewed, url: "https://task.test/steal-viewed", observe: "none" }) }, {} as any),
    /正由另一个未完成\/等待中的任务/,
  );

  // Once first stops, second can take over `shared` (protecting it from cleanup if first later completes).
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "stopped"; });
  await second.tools.execute({ id: "borrow", ...chromeCall({ operation: "goto", tabTag: shared, url: "https://task.test/shared", observe: "none" }) }, {} as any);
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "done"; });
  await until(async () => !(await f.store.object("task-browser-tabs", first.id)));
  assert.deepEqual(f.bridge.closed, [disposable]);
  assert(f.bridge.tabs.some((tab) => tab.tag === shared));
  assert(f.bridge.tabs.some((tab) => tab.tag === viewed));
});

test("uniquely matched tabs of an active task stay hidden from other tasks' query, while ended tasks' tabs can be found and protected", async (t) => {
  const f = await fixture(t), first = await f.job(), second = await f.job(), created = await f.open(first.tools);
  f.bridge.tabs.find((tab) => tab.tag === created)!.url = "https://task.test/unique";
  f.chrome.feedback = async () => ({ pages: [] }) as any;
  const activeFind = await second.tools.execute({ id: "find-active", ...chromeCall({ operation: "tabs", query: "/unique", visual: "none" }) }, {} as any);
  assert.deepEqual(activeFind.value.tabs, []);

  // Once first stops (not running/sleeping/waiting), second can discover and take over the tab, protecting it from later done cleanup.
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "stopped"; });
  const stoppedFind = await second.tools.execute({ id: "find-stopped", ...chromeCall({ operation: "tabs", query: "/unique", visual: "none" }) }, {} as any);
  assert.equal(stoppedFind.value.tabs.length, 1);
  assert.equal(stoppedFind.value.tabs[0].tag, created);
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "done"; });
  await until(async () => !(await f.store.object("task-browser-tabs", first.id)));
  assert(!f.bridge.closed.includes(created));
});

test("stopped tasks retain their tabs for inspection, handoff and resumption", async (t) => {
  const f = await fixture(t), work = await f.job(), created = await f.open(work.tools);
  f.employee.busy.set(work.id, { computer: true, session: work.session.id });
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "stopped"; });
  f.employee.busy.delete(work.id);
  f.engine.taskTabs.finish(work.id);
  await sleep(40);
  assert.deepEqual(f.bridge.closed, []);
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "done"; });
  await until(async () => f.bridge.closed.includes(created));
});

test("deleting a stopped task reclaims its tracked tabs", async (t) => {
  const f = await fixture(t), work = await f.job(), created = await f.open(work.tools);
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "stopped"; });
  await f.employee.control({ action: "remove", id: work.id });
  await until(async () => f.bridge.closed.includes(created));
  assert.equal(await f.store.employeeTask(work.id), undefined);
});

test("cancelled tasks wait for any active execution to release the browser", async (t) => {
  const f = await fixture(t), work = await f.job(), created = await f.open(work.tools);
  f.employee.busy.set(work.id, { computer: true, session: work.session.id });
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "cancelled"; });
  await sleep(40);
  assert.deepEqual(f.bridge.closed, []);
  f.employee.busy.delete(work.id);
  f.engine.taskTabs.finish(work.id);
  await until(async () => f.bridge.closed.includes(created));
});

test("completed tasks cannot be resumed and finish tab cleanup cleanly", async (t) => {
  const f = await fixture(t), work = await f.job(), created = await f.open(work.tools);
  const request = f.bridge.request.bind(f.bridge);
  let entered!: () => void, unblock!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  f.bridge.request = async (operation, args) => {
    if (operation === "tabs") { entered(); await gate; }
    return request(operation, args);
  };
  try {
    await f.employee.update((state) => { Object.assign(f.employee.task(state, work.id), { status: "done", finishedAt: Date.now() }); });
    await waiting;
    const resume = f.employee.control({ action: "resume", id: work.id, text: "continue this work" });
    await sleep(20);
    unblock();
    await assert.rejects(resume, /不可重新启动/);
    await until(async () => f.bridge.closed.includes(created));
    assert.equal(f.employee.task(await f.employee.state(), work.id).status, "done");
  } finally { unblock(); }
});

test("task-created popup tabs are tracked even when the source tab was pre-existing", async (t) => {
  const f = await fixture(t), work = await f.job();
  const result = await work.tools.execute({ id: "click", ...chromeCall({ operation: "act", tabTag: "user-tab", action: { action: "press", key: "Enter" } }) }, {} as any);
  assert.equal(result.value.openedTabs[0].tag, "popup");
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "done"; });
  await until(async () => f.bridge.closed.includes("popup"));
  assert(!f.bridge.closed.includes("user-tab"));
});

test("a verified task completion triggers cleanup through the real scheduler lifecycle", async (t) => {
  const f = await fixture(t), work = await f.job();
  const config = { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } };
  await f.store.put("config", config);
  let step = 0;
  f.engine.providers.chat = async () => {
    if (step++ === 0) return { role: "assistant", calls: [{ id: "open", ...chromeCall({ operation: "open", url: "https://task.test/", observe: "none" }) }] };
    if (step === 2) return { role: "assistant", calls: [{ id: "progress", ...employeeCall({ action: "progress", text: "verified", plan: [{ content: "check page", status: "completed" }] }) }] };
    return { role: "assistant", calls: [{ id: "done", ...employeeCall({ action: "complete", deliverableRef: [], text: "page verified", summary: "页面已核验。" }) }] };
  };
  f.employee.busy.set(work.id, { computer: false, session: work.session.id });
  await f.employee.run(f.employee.task(await f.employee.state(), work.id));
  assert.equal(f.employee.task(await f.employee.state(), work.id).status, "done");
  await until(async () => f.bridge.closed.includes("created-1"));
  assert(f.bridge.tabs.some((tab) => tab.tag === "user-tab"));
});

test("restart restores pending cleanup without replaying an interrupted close", async (t) => {
  const f = await fixture(t), work = await f.job();
  const pending = await f.open(work.tools), uncertain = await f.open(work.tools);
  f.employee.runtime.taskFinished = undefined;
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "done"; });
  const entry = await f.store.object<any>("task-browser-tab", uncertain);
  await f.store.save("task-browser-tab", uncertain, { ...entry, closing: true });
  const restored = new TaskBrowserTabs(f.store, async () => f.chrome, async () => {}, () => false);
  await restored.restore();
  await until(async () => !(await f.store.object("task-browser-tabs", work.id)));
  await restored.close();
  assert.deepEqual(f.bridge.closed, [pending]);
  assert(f.bridge.tabs.some((tab) => tab.tag === uncertain));
});

test("offline cleanup is retried on reconnect, but an uncertain close is not replayed", async (t) => {
  const f = await fixture(t), work = await f.job(), created = await f.open(work.tools);
  f.bridge.online = false;
  await f.employee.update((state) => { f.employee.task(state, work.id).status = "done"; });
  await sleep(40);
  assert.deepEqual(f.bridge.closed, []);
  assert(await f.store.object("task-browser-tab", created));
  f.bridge.online = true;
  f.bridge.failClose = true;
  f.bridge.onPoll = () => f.engine.taskTabs.retry();
  f.bridge.onPoll();
  await until(async () => !(await f.store.object("task-browser-tabs", work.id)));
  assert.deepEqual(f.bridge.closed, [created]);
  f.engine.taskTabs.retry();
  await sleep(40);
  assert.deepEqual(f.bridge.closed, [created], "不确定的关闭不能盲目重放");
});

test("a local task reclaims tabs through its bound client's browser lease", async (t) => {
  const f = await fixture(t);
  const client = { instance: "a".repeat(32), clientId: "b".repeat(32), name: "PC", cwd: "C:\\work", platform: "windows" };
  f.engine.localAgents.connect("alice", client);
  const calls: string[] = [];
  let holder = "";
  f.engine.localAgents.request = async (_agent, op, args) => {
    assert.equal(op, "browser");
    calls.push(args.operation);
    if (args.operation === "release") { if (holder === args.session) holder = ""; return { result: { ok: true } }; }
    if (holder && holder !== args.session) return { status: "busy", error: "browser busy" };
    if (args.operation === "acquire") { holder = args.session; return { result: { connected: true } }; }
    return { result: await f.bridge.request(args.operation, args.args) };
  };
  const id = (await f.employee.execute("", { action: "add", kind: "todo", text: "local browser" })).value.id;
  const session = await f.store.newSession({ ownerId: "alice", employeeId: f.employee.employeeId, taskId: id, scene: "computer", localAgent: true, localBrowser: true, clientId: client.clientId, browserClientId: client.clientId, cwd: client.cwd });
  await f.employee.update((state) => { Object.assign(f.employee.task(state, id), { status: "running", workSession: session.id }); });
  const tools = await Tools.create(f.engine, session, { provider: {}, scenes: { computer: ["fixture/model"] } } as any, new AbortController().signal, () => {});
  const created = await f.open(tools);
  await f.engine.localBrowsers.release(session.id);
  await f.employee.update((state) => { f.employee.task(state, id).status = "done"; });
  await until(async () => f.bridge.closed.includes(created));
  await until(async () => holder === "");
  assert(calls.filter((op) => op === "acquire").length >= 2);
  assert.equal(calls.at(-1), "release");
});

test("runtime tab ownership isolates concurrent sessions, overlaps tab loading, and preserves human browser-view access", async (t) => {
  const f = await fixture(t);
  const hooks = { used: async () => {}, opened: async () => {}, exclusive: true };

  // Two concurrent opens must overlap their settleNavigation instead of serializing behind chrome.gate.
  let activeSettles = 0, peakSettles = 0;
  let releaseSettles!: () => void;
  const bothSettling = new Promise<void>((r) => { releaseSettles = r; });
  (f.chrome as any).settleNavigation = async () => {
    activeSettles++;
    peakSettles = Math.max(peakSettles, activeSettles);
    if (activeSettles === 2) releaseSettles();
    await bothSettling;
    activeSettles--;
    return f.bridge.tabs.map((tab) => ({ ...tab }));
  };
  (f.chrome as any).feedback = async (_owner: string, tag: string) => {
    const tab = f.bridge.tabs.find((item) => item.tag === tag)!;
    return { tabTag: tag, pages: [{ title: "ok", url: tab.url }], images: [] };
  };

  const [openA, openB] = await Promise.all([
    f.chrome.execute("session-A", ".", { operation: "open", url: "https://site-a.test/" }, undefined, [], hooks),
    f.chrome.execute("session-B", ".", { operation: "open", url: "https://site-b.test/" }, undefined, [], hooks),
  ]);
  assert.equal(peakSettles, 2, "concurrent tab opens must settle in parallel after fast creation");
  assert.equal(f.chrome.tabOwners.get(openA.tabTag), "session-A");
  assert.equal(f.chrome.tabOwners.get(openB.tabTag), "session-B");

  // Each session's chrome_tabs only sees unowned tabs and its own tabs, never the other's.
  const tabsForB = await f.chrome.execute("session-B", ".", { operation: "tabs" }, undefined, [], hooks);
  assert(tabsForB.tabs.some((tab: any) => tab.tag === openB.tabTag));
  assert(!tabsForB.tabs.some((tab: any) => tab.tag === openA.tabTag));

  // Cross-session goto / select_tab / close_tab on A's tab are synchronously rejected.
  await assert.rejects(
    f.chrome.execute("session-B", ".", { operation: "goto", tabTag: openA.tabTag, url: "https://evil.test/", observe: "none" }, undefined, [], hooks),
    /正由另一个并行会话占用/,
  );
  await assert.rejects(
    f.chrome.execute("session-B", ".", { operation: "close_tab", tabTag: openA.tabTag }, undefined, [], hooks),
    /正由另一个并行会话占用/,
  );

  // Human live view (browser-view:*) is never blocked by agent leases.
  const human = await f.chrome.execute("browser-view:alice", ".", { operation: "goto", tabTag: openA.tabTag, url: "https://human.test/", observe: "none" });
  assert.equal(human.tabTag, openA.tabTag);

  // Releasing session-A's leases lets session-B cleanly reuse openA.tabTag.
  f.chrome.releaseTabs("session-A");
  assert.equal(f.chrome.tabOwners.get(openA.tabTag), undefined);
  assert.equal(f.chrome.tabOwners.get(openB.tabTag), "session-B");
  const reused = await f.chrome.execute("session-B", ".", { operation: "goto", tabTag: openA.tabTag, url: "https://reused.test/", observe: "none" }, undefined, [], hooks);
  assert.equal(reused.tabTag, openA.tabTag);
  assert.equal(f.chrome.tabOwners.get(openA.tabTag), "session-B");
  f.chrome.releaseTabs("session-B");
  assert.equal(f.chrome.tabOwners.size, 0);
});

test("sleeping and waiting tasks keep exclusive tab isolation across sessions while same-task phases can reuse their tabs", async (t) => {
  const f = await fixture(t), first = await f.job(), second = await f.job();
  const created = await f.open(first.tools);
  // Simulate phase end: runtime tabOwners is empty, only persistent TaskBrowserTabs ownership remains.
  f.chrome.releaseTabs(first.session.id);
  assert.equal(f.chrome.tabOwners.size, 0);

  for (const status of ["deferred", "waiting", "approval", "queued", "recovering"]) {
    await f.employee.update((state) => { f.employee.task(state, first.id).status = status; });
    const listed = await second.tools.execute({ id: "list-" + status, name: "browser_tabs", arguments: { action: "list" } }, {} as any);
    assert(!listed.value.tabs.some((tab: any) => tab.tag === created), `status=${status} must hide tab from second task`);
    for (const [label, toolName, args] of [
      ["goto", "browser_tabs", { action: "goto", tab: created, url: "https://evil.test/", view: false }],
      ["view", "browser_view", { tab: created, screenshot: false }],
      ["act", "browser_act", { tab: created, steps: [{ op: "wait", ms: 0 }], screenshot: false }],
      ["close", "browser_tabs", { action: "close", tab: created }],
    ] as [string, string, any][]) {
      await assert.rejects(
        second.tools.execute({ id: `${status}-${label}`, name: toolName, arguments: args }, {} as any),
        /正由另一个未完成\/等待中的任务/,
        `status=${status} op=${label} must be rejected`,
      );
    }
  }

  // A later browser_agent phase / session of the SAME task can still see and reuse `created`.
  const sameTaskLater = await f.store.newSession({ ownerId: "alice", employeeId: f.employee.employeeId, taskId: first.id, scene: "computer" });
  const sameTaskTools = await Tools.create(f.engine, sameTaskLater, { provider: {}, scenes: { computer: ["fixture/model"] } } as any, new AbortController().signal, () => {});
  const sameListed = await sameTaskTools.execute({ id: "same-list", name: "browser_tabs", arguments: { action: "list" } }, {} as any);
  assert(sameListed.value.tabs.some((tab: any) => tab.tag === created));
  const reused = await sameTaskTools.execute({ id: "same-goto", ...chromeCall({ operation: "goto", tabTag: created, url: "https://task.test/resumed", observe: "none" }) }, {} as any);
  assert.equal(reused.value.tab || reused.value.tabTag, created);
});

test("pre-existing user-tab used by a deferred task is protected from other tasks and never auto-closed on done", async (t) => {
  const f = await fixture(t), first = await f.job(), second = await f.job();
  await first.tools.execute({ id: "nav-user", ...chromeCall({ operation: "goto", tabTag: "user-tab", url: "https://existing.test/work", observe: "none" }) }, {} as any);
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "deferred"; });

  const listed = await second.tools.execute({ id: "list-user", ...chromeCall({ operation: "tabs", visual: "none" }) }, {} as any);
  assert(!listed.value.tabs.some((tab: any) => tab.tag === "user-tab"), "deferred task's pre-existing tab must be hidden from second task");
  await assert.rejects(
    second.tools.execute({ id: "steal-user", ...chromeCall({ operation: "goto", tabTag: "user-tab", url: "https://evil.test/", observe: "none" }) }, {} as any),
    /正由另一个未完成\/等待中的任务/,
  );

  // Once first completes, user-tab must NOT be closed and becomes available to second again.
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "done"; });
  await until(async () => !(await f.store.object("task-browser-tabs", first.id)));
  assert(f.bridge.tabs.some((tab) => tab.tag === "user-tab"));
  assert(!f.bridge.closed.includes("user-tab"));
  const afterDone = await second.tools.execute({ id: "list-after", ...chromeCall({ operation: "tabs", visual: "none" }) }, {} as any);
  assert(afterDone.value.tabs.some((tab: any) => tab.tag === "user-tab"));
});

test("explicit tab close releases task ownership, and plain sessions cannot hijack active task tabs while human views can", async (t) => {
  const f = await fixture(t), first = await f.job();
  const tabA = await f.open(first.tools);
  const tabB = await f.open(first.tools);
  await f.employee.update((state) => { f.employee.task(state, first.id).status = "waiting"; });

  // Plain non-task session cannot hijack tabA while first is waiting.
  const plainSession = await f.store.newSession({ ownerId: "alice", scene: "computer" });
  const plainTools = await Tools.create(f.engine, plainSession, { provider: {}, scenes: { computer: ["fixture/model"] } } as any, new AbortController().signal, () => {});
  await assert.rejects(
    plainTools.execute({ id: "plain-steal", ...chromeCall({ operation: "goto", tabTag: tabA, url: "https://evil.test/", observe: "none" }) }, {} as any),
    /正由另一个未完成\/等待中的任务/,
  );

  // Human views (employee-view:* and browser-view:*) remain unrestricted.
  const empView = await f.chrome.execute("employee-view:alice", ".", { operation: "goto", tabTag: tabA, url: "https://human-emp.test/", observe: "none" });
  assert.equal(empView.tabTag, tabA);

  // Explicit close by owning task releases its ownership record immediately.
  await first.tools.execute({ id: "close-b", name: "browser_tabs", arguments: { action: "close", tab: tabB } }, {} as any);
  assert.equal(await f.store.object("task-browser-tab", tabB), undefined);
  assert(await f.store.object("task-browser-tab", tabA));
});

test("real isolated Chrome closes a finished task's tab while preserving the user's existing page", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-task-tabs-")), previous = process.env.VEGA_DB;
  process.env.VEGA_DB = join(dir, "vega.db");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<title>Task tab fixture</title><a href="/popup" target="_blank">Open detail</a>');
  });
  const store = await Store.open(":memory:");
  const pageScript = await readFile("server/assets/browser/browser-page.js", "utf8");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), pageScript));
  engine.employee.closed = true;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as any).port}/`;
    const employee = await engine.employee.for((await engine.employee.create({ name: "Real browser" }, "alice")).id);
    const id = (await employee.execute("", { action: "add", kind: "todo", text: "open fixture" })).value.id;
    const session = await store.newSession({ ownerId: "alice", employeeId: employee.employeeId, taskId: id, scene: "computer" });
    await employee.update((state) => { Object.assign(employee.task(state, id), { status: "running", workSession: session.id }); });
    const browser = await engine.chromeFor(session);
    const existing = await browser.execute("manual", session.cwd, { operation: "open", url, observe: "none" });
    const tools = await Tools.create(engine, session, { provider: {}, scenes: { computer: ["fixture/model"] } } as any, new AbortController().signal, () => {});
    const created = await tools.execute({ id: "open", ...chromeCall({ operation: "open", url, visual: "none" }) }, {} as any);
    const tag = created.value.tabTag;
    assert.notEqual(tag, existing.tabTag);
    const link = created.value.pages[0].items.find((item: any) => item.name === "Open detail");
    assert(link, "fixture link must be observed before clicking");
    const click = await tools.execute({ id: "click", ...chromeCall({ operation: "act", tabTag: tag, action: { action: "click", ref: link.ref }, visual: "none" }) }, {} as any);
    assert.equal(click.value.status, "executed", click.value.reason);
    assert.equal(click.value.openedTabs.length, 1);
    const popup = click.value.openedTabs[0].tag;
    assert((await browser.bridge.request("tabs", {})).tabs.some((tab: any) => tab.tag === popup));
    await employee.update((state) => { employee.task(state, id).status = "done"; });
    await until(async () => !(await store.object("task-browser-tabs", id)));
    const remaining = (await browser.bridge.request("tabs", {})).tabs.map((tab: any) => tab.tag);
    assert(!remaining.includes(tag));
    assert(!remaining.includes(popup));
    assert(remaining.includes(existing.tabTag));
    assert(engine.browsers.entries.get(engine.browserProfileKey("alice"))?.browser.child, "task cleanup must not terminate the shared browser");
  } finally {
    await engine.close();
    await store.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.VEGA_DB; else process.env.VEGA_DB = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
