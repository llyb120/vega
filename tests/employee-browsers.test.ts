import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { EmployeeBrowsers } from "../server/core/employee-browsers";
import { HeadlessBrowser } from "../server/core/headless";

function fixture(t: TestContext) {
  const store = new Store(":memory:"), browsers = new EmployeeBrowsers(store, "");
  const bridge = new ChromeBridge(true), chrome = new Chrome(store, bridge, ""), browser = new HeadlessBrowser();
  const client = crypto.randomUUID();
  const connect = () => bridge.clients.set(client, { at: Date.now(), browser: "Google Chrome" });
  const start = t.mock.method(browser, "start", async () => {
    browser.child = { pid: start.mock.callCount() } as typeof browser.child;
    connect();
  });
  const close = t.mock.method(browser, "close", async () => { browser.child = undefined; });
  t.mock.method(bridge, "start", async () => {});
  const probe = t.mock.method(bridge, "request", async (operation: string) => {
    assert.equal(operation, "status", "recovery must not replay page operations");
    return { version: bridge.version };
  });
  browsers.entries.set("ea", { chrome, browser });
  t.after(async () => { await browsers.close(); store.close(); });
  return { browsers, chrome, bridge, browser, start, close, probe, connect };
}

test("employee browsers start lazily, share concurrent recovery and stay resident across tasks", async (t) => {
  const f = fixture(t);
  assert.equal(f.start.mock.callCount(), 0);
  const [a, b] = await Promise.all([f.browsers.get("ea"), f.browsers.get("ea")]);
  assert.equal(a, b);
  assert.equal(f.start.mock.callCount(), 1);
  assert.equal(f.probe.mock.callCount(), 1);
  const child = f.browser.child;
  assert.equal(await f.browsers.get("ea"), a);
  assert.equal(f.probe.mock.callCount(), 2, "a cached connected flag cannot bypass a real probe");
  assert.equal(f.browser.child, child);
  assert.equal(f.close.mock.callCount(), 0);

  f.probe.mock.mockImplementationOnce(async () => { throw Error("stale heartbeat"); });
  assert.equal(await f.browsers.get("ea"), a);
  assert.equal(f.probe.mock.callCount(), 4, "only the harmless probe is retried");
  assert.equal(f.browser.child, child);

  f.browser.child = undefined;
  f.chrome.observations.set("old", {} as any);
  assert.equal(await f.browsers.get("ea"), a);
  assert.equal(f.start.mock.callCount(), 2, "an exited process is recreated on use");
  assert.equal(f.chrome.observations.size, 0, "a new process cannot reuse stale observations");
  assert.equal(f.close.mock.callCount(), 0);
});

test("a disconnected resident browser survives recovery timeout and heals on the next access", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const f = fixture(t);
  await f.browsers.get("ea");
  const child = f.browser.child;
  f.bridge.clients.clear();
  const timeout = assert.rejects(f.browsers.get("ea"), /已保留浏览器和页面/);
  t.mock.timers.tick(30001);
  await timeout;
  assert.equal(f.browser.child, child);
  assert.equal(f.close.mock.callCount(), 0, "losing the extension must not destroy live pages");
  assert.equal(f.browsers.entries.get("ea")!.starting, undefined);
  f.connect();
  assert.equal(await f.browsers.get("ea"), f.chrome);
  assert.equal(f.start.mock.callCount(), 1);
});

test("stopping during a health probe cannot return or resurrect the browser", async (t) => {
  const f = fixture(t);
  await f.browsers.get("ea");
  let complete!: (value: any) => void;
  f.probe.mock.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const pending = assert.rejects(f.browsers.get("ea"), /browser.*(stopped|exited)/i);
  const stopped = f.browsers.stop("ea");
  complete({});
  await Promise.all([pending, stopped]);
  assert.equal(f.browser.child, undefined);
  assert.equal(f.start.mock.callCount(), 1);
  assert.equal(f.close.mock.callCount(), 1);
});

test("a reloaded private worker immediately replaces a stale peer without replaying its command", async (t) => {
  const bridge = new ChromeBridge(true);
  t.after(() => bridge.close());
  await bridge.start();
  const oldClient = crypto.randomUUID(), newClient = crypto.randomUUID();
  bridge.clients.set(oldClient, { at: Date.now(), browser: "Google Chrome" });
  assert.equal(bridge.primary()![0], oldClient);
  const cancelled = new AbortController();
  const original = assert.rejects(bridge.request("open", { url: "https://example.com" }, cancelled.signal), /cancelled/);
  const oldCommand = bridge.queues.get(oldClient)![0];
  const post = (path: string, body: any) => fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: "POST",
    headers: { Origin: "chrome-extension://mdicifjlbgnkkdkcbfdnebeghhlamjbm", Authorization: "Bearer " + bridge.token, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, clientId: newClient }),
  });
  const poll = post("/poll", {});
  for (let i = 0; i < 100 && !bridge.clients.has(newClient); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(bridge.primary()![0], newClient, "do not pin new work to the old worker for 45 seconds");
  const probe = bridge.request("status", {});
  const payload = await (await poll).json();
  assert.equal(payload.command.operation, "status");
  assert.equal(bridge.pending.get(oldCommand.id)?.client, oldClient);
  assert.equal(bridge.queues.get(oldClient)![0], oldCommand, "old work is never migrated to the new worker");
  await (await post("/reply", { id: payload.command.id, result: { version: bridge.version } })).text();
  assert.deepEqual(await probe, { version: bridge.version });
  cancelled.abort();
  await original;
});
