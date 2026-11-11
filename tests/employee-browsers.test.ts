import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge, requestTimeout } from "../server/core/chrome-bridge";
import { EmployeeBrowsers } from "../server/core/employee-browsers";
import { HeadlessBrowser, headlessArguments } from "../server/core/headless";
import type { CloudRuntime } from "../server/core/cloud";
import { join, resolve } from "node:path";

async function fixture(t: TestContext, networkProxy?: (id: string) => Promise<string | undefined>, isolation?: (id: string) => Promise<CloudRuntime | undefined>) {
  const store = await Store.open(":memory:"), browsers = new EmployeeBrowsers(store, "", networkProxy, isolation);
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
  t.after(async () => { await browsers.close(); await store.close(); });
  return { browsers, chrome, bridge, browser, start, close, probe, connect };
}

test("employee browsers automatically receive the owner's stable network proxy", async (t) => {
  const proxy = "socks5://127.0.0.1:12345", requests: string[] = [];
  const f = await fixture(t, async (id) => { requests.push(id); return proxy; });
  await f.browsers.get("ea");
  await f.browsers.get("ea");
  assert.deepEqual(requests, ["ea"]);
  assert.equal((f.start.mock.calls[0].arguments as any[])[1].proxy, proxy);
  const args = headlessArguments("profile", "extension", { proxy, port: 47753 });
  assert(args.includes("--proxy-server=" + proxy));
  assert(args.includes("--proxy-bypass-list=<-loopback>;127.0.0.1:47753"));
  assert(args.includes("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"));
  assert(args.includes("--disable-quic"));
  assert(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert(!headlessArguments("profile", "extension").some((arg) => arg.startsWith("--proxy-")));
});

test("cloud browsers use the owner's identity for profiles, uploads and cleanup without shared fallback", async (t) => {
  const home = resolve("private-alice"), removed: string[] = [];
  const cloud = { identity: async () => ({ home }), fs: {
    realpath: async (path: string) => resolve(path), stat: async () => ({ isFile: () => true }),
    rm: async (path: string) => { removed.push(path); },
  } } as unknown as CloudRuntime;
  const f = await fixture(t, undefined, async () => cloud);
  await f.browsers.get("ea");
  assert.equal((f.start.mock.calls[0].arguments as any[])[2], cloud);
  assert.equal((f.start.mock.calls[0].arguments as any[])[1].profile, join(home, "browsers", "ea"));
  assert.equal(await f.chrome.workspaceFile(home, "report.txt"), join(home, "report.txt"));
  await assert.rejects(f.chrome.workspaceFile(home, "../private-bob/report.txt"), /within the working directory/);
  await f.browsers.remove("ea");
  assert.deepEqual(removed, [join(home, "browsers", "ea")]);
  const failed = await fixture(t, undefined, async () => { throw Error("identity initialization failed"); });
  await assert.rejects(failed.browsers.get("ea"), /identity initialization failed/);
  assert.equal(failed.start.mock.callCount(), 0);
});

test("employee browsers start lazily, share concurrent recovery and stay resident across tasks", async (t) => {
  const f = await fixture(t);
  assert.equal(f.start.mock.callCount(), 0);
  const [a, b] = await Promise.all([f.browsers.get("ea"), f.browsers.get("ea")]);
  assert.equal(a, b);
  assert.equal(f.start.mock.callCount(), 1);
  assert.equal(f.probe.mock.callCount(), 1);
  const child = f.browser.child;
  assert.equal(await f.browsers.get("ea"), a);
  assert.equal(f.probe.mock.callCount(), 1, "a recent successful probe is reused within the short TTL");
  assert.equal(f.browser.child, child);
  assert.equal(f.close.mock.callCount(), 0);

  f.browsers.entries.get("ea")!.probedAt = Date.now() - EmployeeBrowsers.PROBE_TTL_MS - 1;
  f.probe.mock.mockImplementationOnce(async () => { throw Error("stale heartbeat"); });
  assert.equal(await f.browsers.get("ea"), a);
  assert.equal(f.probe.mock.callCount(), 3, "only the harmless probe is retried after TTL expiry");
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
  const f = await fixture(t);
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
  const f = await fixture(t);
  await f.browsers.get("ea");
  f.browsers.entries.get("ea")!.probedAt = Date.now() - EmployeeBrowsers.PROBE_TTL_MS - 1;
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
    headers: { Origin: "chrome-extension://bhiemmbmefifaloapbcopihahhckolce", Authorization: "Bearer " + bridge.token, "Content-Type": "application/json" },
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


test("bridge request timeouts give navigation and probes at least 10s headroom", async (t) => {
  for (const op of ["tabs", "goto", "open", "new_tab", "status", "close_tab", "back", "forward", "reload", "cdp", "devtools"])
    assert.equal(requestTimeout(op), 10000, op);
  assert.equal(requestTimeout("act"), 8000);
  assert.equal(requestTimeout("evaluate"), 8000);
  assert.equal(requestTimeout("inspect"), 8000);
  const bridge = new ChromeBridge(true);
  t.after(() => bridge.close());
  await bridge.start();
  const client = crypto.randomUUID();
  bridge.clients.set(client, { at: Date.now(), browser: "Google Chrome" });
  const pending = bridge.request("tabs", {});
  const queued = bridge.queues.get(client)![0] as any;
  assert(queued.expiresAt - Date.now() >= 9000, "tabs command must not expire at the old 3s budget");
  const id = queued.id;
  bridge.pending.get(id)!.resolve({ tabs: [] });
  await pending;
});
