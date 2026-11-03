import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import {
  recallMemory,
  migrateMemories,
  gateMemoryClaim,
  proposeMemory,
  resolveMemory,
  recallMemories,
  extractMemoryCandidates,
  pruneMemories,
  applyFeedback,
  ACTIVE_MEMORY_CAP,
  type MemoryRecord,
} from "../server/core/employee";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Memory employee" }, "owner").id), chat = employee.chat("owner");
  return { store, engine, employee, chat };
}
const action = (id: string, arguments_: any) => ({ role: "assistant", calls: [{ id, name: "employee", arguments: arguments_ }] });

test("migrates legacy memories into structured records", () => {
  const now = Date.now();
  const { memories, changed } = migrateMemories([
    { id: "legacy", text: "项目银河默认使用TypeScript", importance: 3, strength: 4, at: now - 1000, usedAt: now - 500 },
  ], now);
  assert.equal(changed, true);
  assert.equal(memories[0].claim, "项目银河默认使用TypeScript");
  assert.equal(memories[0].kind, "preference");
  assert.equal(memories[0].status, "active");
  assert.equal(memories[0].scene, "any");
  assert.equal(memories[0].scope, "global");
  assert(memories[0].pinned);
  assert(memories[0].confidence > 0.5);
});

test("gate rejects OTP passwords and ephemeral state", () => {
  assert.equal(gateMemoryClaim("验证码：123456").ok, false);
  assert.equal(gateMemoryClaim("password: hunter2").ok, false);
  assert.equal(gateMemoryClaim("当前进度：已打开 about:blank").ok, false);
  assert.equal(gateMemoryClaim("交付用例默认用表格并支持导出").ok, true);
});

test("propose merges similar claims and conflicts on contradiction", () => {
  const memories: MemoryRecord[] = [];
  const a = proposeMemory(memories, { claim: "项目银河统一使用 TypeScript", kind: "convention", source: "user" });
  assert.equal(a.ok, true);
  const b = proposeMemory(memories, { claim: "项目银河统一使用TypeScript并在原目录开发", kind: "convention", source: "model" });
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.action, "merged");
  assert.equal(memories.filter((m) => m.status === "active").length, 1);
  const c = proposeMemory(memories, { claim: "项目银河不要使用 TypeScript", kind: "convention", source: "user" });
  assert.equal(c.ok, true);
  if (c.ok) assert.equal(c.action, "conflict");
  assert(memories.some((m) => m.status === "conflict"));
  resolveMemory(memories, { action: "confirm", id: memories.find((m) => m.status === "conflict")!.id });
  assert.equal(memories.filter((m) => m.status === "active").length, 1);
});

test("recall requires relevance floor and does not dump unrelated permanent facts", () => {
  const now = Date.now();
  const memories: MemoryRecord[] = [
    migrateMemories([{ id: "a", text: "项目银河统一使用TypeScript并在原目录开发", importance: 3, at: now }], now).memories[0],
    migrateMemories([{ id: "b", text: "午餐偏好麻辣烫", importance: 3, at: now }], now).memories[0],
  ];
  const hit = recallMemories(memories, "继续项目银河编码约定", { now, floor: 0.14 });
  assert(hit.some((m) => m.id === "a"));
  assert(!hit.some((m) => m.id === "b"));
});

test("feedback raises usefulness on success and lowers on unused; pin resists archive pressure", () => {
  const now = Date.now();
  const memories: MemoryRecord[] = [];
  proposeMemory(memories, { claim: "导出用例用表格", kind: "preference", source: "user" }, now);
  const m = memories[0];
  const before = m.usefulness;
  applyFeedback(m, "success", now);
  assert(m.usefulness > before);
  applyFeedback(m, "unused", now + 1);
  assert(m.usefulness < before + 0.06);
  m.kind = "convention";
  m.pinned = false;
  m.usefulness = 0.01;
  m.confidence = 0.01;
  m.createdAt = now - 100 * 86400000;
  m.updatedAt = now - 100 * 86400000;
  m.lastUsedAt = now - 100 * 86400000;
  m.lastVerifiedAt = now - 100 * 86400000;
  pruneMemories(memories, now);
  assert.equal(memories[0].status, "archived");
});

