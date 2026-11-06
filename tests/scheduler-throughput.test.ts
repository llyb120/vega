import { test } from "node:test";
import assert from "node:assert/strict";
import { schedulerLimits, DEFAULT_GLOBAL_SLOTS, DEFAULT_PER_EMPLOYEE_SLOTS } from "../server/core/config";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { sleep } from "../server/core/util";

test("schedulerLimits defaults and clamps", () => {
  assert.deepEqual(schedulerLimits(undefined), { global: DEFAULT_GLOBAL_SLOTS, perEmployee: DEFAULT_PER_EMPLOYEE_SLOTS });
  assert.deepEqual(schedulerLimits({ scheduler: { globalSlots: 8, perEmployeeSlots: 2 } }), { global: 8, perEmployee: 2 });
  assert.deepEqual(schedulerLimits({ scheduler: { globalSlots: 0, perEmployeeSlots: 99 } }), { global: DEFAULT_GLOBAL_SLOTS, perEmployee: DEFAULT_PER_EMPLOYEE_SLOTS });
});

test("saveConfig accepts scheduler slot settings", async () => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  try {
    await store.put("config", { model: "p/m", scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
    const saved = await engine.saveConfig({
      model: "p/m",
      provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } },
      scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
      scheduler: { globalSlots: 6, perEmployeeSlots: 2 },
    } as any);
    assert.deepEqual(saved.scheduler, { globalSlots: 6, perEmployeeSlots: 2 });
    await assert.rejects(() => engine.saveConfig({
      model: "p/m",
      provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } },
      scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
      scheduler: { globalSlots: 0 },
    } as any), /scheduler\.globalSlots/);
  } finally { await engine.close(); await store.close(); }
});

test("per-employee slot cap leaves overflow queued while global still has room", { timeout: 10000 }, async () => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", {
    model: "p/m",
    scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
    provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } },
    scheduler: { globalSlots: 8, perEmployeeSlots: 1 },
  });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Cap employee" }, "owner")).id);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  engine.providers.chat = async (_m, _s, _messages, _d, signal) => {
    await Promise.race([gate, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    return { role: "assistant", text: "held" } as any;
  };
  try {
    const a = (await employee.execute("", { action: "add", kind: "todo", text: "first" })).value.id;
    const b = (await employee.execute("", { action: "add", kind: "todo", text: "second" })).value.id;
    engine.employee.closed = false;
    await engine.employee.drain();
    for (let i = 0; i < 200 && employee.busy.size < 1; i++) await sleep(5);
    assert.equal(employee.busy.size, 1);
    assert.equal(employee.task(await employee.state(), a).status, "running");
    assert.equal(employee.task(await employee.state(), b).status, "queued");
  } finally {
    engine.employee.closed = true;
    release();
    await engine.close();
    await store.close();
  }
});

test("schedule marks the employee for priority tick before a full sweep", async () => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/m", scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Priority employee" }, "owner")).id);
  try {
    employee.schedule();
    assert(engine.employee.priority.has(employee.employeeId), "member schedule should prefer itself on the root");
  } finally { await engine.close(); await store.close(); }
});
