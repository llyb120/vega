import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { employeeCapabilities, migrateEmployeeCapabilities } from "../server/core/employee-capabilities";
import { loadSkills } from "../server/core/prompt";
import { skillKind } from "../server/core/skills";

const alice = { id: "alice", role: "operator" }, bob = { id: "bob", role: "operator" }, admin = { id: "admin", role: "admin" }, viewer = { id: "reader", role: "viewer" };
async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const a = await engine.employee.for((await engine.employee.create({ name: "A" }, alice.id, "team")).id);
  const b = await engine.employee.for((await engine.employee.create({ name: "B" }, bob.id, "team")).id);
  return { store, engine, a, b };
}
function bundle(text: string, name = "same-name") {
  return { filename: "skill.zip", content: Buffer.from(zipSync({ "SKILL.md": strToU8(`---\nname: ${name}\ndescription: private-${text}\n---\n${text}`), "references/guide.txt": strToU8("private-reference-" + text) })).toString("base64") };
}
const denied = (error: any) => error.statusCode === 403;

test("only the creator can edit or read details, including when the other user is an administrator", async () => {
  const { store, engine, a } = await fixture();
  try {
    await employeeCapabilities(a, alice, "PUT", ["mcp"], { mcp: { shared: { url: "https://private.example/mcp", headers: { Authorization: "private-token" } } } });
    await employeeCapabilities(a, alice, "POST", ["skills", "upload"], bundle("private-instructions"));
    for (const user of [bob, admin, viewer]) {
      const result = await employeeCapabilities(a, user, "GET", ["capabilities"]);
      assert.deepEqual(result, { canEdit: false, skills: [{ name: "same-name" }], mcp: [{ name: "shared" }] });
      for (const [method, path, body] of [
        ["GET", ["skills", "same-name"], {}],
        ["DELETE", ["skills", "same-name"], {}],
        ["POST", ["skills", "upload"], bundle("forged")],
        ["PUT", ["mcp"], { mcp: {} }],
      ] as const) await assert.rejects(employeeCapabilities(a, user, method, [...path], body), denied);
    }
    const owner: any = await employeeCapabilities(a, alice, "GET", ["capabilities"]);
    assert.equal(owner.canEdit, true);
    assert.equal(owner.mcp[0].config.url, "https://private.example/mcp");
    assert.equal(owner.mcp[0].config.headers.Authorization, "__stored_secret__");
    assert.match((await employeeCapabilities(a, alice, "GET", ["skills", "same-name"]) as any).content, /private-instructions/);
    await employeeCapabilities(a, alice, "PUT", ["mcp"], { mcp: { shared: owner.mcp[0].config } });
    assert.equal((await store.object<any>("employee-capabilities", a.employeeId)).mcp.shared.headers.Authorization, "private-token");
    await assert.rejects(employeeCapabilities(a, { ...alice, role: "viewer" }, "PUT", ["mcp"], { mcp: {} }), denied);
    assert(!JSON.stringify(await a.state()).includes("private-instructions"), "employee state and its normal API response contain no capability details");
  } finally { await engine.close(); await store.close(); }
});