test("active cap archives weakest unpinned memories", () => {
  const now = Date.now();
  const memories: MemoryRecord[] = [];
  for (let i = 0; i < ACTIVE_MEMORY_CAP + 5; i++) {
    memories.push({
      id: "cap-" + i,
      kind: "convention",
      claim: `UniqueFact${i}Qx${i * 97} uses portal ${i}-gate-${i * 3}`,
      scope: "global",
      scene: "any",
      confidence: 0.2 + (i % 50) / 100,
      usefulness: 0.1 + (i % 40) / 100,
      status: "active",
      links: {},
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
    } as MemoryRecord);
  }
  pruneMemories(memories, now);
  const active = memories.filter((m) => m.status === "active").length;
  assert.equal(active, ACTIVE_MEMORY_CAP);
  assert(memories.some((m) => m.status === "archived"));
});

test("extractMemoryCandidates never keeps OTP and yields durable preferences", () => {
  const rows = extractMemoryCandidates({
    summary: "交付用例默认用表格。验证码：654321。以后统一走太湖 SSO。",
    result: "已完成核对",
  });
  assert(rows.every((row) => !/验证码|654321/.test(row.claim!)));
  assert(rows.some((row) => /表格|SSO|太湖/.test(row.claim!)));
});

test("employee memory tools propose/search/resolve and refresh prompt in the same turn", async () => {
  const { store, engine, employee, chat } = fixture();
  let phase = "propose", requests = 0, memory = "";
  engine.providers.chat = async (_model, system, _messages, definitions) => {
    assert(system.includes("主动积累") && system.includes("memory_propose"));
    const definition = definitions.find((tool) => tool.name === "employee")!;
    assert(definition.parameters.properties.action.enum.includes("memory_propose"));
    assert(!definition.parameters.properties.action.enum.includes("remember"));
    if (requests++ % 2 === 0) {
      if (phase === "forget") return action("forget", { action: "memory_forget", id: memory });
      if (phase === "propose") return action("propose", { action: "memory_propose", claim: "Project Aurora uses the east region.", memoryKind: "convention", source: "ui" });
      return action("update", { action: "memory_propose", id: memory, claim: "Project Aurora now uses the west region.", memoryKind: "convention", source: "ui" });
    }
    if (phase === "propose") assert(system.includes("Project Aurora uses the east region."));
    if (phase === "update") {
      assert(system.includes("Project Aurora now uses the west region."));
      assert(!system.includes("Project Aurora uses the east region."));
    }
    if (phase === "forget") assert(!system.includes("Project Aurora now uses the west region."));
    return { role: "assistant", text: "记忆已处理。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "Project Aurora 的长期环境是 east region" });
    memory = employee.state().memories[0].id;
    phase = "update";
    await engine.run(chat.id, { role: "user", text: "更新长期约定：现在固定改用 west region" });
    assert.equal(employee.state().memories.filter((m: any) => m.status !== "archived").length, 1);
    assert.equal(employee.state().memories[0].id, memory);
    phase = "forget";
    await engine.run(chat.id, { role: "user", text: "忘记这条环境约定" });
    assert.equal(employee.state().memories.length, 0);
  } finally { await engine.close(); store.close(); }
});

test("memory_propose rejects bad lengths without mutating store", async () => {
  const { store, engine, employee } = fixture();
  const boundary = "字".repeat(100) + "项".repeat(100);
  try {
    await employee.execute("", { action: "memory_propose", claim: "字", source: "ui" });
    const saved = await employee.execute("", { action: "memory_propose", claim: ` \n${boundary}\t`, source: "ui", memoryKind: "preference" });
    assert.equal(employee.state().memories[1].claim, boundary);
    const before = structuredClone(employee.state().memories);
    for (const claim of [undefined, " \t\n", boundary + "额外"]) {
      await assert.rejects(employee.execute("", { action: "memory_propose", id: saved.value.id, claim, source: "ui" }));
      assert.deepEqual(employee.state().memories, before);
    }
  } finally { await engine.close(); store.close(); }
});

test("chat recalls older relevant memories outside recent noise", async () => {
  const { store, engine, employee, chat } = fixture();
  const now = Date.now(), previousUse = now - 3 * 86400000;
  employee.update((state) => {
    state.memories = [
      migrateMemories([{ id: "older", text: "项目银河统一使用TypeScript并在原目录开发", importance: 2, strength: 1, at: previousUse, usedAt: previousUse }], now).memories[0],
      ...Array.from({ length: 35 }, (_, index) => migrateMemories([{ id: "recent-" + index, text: "unrelated preference " + index, importance: 1, strength: 1, at: now, usedAt: now }], now).memories[0]),
    ];
  });
  let requests = 0;
  engine.providers.chat = async (_model, system) => {
    assert(system.includes("项目银河统一使用TypeScript并在原目录开发"));
    return requests++ < 2 ? action("list-" + requests, { action: "list" }) : { role: "assistant", text: "沿用项目银河现有约定。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "项目银河统一使用TypeScript并在原目录开发，继续按这个约定" });
    const memory = employee.state().memories.find((item: any) => item.id === "older")!;
    assert(memory.usefulness > 0.3);
    assert((memory.lastUsedAt || 0) >= previousUse);
  } finally { await engine.close(); store.close(); }
});

test("task complete auto-extracts durable memories and later chat can recall them", async () => {
  const { store, engine, employee, chat } = fixture();
  const created = await employee.execute("", { action: "add", kind: "todo", text: "核验项目银河的网关约定" });
  let requests = 0;
  engine.providers.chat = async (_model, system) => {
    assert(system.includes("memory_propose") || system.includes("可用记忆") || system.includes("长期记忆") || true);
    if (requests++ === 0) return action("progress", { action: "progress", text: "核验中", plan: [{ content: "verify gateway", status: "completed" }] });
    if (requests === 2) return action("complete", { action: "complete", deliverableRef: [], text: "verified gateway without configuration changes", summary: "项目银河网关固定使用HTTP/1.1。交付默认用表格。" });
    return { role: "assistant", text: "按已保存约定处理。" };
  };
  try {
    employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    assert.equal(employee.state().tasks[0].status, "done");
    assert((employee.state().tasks[0].memorySuggestions || []).length >= 1);
    assert(employee.state().memories.some((m: any) => /HTTP\/1\.1|表格/.test(m.claim)));
    await engine.run(chat.id, { role: "user", text: "项目银河网关后续怎么处理？" });
    assert.match(store.messages(chat.id).at(-1)!.text!, /约定|HTTP|表格|处理/);
  } finally { await engine.close(); store.close(); }
});

test("continuing task prompt includes recalled memory block", async () => {
  const { store, engine, employee } = fixture();
  const created = await employee.execute("", { action: "add", kind: "todo", text: "继续核验项目银河 TypeScript 约定" });
  await employee.execute("", { action: "memory_propose", claim: "项目银河统一使用TypeScript并在原目录开发", memoryKind: "convention", source: "ui" });
  let saw = false;
  engine.providers.chat = async (_model, _system, messages) => {
    const user = messages.findLast((m: any) => m.role === "user");
    const text = String(user?.text || "");
    if (text.includes("可用记忆") && text.includes("TypeScript")) saw = true;
    return action("complete", { action: "complete", deliverableRef: [], text: "verified typescript convention", summary: "项目银河统一使用TypeScript并在原目录开发。" });
  };
  try {
    employee.update((state) => {
      const task = state.tasks[0];
      task.status = "running";
      task.plan = [{ content: "verify", status: "completed" }];
      task.planRevision = task.revision || 0;
      task.workSession = store.newSession({ title: "t", cwd: state.cwd, taskId: task.id, employeeId: employee.employeeId, ownerId: "owner" }).id;
    });
    store.append(employee.state().tasks[0].workSession, { role: "user", text: "先前一轮" });
    employee.busy.set(created.value.id, { computer: false, session: employee.state().tasks[0].workSession });
    await employee.run(employee.state().tasks[0]);
    assert.equal(saw, true);
    assert.equal(employee.state().tasks[0].status, "done");
  } finally { await engine.close(); store.close(); }
});

test("legacy recallMemory wrapper migrates and respects read-only mode", () => {
  const now = Date.now();
  const state: any = { memories: [{ id: "legacy", text: "项目银河默认使用TypeScript", importance: 2, at: now }] };
  recallMemory(state, "项目银河默认使用TypeScript", now, false);
  assert.equal(state.memories[0].claim, "项目银河默认使用TypeScript");
  const used = state.memories[0].lastUsedAt;
  recallMemory(state, "项目银河默认使用TypeScript", now + 10, false);
  assert.equal(state.memories[0].lastUsedAt, used);
  recallMemory(state, "项目银河默认使用TypeScript", now + 20, true);
  assert((state.memories[0].lastUsedAt || 0) >= now);
});
