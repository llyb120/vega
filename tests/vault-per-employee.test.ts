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
const engineFor = (store: Store) => {
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  return engine;
};

test("the former global vault is copied once to every current employee, temporary entries only to their task's employee", async () => {
  const store = new Store(":memory:");
  const seed = new Employee(store, new Vault(store), runtime);
  seed.closed = true;
  const a = seed.for(seed.create({ name: "A" }, "alice").id), b = seed.for(seed.create({ name: "B" }, "bob").id);
  const job = (await a.execute("", { action: "add", kind: "todo", text: "work" })).value.id;
  // Entries as the pre-migration global book stored them.
  const global = new Vault(store);
  const shared = global.save({ name: "service", condition: "authorized", content: "global-secret", share: true });
  store.save("vault", "temp", { ...store.object<any>("vault", shared.id), id: "temp", name: "received", share: false, tempFor: job, createdAt: Date.now() });
  store.save("vault", "orphan", { ...store.object<any>("vault", shared.id), id: "orphan", tempFor: "gone-task", createdAt: Date.now() });
  const engine = engineFor(store);
  try {
    assert.deepEqual(store.objects("vault"), [], "the global book is deleted after the copy");
    assert.equal(store.get("vault:migrated", false), true);
    for (const id of ["default", a.employeeId, b.employeeId]) {
      const own = engine.employee.for(id).vault;
      assert.equal(own.kind, vaultKind(id));
      assert.equal(own.get(shared.id, "migration check").content, "global-secret", "same key and encryption, so the copy stays readable");
      assert.equal(own.list().find((entry) => entry.id === shared.id)?.share, true);
    }
    assert.deepEqual(engine.employee.for(a.employeeId).vault.list().map((entry) => entry.id).sort(), [shared.id, "temp"].sort());
    assert.equal(engine.employee.for(a.employeeId).vault.get("temp", "check", job).content, "global-secret");
    assert(!engine.employee.for(b.employeeId).vault.list().some((entry) => entry.id === "temp"));
    assert(!engine.employee.all().some((employee) => employee.vault.list().some((entry) => entry.id === "orphan")), "temporary entries without a live task are dropped");
    await engine.close();
    // A later global write (none exists in the code any more) is not migrated again.
    store.save("vault", "late", store.object<any>(vaultKind("default"), shared.id));
    await engineFor(store).close();
    assert.equal(store.object("vault", "late") !== undefined, true);
    assert.equal(store.object(vaultKind(a.employeeId), "late"), undefined);
  } finally { store.close(); }
});

test("an employee's task and computer sessions only resolve that employee's entries", async () => {
  const store = new Store(":memory:"), engine = engineFor(store);
  store.put("config", { scenes: { lightweight: ["fixture/light"], coding: ["fixture/light"], computer: ["fixture/light"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  engine.catalog.resolve = async () => ({ selection: "fixture/light" } as any);
  const a = engine.employee.for(engine.employee.create({ name: "A" }, "alice").id), b = engine.employee.for(engine.employee.create({ name: "B" }, "bob").id);
  try {
    const mine = a.vault.save({ name: "A account", condition: "A system", content: "a-secret" });
    const theirs = b.vault.save({ name: "B account", condition: "B system", content: "b-secret" });
    const job = (await a.execute("", { action: "add", kind: "todo", text: "log in to A system" })).value.id;
    a.update((state) => { state.tasks[0].status = "running"; });
    let verified = 0;
    engine.providers.chat = async () => { verified++; return { role: "assistant", calls: [{ id: "check", name: "check_credential_use", arguments: { allowed: true, reason: "符合" } }] }; };
    for (const scene of ["coding", "computer"] as const) {
      const session = store.newSession({ cwd: ".", scene, employeeId: a.employeeId, taskId: job });
      a.busy.set(job, { session: session.id, computer: scene === "computer" });
      const tools = new Tools(engine, session, engine.config(session), new AbortController().signal, () => {});
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
    assert.equal(store.object<any>(b.vault.kind, theirs.id).usedAt, undefined);
  } finally { a.busy.clear(); await engine.close(); store.close(); }
});