test("same-named skills and MCP configurations are independent and execution never inherits other bots or global discovery", async () => {
  const { store, engine, a, b } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "vega-owned-skills-"));
  const previous = process.env.VEGA_SKILL_CACHE;
  process.env.VEGA_SKILL_CACHE = directory;
  try {
    for (const [employee, user, content] of [[a, alice, "alpha"], [b, bob, "beta"]] as const) {
      await employeeCapabilities(employee, user, "POST", ["skills", "upload"], bundle(content));
      await employeeCapabilities(employee, user, "PUT", ["mcp"], { mcp: { service: { url: `https://${content}.example/mcp` } } });
    }
    const sa = await store.newSession({ employeeId: a.employeeId, cwd: directory }), sb = await store.newSession({ employeeId: b.employeeId, cwd: directory });
    const ca = await engine.config(sa), cb = await engine.config(sb);
    assert.equal(ca.mcp!.service.url, "https://alpha.example/mcp");
    assert.equal(cb.mcp!.service.url, "https://beta.example/mcp");
    const installedA = await loadSkills(ca, store, directory), installedB = await loadSkills(cb, store, directory);
    assert.equal(installedA.length, 1); assert.equal(installedB.length, 1);
    assert.notEqual(installedA[0].resourceRoot, installedB[0].resourceRoot);
    assert.equal(installedA[0].path, "sqlite:skill/same-name");
    const toolsA = await Tools.create(engine, sa, ca, new AbortController().signal, () => {});
    const read = await toolsA.read({ path: "sqlite:skill/same-name" });
    assert.match(JSON.parse(read.secret!).content, /alpha/);
    assert(!JSON.stringify(read.value).includes("alpha"), "shared tool records must not reveal private skill content");
    await assert.rejects(toolsA.read({ path: `sqlite:skill/${b.employeeId}:same-name` }), /Skill not found/);
    const oldClient = await engine.mcpFor(sa, ca), otherClient = await engine.mcpFor(sb, cb);
    await employeeCapabilities(a, alice, "PUT", ["mcp"], { mcp: {} });
    assert.notEqual(await engine.mcpFor(sa, ca), oldClient, "runtime refreshes changed MCP settings even with an older turn config");
    assert.equal(await engine.mcpFor(sb, cb), otherClient);
    await employeeCapabilities(a, alice, "POST", ["skills", "upload"], { ...bundle("updated"), replace: true });
    assert.match((await store.object<any>(skillKind(a.employeeId), "same-name")).content, /updated/);
    assert.match((await store.object<any>(skillKind(b.employeeId), "same-name")).content, /beta/);
    await employeeCapabilities(a, alice, "DELETE", ["skills", "same-name"]);
    assert.equal((await loadSkills(await engine.config(sa), store, directory)).length, 0);
    assert.equal((await loadSkills(await engine.config(sb), store, directory)).length, 1);
    const empty = await engine.employee.for((await engine.employee.create({ name: "Empty" }, alice.id)).id);
    const fresh = await engine.config(await store.newSession({ employeeId: empty.employeeId, cwd: directory }));
    assert.deepEqual(fresh.mcp, {}); assert.deepEqual(await loadSkills(fresh, store, directory), []);
    await assert.rejects(engine.saveConfig({ model: "", provider: {}, mcp: { shared: { command: "node" } } }), /各牛马/);
  } finally {
    await engine.close(); await store.close();
    if (previous === undefined) delete process.env.VEGA_SKILL_CACHE; else process.env.VEGA_SKILL_CACHE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy global configuration migrates only to the default employee and never reappears after deletion", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.put("config", { model: "", provider: {}, mcp: { legacy: { command: "node" } } });
    await store.save("skill", "legacy", { id: "legacy", name: "legacy", content: "old instructions" });
    await migrateEmployeeCapabilities(store);
    assert.equal((await store.object<any>("employee-capabilities", "default")).mcp.legacy.command, "node");
    assert.equal((await store.object<any>(skillKind("default"), "legacy")).content, "old instructions");
    assert.equal((await store.objects("skill")).length, 0);
    assert.equal((await store.get<any>("config", {})).mcp, undefined);
    await store.remove("employee-capabilities", "default");
    await store.remove(skillKind("default"), "legacy");
    await migrateEmployeeCapabilities(store);
    assert.equal(await store.object("employee-capabilities", "default"), undefined);
  } finally { await store.close(); }
});

test("built-in legacy employee binds its configuration to the original administrator, not every administrator", async () => {
  const { store, engine } = await fixture();
  try {
    const insert = "INSERT INTO web_users(id,username,password,role,createdAt) VALUES(?,?,?,?,?)";
    await store.run(insert, "first-admin", "first-admin", "unused", "admin", 1);
    await store.run(insert, "second-admin", "second-admin", "unused", "admin", 2);
    const root = engine.employee;
    assert.equal((await root.state()).ownerId, "first-admin");
    await employeeCapabilities(root, { id: "first-admin", role: "admin" }, "PUT", ["mcp"], { mcp: { service: { command: "node" } } });
    await assert.rejects(employeeCapabilities(root, { id: "second-admin", role: "admin" }, "PUT", ["mcp"], { mcp: {} }), denied);
    const personal = await engine.employee.for((await engine.employee.create({ name: "Personal" }, alice.id)).id);
    await assert.rejects(employeeCapabilities(personal, bob, "GET", ["capabilities"]), (error: any) => error.statusCode === 404);
  } finally { await engine.close(); await store.close(); }
});

test("invalid MCP updates leave all existing settings unchanged", async () => {
  const { store, engine, a } = await fixture();
  try {
    await employeeCapabilities(a, alice, "PUT", ["mcp"], { mcp: { service: { command: "node", args: ["server.mjs"] } } });
    const before = await store.object("employee-capabilities", a.employeeId);
    for (const mcp of [[], { broken: { url: "file:///private" } }, { broken: { command: "node", args: "invalid" } }, JSON.parse('{"__proto__":{"command":"node"}}')]) {
      await assert.rejects(employeeCapabilities(a, alice, "PUT", ["mcp"], { mcp }));
      assert.deepEqual(await store.object("employee-capabilities", a.employeeId), before);
    }
  } finally { await engine.close(); await store.close(); }
});

test("deleting one employee removes only its own capability configuration", async () => {
  const { store, engine, a, b } = await fixture();
  try {
    for (const [employee, user] of [[a, alice], [b, bob]] as const) {
      await employeeCapabilities(employee, user, "PUT", ["mcp"], { mcp: { service: { command: "node" } } });
      await employeeCapabilities(employee, user, "POST", ["skills", "upload"], bundle("owned"));
    }
    a.deleting = true; await a.forget();
    assert.equal(await store.object("employee-capabilities", a.employeeId), undefined);
    assert.equal((await store.objects(skillKind(a.employeeId))).length, 0);
    assert.equal((await store.objects(skillKind(b.employeeId))).length, 1);
    assert(await store.object("employee-capabilities", b.employeeId));
  } finally { await engine.close(); await store.close(); }
});
