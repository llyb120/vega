import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { encrypt, migrateVaultOwnership, vaultKind } from "../server/core/vault";
import { Employee, type EmployeeRuntime } from "../server/core/employee";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { vaultCall } from "./public-call";

const runtime: EmployeeRuntime = { run: async () => {}, cancel() {}, isRunning: () => false, emit() {}, config: () => ({ model: "", provider: {} }), isolated: true };
const engineFor = async (store: Store) => {
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  return engine;
};

test("an employee's task only resolves its owner's entries that apply to it", async () => {
  const store = await Store.open(":memory:"), engine = await engineFor(store);
  await store.put("config", { scenes: { lightweight: ["fixture/light"], coding: ["fixture/light"], computer: ["fixture/light"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  engine.catalog.resolve = async () => ({ selection: "fixture/light" } as any);
  const a = await engine.employee.for((await engine.employee.create({ name: "A" }, "alice")).id);
  const sibling = await engine.employee.for((await engine.employee.create({ name: "A2" }, "alice")).id);
  const b = await engine.employee.for((await engine.employee.create({ name: "B" }, "bob")).id);
  try {
    const mine = await a.vault.save({ name: "A account", condition: "A system", content: "a-secret" });
    const theirs = await b.vault.save({ name: "B account", condition: "B system", content: "b-secret" });
    // One book per account: an entry without a scope serves every employee of its owner.
    const shared = await engine.vault.book("alice").save({ name: "Shared account", condition: "shared system", content: "shared-secret" });
    const listed = async (employee: Employee) => (await employee.execute("", { action: "vault_list" })).value.entries.map((entry: any) => entry.id).sort();
    assert.deepEqual(await listed(a), [mine.id, shared.id].sort(), "an employee sees its own scoped entries and the shared ones");
    assert.deepEqual(await listed(sibling), [shared.id], "a sibling does not inherit an entry scoped to another employee");
    assert.deepEqual(await listed(b), [theirs.id]);
    const account = await engine.vault.book("alice").list();
    assert.deepEqual(Object.fromEntries(account.map((entry: any) => [entry.id, entry.employees])), { [mine.id]: [a.employeeId], [shared.id]: undefined }, "the account book keeps the scope it was saved with");
    assert(!JSON.stringify(account).includes("secret"), "the account listing never returns credentials");

    const job = (await a.execute("", { action: "add", kind: "todo", text: "log in to A system" })).value.id;
    await a.update((state) => { state.tasks[0].status = "running"; });
    let verified = 0;
    engine.providers.chat = async () => { verified++; return { role: "assistant", calls: [{ id: "check", name: "check_credential_use", arguments: { allowed: true, reason: "符合" } }] }; };
    for (const scene of ["coding", "computer"] as const) {
      const session = await store.newSession({ cwd: ".", scene, employeeId: a.employeeId, taskId: job });
      a.busy.set(job, { session: session.id, computer: scene === "computer" });
      const tools = await Tools.create(engine, session, await engine.config(session), new AbortController().signal, () => {});
      const observable = await tools.execute({ id: "list", ...vaultCall({ action: "list" }) }, { supportsImages: true } as any);
      assert.deepEqual(observable.value.entries.map((entry: any) => entry.id).sort(), [mine.id, shared.id].sort());
      assert(!JSON.stringify(observable.value).includes("b-secret") && !JSON.stringify(observable.value).includes("B account"));
      const before = verified;
      await assert.rejects(tools.execute({ id: "theirs", ...vaultCall({ action: "get", id: theirs.id, text: "login" }) }, { supportsImages: true } as any), /Vault entry not found/);
      await assert.rejects(tools.execute({ id: "scoped-elsewhere", ...vaultCall({ action: "get", id: theirs.id, text: "login" }) }, { supportsImages: true } as any), /Vault entry not found/);
      assert.equal(verified, before, "an entry outside this employee's scope is rejected before any verification");
      const got = await tools.execute({ id: "mine", ...vaultCall({ action: "get", id: mine.id, text: "login" }) }, { supportsImages: true } as any);
      assert.equal(JSON.parse(got.secret!).content, "a-secret");
      const all = await tools.execute({ id: "shared", ...vaultCall({ action: "get", id: shared.id, text: "login" }) }, { supportsImages: true } as any);
      assert.equal(JSON.parse(all.secret!).content, "shared-secret");
      a.busy.delete(job);
    }
    assert.equal((await store.object<any>(vaultKind("bob"), theirs.id)).usedAt, undefined);
    assert.equal((await store.object<any>(vaultKind("alice"), mine.id))?.usedFor, "login", "the account book records where an entry was used");
  } finally { a.busy.clear(); await engine.close(); await store.close(); }
});

test("deleting an employee drops its scope but keeps entries that other employees still need", async () => {
  const store = await Store.open(":memory:"), engine = await engineFor(store);
  const a = await engine.employee.for((await engine.employee.create({ name: "A" }, "alice")).id);
  const b = await engine.employee.for((await engine.employee.create({ name: "B" }, "alice")).id);
  try {
    const alone = await a.vault.save({ name: "only A", condition: "A only", content: "a-only" });
    const both = await engine.vault.book("alice").save({ name: "both", condition: "both", content: "both-secret", employees: [a.employeeId, b.employeeId] });
    await engine.removeEmployee(a.employeeId);
    const kept = await engine.vault.book("alice").list();
    assert.deepEqual(kept.map((entry: any) => [entry.id, entry.employees]), [[both.id, [b.employeeId]]], "the entry only A used is gone; the shared one narrows to B");
    assert(!kept.some((entry: any) => entry.id === alone.id));
    assert.deepEqual((await b.vault.list()).map((entry: any) => entry.id), [both.id], "deleting A never widens an entry to every employee");
  } finally { await engine.close(); await store.close(); }
});

test("legacy per-employee books fold into the account book without widening", async () => {
  const store = await Store.open(":memory:");
  const engine = await engineFor(store);
  const a = await engine.employee.for((await engine.employee.create({ name: "A" }, "alice")).id);
  const b = await engine.employee.for((await engine.employee.create({ name: "B" }, "alice")).id);
  try {
    // What an older server left behind: a book per employee, encrypted with the shared key.
    const secret = encrypt(await engine.vault.key(), "vault", "old-secret");
    await store.save("vault:" + a.employeeId, "v-old", { id: "v-old", type: "login", name: "old A", condition: "c", secret, createdAt: 1 });
    await store.put("vault:owners", false);
    await migrateVaultOwnership(store);
    assert.deepEqual(await store.objects("vault:" + a.employeeId), [], "the legacy kind is migrated away, not copied");
    const migrated = await engine.vault.book("alice").list();
    assert.deepEqual(migrated.map((entry: any) => [entry.id, entry.name, entry.employees]), [["v-old", "old A", [a.employeeId]]], "an old entry stays scoped to the employee that had it");
    assert.deepEqual((await a.vault.list()).map((entry: any) => entry.id), ["v-old"]);
    assert.deepEqual(await b.vault.list(), [], "its sibling never sees the migrated entry");
    assert.equal((await a.vault.get("v-old", "legacy login")).content, "old-secret");
    await store.put("vault:owners", false);
    await migrateVaultOwnership(store);
    assert.equal((await engine.vault.book("alice").list()).length, 1, "running it again keeps already migrated books");
  } finally { await engine.close(); await store.close(); }
});
