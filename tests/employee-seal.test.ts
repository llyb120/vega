import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { employeeCall } from "./public-call";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  const employee = await engine.employee.for((await engine.employee.create({ name: "E" }, "admin", "personal")).id);
  const created = await employee.execute("", { action: "add", kind: "todo", text: "work" });
  return { store, engine, employee, id: created.value.id as string };
}

test("sealing is manual only and a sealed task can never be revived", async () => {
  const { store, engine, employee, id } = await fixture();
  try {
    await employee.update((s) => Object.assign(s.tasks[0], { status: "failed", result: "boom" }));
    await assert.rejects(employee.control({ action: "seal", id }), /手动/);
    await assert.rejects(employee.control({ action: "seal", id, manual: true }, { token: "remote", name: "r" }), /assigning member|手动/);
    await employee.control({ action: "seal", id, manual: true });
    const sealed = employee.task(await employee.state(), id);
    assert.equal(sealed.status, "sealed");
    assert.equal(sealed.sealedFrom, "failed");
    for (const a of [{ action: "resume" }, { action: "resume", text: "再试一次" }, { action: "answer", text: "x" }, { action: "redispatch", confirmed: true }, { action: "approve", approved: true }])
      await assert.rejects(employee.control({ ...a, id }), /封存/);
    assert.equal((await employee.state()).tasks.length, 1);
    await assert.rejects(employee.execute(id, { action: "update", id, nextCheckInMinutes: 5 }));
    // The model's chat tool has no way to seal or revive it either.
    const chat = await employee.chat("admin");
    const tools = await Tools.create(engine, chat, await engine.config(), new AbortController().signal, () => {});
    const resumed = await tools.execute({ id: "c", ...employeeCall({ action: "resume", id }) }, {} as any).catch((e) => ({ error: e }));
    assert.ok((resumed as any).error || (resumed as any).value?.error || JSON.stringify(resumed).includes("封存"));
    assert.equal(employee.task(await employee.state(), id).status, "sealed");
    await employee.control({ action: "remove", id });
    assert.equal((await employee.state()).tasks.length, 0);
  } finally { await engine.close(); await store.close(); }
});

test("sealing a waiting task clears its pending question and schedule", async () => {
  const { store, engine, employee, id } = await fixture();
  try {
    await employee.update((s) => Object.assign(s.tasks[0], { status: "waiting", waiting: "要哪个？", nextCheckAt: Date.now() + 1000 }));
    await employee.control({ action: "seal", id, manual: true });
    const t = employee.task(await employee.state(), id);
    assert.deepEqual([t.status, t.waiting, t.nextCheckAt, t.sealedFrom], ["sealed", "", 0, "waiting"]);
    assert.ok(t.finishedAt > 0);
  } finally { await engine.close(); await store.close(); }
});
