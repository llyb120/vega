import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Vault, vaultKind } from "../server/core/vault";
import { Employee, type EmployeeRuntime } from "../server/core/employee";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { vaultCall } from "./public-call";

const runtime: EmployeeRuntime = { run: async () => {}, cancel() {}, isRunning: () => false, emit() {}, send: async () => ({}), config: () => ({ model: "", provider: {} }), isolated: true };
const engineFor = async (store: Store) => {
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  return engine;
};

test("an employee's task and computer sessions only resolve that employee's entries", async () => {
  const store = await Store.open(":memory:"), engine = await engineFor(store);
  await store.put("config", { scenes: { lightweight: ["fixture/light"], coding: ["fixture/light"], computer: ["fixture/light"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  engine.catalog.resolve = async () => ({ selection: "fixture/light" } as any);
  const a = await engine.employee.for((await engine.employee.create({ name: "A" }, "alice")).id), b = await engine.employee.for((await engine.employee.create({ name: "B" }, "bob")).id);
  try {
    const mine = await a.vault.save({ name: "A account", condition: "A system", content: "a-secret" });
    const theirs = await b.vault.save({ name: "B account", condition: "B system", content: "b-secret" });
    const job = (await a.execute("", { action: "add", kind: "todo", text: "log in to A system" })).value.id;
    await a.update((state) => { state.tasks[0].status = "running"; });
    let verified = 0;
    engine.providers.chat = async () => { verified++; return { role: "assistant", calls: [{ id: "check", name: "check_credential_use", arguments: { allowed: true, reason: "符合" } }] }; };
    for (const scene of ["coding", "computer"] as const) {
      const session = await store.newSession({ cwd: ".", scene, employeeId: a.employeeId, taskId: job });
      a.busy.set(job, { session: session.id, computer: scene === "computer" });
      const tools = await Tools.create(engine, session, await engine.config(session), new AbortController().signal, () => {});
      const listed = await tools.execute({ id: "list", ...vaultCall({ action: "list" }) }, { supportsImages: true } as any);
      assert.deepEqual(listed.value.entries.map((entry: any) => entry.id), [mine.id]);
      assert(!JSON.stringify(listed.value).includes("b-secret") && !JSON.stringify(listed.value).includes("B account"));
      const before = verified;
      await assert.rejects(tools.execute({ id: "theirs", ...vaultCall({ action: "get", id: theirs.id, text: "login" }) }, { supportsImages: true } as any), /Vault entry not found/);
      assert.equal(verified, before, "another employee's entry is rejected before any verification");
      const got = await tools.execute({ id: "mine", ...vaultCall({ action: "get", id: mine.id, text: "login" }) }, { supportsImages: true } as any);
      assert.equal(JSON.parse(got.secret!).content, "a-secret");
      a.busy.delete(job);
    }
    assert.equal((await store.object<any>(b.vault.kind, theirs.id)).usedAt, undefined);
  } finally { a.busy.clear(); await engine.close(); await store.close(); }
});
