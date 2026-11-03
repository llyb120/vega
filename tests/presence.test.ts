import { test } from "node:test";
import assert from "node:assert/strict";
import { linuxPresence, systemPresence } from "../server/core/presence";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Employee } from "../server/core/employee";
import { sleep } from "../server/core/util";
test("OS idle/lock hints do not silently treat unavailable sessions as idle", () => {
  const now = Date.now(),
    status = linuxPresence(
      `IdleHint=yes\nLockedHint=yes\nIdleSinceHint=${(now - 60000) * 1000}`,
      now,
    );
  assert.equal(status.locked, true);
  assert.equal(status.idleMs, 60000);
  assert.equal(linuxPresence("").available, false);
  assert.equal(linuxPresence("").locked, true);
});
test("locked computer tasks remain queued, unlock resumes same task without LLM polling", async () => {
  const store = new Store(":memory:");
  let locked = true,
    runs = 0;
  const employee = new Employee(store, new Vault(store), {
    run: async () => {
      runs++;
      employee.update((s) => (s.enabled = false));
    },
    cancel: () => {},
    isRunning: () => false,
    send: async () => {},
    emit: () => {},
    config: () => ({ scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] }, model: "p/m" }),
    presence: async () => ({
      available: true,
      locked,
      idleMs: 10000000,
      source: "fixture",
    }),
  });
  employee.closed = true;
  employee.lastActivity = 0;
  await employee.execute("", {
    action: "add",
    kind: "todo",
    text: "computer work",
    profile: "lightweight",
  });
  employee.update((s) => {
    s.tasks[0].side = "computer";
    s.enabled = true;
    s.workStart = s.workEnd = "00:00";
  });
  employee.closed = false;
  try {
    await employee.tick();
    assert.equal(employee.state().tasks[0].status, "queued");
    assert.equal(runs, 0);
    locked = false;
    await employee.tick();
    for (let i = 0; i < 50 && employee.busy.size; i++) await sleep(10);
    assert.equal(runs, 1);
    assert.equal(employee.state().tasks.length, 1);
    assert(employee.state().tasks[0].computerSession);
  } finally {
    employee.close();
    store.close();
  }
});
test("new physical user activity yields active computer work while preserving its session", async () => {
  const store = new Store(":memory:");
  let cancelled = "";
  const employee = new Employee(store, new Vault(store), {
    run: async () => {},
    cancel: (s) => (cancelled = s),
    isRunning: () => true,
    send: async () => {},
    emit: () => {},
    config: () => ({}),
    presence: async () => ({
      available: true,
      locked: false,
      idleMs: 0,
      sampledAt: Date.now(),
      source: "fixture",
    }),
  });
  employee.closed = true;
  await employee.execute("", { action: "add", kind: "todo", text: "work" });
  employee.update((s) => {
    const t = s.tasks[0];
    t.status = "running";
    t.side = "computer";
    t.computerSession = "same-computer";
  });
  employee.nativePresence = {
    available: true,
    locked: false,
    idleMs: 10000,
    sampledAt: Date.now(),
    source: "fixture",
  };
  employee.closed = false;
  const stop = employee.monitorComputer(
    employee.state().tasks[0].id,
    "same-computer",
  );
  try {
    for (let i = 0; i < 100 && !cancelled; i++) await sleep(30);
    assert.equal(cancelled, "same-computer");
    assert.equal(employee.state().tasks[0].computerSession, "same-computer");
    assert.equal(employee.state().tasks[0].status, "queued");
    assert(employee.state().desktopAskAfter > Date.now());
  } finally {
    stop();
    employee.close();
    store.close();
  }
});
test(
  "real host OS presence read is calibrated without changing input or lock state",
  { timeout: 12000, skip: process.env.VEGA_TEST_OS_PRESENCE !== "1" },
  async () => {
    const presence = await systemPresence();
    assert.equal(presence.available, true, JSON.stringify(presence));
    assert.equal(typeof presence.locked, "boolean");
    assert(presence.idleMs >= 0);
    if (process.platform === "win32") assert.equal(presence.source, "win32");
  },
);
