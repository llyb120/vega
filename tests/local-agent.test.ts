import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalAgents } from "../server/core/local-agent";

// The detection window decides delegation: fresh pings => local, stale => server.
test("local agent online/offline flips tool delegation within ~3s", () => {
  const la = new LocalAgents();
  assert.equal(la.online(), false, "no agent registered");
  const agent = la.register(50001, "x".repeat(32), "D:/work");
  assert.equal(la.online(), true, "register makes it online");
  assert.equal(la.active()?.port, 50001);
  // Recent ping keeps it online.
  la.ping(50001, "x".repeat(32), "D:/work");
  assert.equal(la.online(), true);
  // Simulate a missed heartbeat past the window.
  agent.lastSeen = Date.now() - 4000;
  assert.equal(la.online(), false, "stale agent is offline -> server fallback");
  // Wrong token cannot keep it alive or delete it.
  assert.throws(() => la.ping(50001, "wrong-token-aaaaaaaa", ""));
  la.remove(50001, "wrong-token-aaaaaaaa");
  assert.equal(la.online(), false, "bad token must not revive or remove");
  // A fresh ping with the right token brings it back online.
  la.ping(50001, "x".repeat(32), "D:/work");
  assert.equal(la.online(), true, "fresh ping revives the agent");
});

test("graceful deregister takes effect immediately", () => {
  const la = new LocalAgents();
  la.register(50002, "y".repeat(32), "");
  assert.equal(la.online(), true);
  la.remove(50002, "y".repeat(32));
  assert.equal(la.online(), false, "closed agent drops delegation at once");
});

test("newest live agent wins when several are registered", () => {
  const la = new LocalAgents();
  const old = la.register(50010, "a".repeat(32), "");
  old.lastSeen = Date.now() - 1000;
  const fresh = la.register(50011, "b".repeat(32), "");
  assert.equal(la.active()?.port, 50011, "prefer most recent heartbeat");
  fresh.lastSeen = Date.now() - 5000; // fresh goes stale
  assert.equal(la.active()?.port, 50010, "fall back to the other live one");
});
