import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

test("same owner employees share one private Chromium profile; different owners stay isolated", async (t) => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  t.after(async () => { await engine.close(); await store.close(); });

  const aliceA = await engine.employee.create({ name: "Alice A", cwd: process.cwd() }, "alice");
  const aliceB = await engine.employee.create({ name: "Alice B", cwd: process.cwd() }, "alice");
  const bobA = await engine.employee.create({ name: "Bob A", cwd: process.cwd() }, "bob");

  const sessionAA = await store.newSession({ ownerId: "alice", employeeId: aliceA.id, title: "aa" });
  const sessionAB = await store.newSession({ ownerId: "alice", employeeId: aliceB.id, title: "ab" });
  const sessionBA = await store.newSession({ ownerId: "bob", employeeId: bobA.id, title: "ba" });
  const cloudAlice = await store.newSession({ ownerId: "alice", title: "cloud-alice" });

  assert.equal(engine.browserProfileKey("alice"), "user_alice");
  assert.equal(engine.browserProfileKey("bob"), "user_bob");

  const keys: string[] = [];
  const aliceChrome = { owner: "alice" } as any;
  const bobChrome = { owner: "bob" } as any;
  engine.browsers.get = async (id: string) => {
    keys.push(id);
    if (id === "user_alice") return aliceChrome;
    if (id === "user_bob") return bobChrome;
    throw Error("unexpected browser key " + id);
  };
  const removed: string[] = [];
  engine.browsers.remove = async (id: string) => { removed.push(id); };

  assert.equal(await engine.chromeFor(sessionAA), aliceChrome);
  assert.equal(await engine.chromeFor(sessionAB), aliceChrome, "same owner's employees share one Chromium");
  assert.equal(await engine.chromeFor(sessionBA), bobChrome, "different owners must not share Chromium");
  assert.deepEqual(keys, ["user_alice", "user_alice", "user_bob"]);
  assert.equal(keys.includes(aliceA.id), false, "legacy per-employee keys are unused");

  // Deleting one employee must not wipe the shared owner browser.
  await engine.removeEmployee(aliceA.id);
  assert.deepEqual(removed, []);
  assert.equal(await engine.chromeFor(sessionAB), aliceChrome);

  void cloudAlice;
});

test("engine dynamically binds per-owner SOCKS proxy only when that same account has an online client, never affected by another account", async (t) => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  t.after(async () => { await engine.close(); await store.close(); });

  const makeMockEntry = (ownerKey: string) => {
    const bridge = new ChromeBridge(true);
    const chrome = new Chrome(store, bridge, "");
    const browser = { child: undefined as any, start: async () => { browser.child = { pid: 1 }; bridge.clients.set("c1", { at: Date.now(), browser: "Google Chrome" }); }, close: async () => { browser.child = undefined; } } as any;
    const proxyEvents: any[] = [];
    t.mock.method(bridge, "start", async () => {});
    t.mock.method(bridge, "request", async (op: string, args: any) => {
      if (op === "status") return { version: bridge.version };
      if (op === "set_proxy") { proxyEvents.push(args.proxy); return { supported: true }; }
      throw Error("unexpected op " + op);
    });
    engine.browsers.entries.set(ownerKey, { chrome, browser });
    return { chrome, browser, proxyEvents };
  };

  const alice = makeMockEntry("user_alice");
  const bob = makeMockEntry("user_bob");

  // 1. Bob connects an online client with relay configured; Alice has NO client.
  const bobGrant = { userId: "bob", clientId: "b".repeat(32), hash: "bob-hash" };
  engine.localAgents.connect("bob", { clientId: bobGrant.clientId, instance: "b".repeat(32), platform: "windows", cwd: "C:\\bob" }, { send() {}, close() {} });
  await engine.relay.configure(bobGrant, [], true);

  // 2. Starting Alice's browser stays strictly direct (null proxy), untouched by Bob's online client!
  await engine.browsers.get("user_alice");
  assert.deepEqual([...alice.proxyEvents], [null], "Bob's online client must NEVER attach a SOCKS proxy to Alice's Chrome");

  // 3. Starting Bob's browser attaches Bob's own SOCKS proxy.
  await engine.browsers.get("user_bob");
  assert.equal(bob.proxyEvents.length, 1);
  assert.equal(bob.proxyEvents[0]?.scheme, "socks5");

  // 4. Alice connects her own client -> Engine live-pushes Alice's own SOCKS proxy to Alice's running Chrome (different port from Bob!).
  const aliceGrant = { userId: "alice", clientId: "a".repeat(32), hash: "alice-hash" };
  engine.localAgents.connect("alice", { clientId: aliceGrant.clientId, instance: "a".repeat(32), platform: "darwin", cwd: "/Users/alice" }, { send() {}, close() {} });
  await engine.relay.configure(aliceGrant, [], true);
  await new Promise((r) => setTimeout(r, 20));
  const aliceLast: any = alice.proxyEvents.at(-1);
  assert.equal(aliceLast?.scheme, "socks5");
  assert.notEqual(aliceLast?.port, bob.proxyEvents[0]?.port, "each account uses its own isolated SOCKS port");

  // 5. Alice's client suspends -> Engine live-switches Alice's Chrome back to direct (null) without touching Bob!
  const bobCountBefore = bob.proxyEvents.length;
  engine.localAgents.suspend("alice", "a".repeat(32));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alice.proxyEvents.at(-1), null, "suspending Alice's client switches Alice's Chrome back to direct");
  assert.equal(bob.proxyEvents.length, bobCountBefore, "Alice's client changes never touch Bob's Chrome");
});
