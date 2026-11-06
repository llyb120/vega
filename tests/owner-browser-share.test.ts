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
