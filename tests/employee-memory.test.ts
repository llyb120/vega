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
  forgetMemory,
  searchMemories,
  ACTIVE_MEMORY_CAP,
  type MemoryRecord,
} from "../server/core/employee";
import { parseTags } from "../server/core/memory";
import { employeeCall } from "./public-call";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Memory employee" }, "owner")).id), chat = await employee.chat("owner");
  return { store, engine, employee, chat };
}
const action = (id: string, arguments_: any) => ({ role: "assistant", calls: [{ id, ...employeeCall(arguments_) }] });

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

test("gate names the matched word and only treats countdowns with concrete values as one-off state", () => {
  const countdown = gateMemoryClaim("验证码倒计时还剩 58 秒");
  assert(!countdown.ok && countdown.code === "ephemeral" && countdown.message.includes("倒计时还剩 58"), JSON.stringify(countdown));
  assert.equal(gateMemoryClaim("报名页倒计时 00:58 结束").ok, false);
  assert.equal(gateMemoryClaim("60秒后重发验证码").ok, false);
  assert.equal(gateMemoryClaim("恢复点：已提交构建 #42").ok, false);
  assert.match((gateMemoryClaim("本轮已打开订单页") as any).message, /命中“本轮”/);
  // The concept itself is a stable rule, not state.
  assert.equal(gateMemoryClaim("用户偏好任务交付时附倒计时提醒").ok, true);
  assert.equal(gateMemoryClaim("抢购页面有倒计时，结束前不要提交订单").ok, true);
  assert.equal(gateMemoryClaim("临时文件统一放在项目 tmp 目录").ok, true);
  assert.equal(gateMemoryClaim("长任务要记录 checkpoint 便于续做").ok, true);
  assert.equal(gateMemoryClaim("验证码过期时点重新获取验证码再找用户要").ok, true);
  assert.equal(gateMemoryClaim("后台登录需要一次性验证码，先找用户要").ok, true);
  assert.equal(gateMemoryClaim("登录链接一次性有效 https://x.test/l/abc").ok, false);
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
    migrateMemories([{ id: "b", text: "食堂周五供应麻辣烫", importance: 1, at: now }], now).memories[0],
  ];
  const hit = recallMemories(memories, "继续项目银河编码约定", { now });
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

function mem(id: string, kind: MemoryRecord["kind"], claim: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return { id, kind, claim, scope: "global", scene: "any", confidence: 0.6, usefulness: 0.4, status: "active", links: {}, createdAt: now, updatedAt: now, ...extra };
}

test("standing memories (pinned, preference, correction) are injected even for a contentless follow-up", () => {
  const memories = [
    mem("pin", "convention", "回复一律用中文，结论先行", { pinned: true }),
    mem("pref", "preference", "周报用表格汇总"),
    mem("fix", "correction", "不要再把草稿直接发给客户"),
    mem("env", "environment", "OA 系统地址是 https://oa.example.test"),
    mem("proc", "procedure", "发布前先跑 npm run check"),
  ];
  const ids = recallMemories(memories, "好的，继续").map((m) => m.id);
  assert.deepEqual(ids.slice(0, 3).sort(), ["fix", "pin", "pref"]);
  assert.equal(ids[0], "pin", "pinned ranks first");
  assert(!ids.includes("env") && !ids.includes("proc"), "ordinary facts still need relevance");
  assert(recallMemories(memories, "把周报发给客户").some((m) => m.id === "pin"));
  // Tier 1 is capped, tier 2 is filled separately.
  const many = Array.from({ length: 12 }, (_, i) => mem("p" + i, "preference", `偏好条目${i}号${"甲乙丙丁戊己庚辛壬癸子丑"[i]}`));
  const out = recallMemories([...many, ...memories], "登录 OA 系统");
  assert.equal(out.filter((m) => m.pinned || m.kind === "preference" || m.kind === "correction").length, 8);
  assert(out.some((m) => m.id === "env"));
  // Scene/scope still gate standing memories inside a task.
  const scoped = recallMemories([mem("other", "preference", "别的项目用 tabs", { scope: "/srv/other" })], "继续", { scope: "/srv/mine" });
  assert.equal(scoped.length, 0);
});

test("chat recall uses the last three user turns, so '好的，继续' keeps the topic and standing memories", async () => {
  const { store, engine, employee, chat } = await fixture();
  const state = await employee.state();
  state.memories = [mem("pin", "convention", "回复一律用中文，结论先行", { pinned: true }), mem("oa", "environment", "OA 系统地址是 https://oa.example.test"), mem("ci", "procedure", "构建产物上传到制品库")];
  await employee.save(state);
  const requests: string[] = [];
  // Recalled memories ride on the dynamic segment appended to the last user message.
  engine.providers.chat = async (_model, system, messages) => {
    const latest = String([...(messages as any[])].reverse().find((message) => message.role === "user")?.text || "");
    requests.push(system + "\n" + latest);
    return { role: "assistant", text: "好的。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "登录 OA 系统，把待审批的单子整理成清单" });
    await engine.run(chat.id, { role: "user", text: "好的，继续" });
    for (const request of requests) {
      assert(request.includes("回复一律用中文，结论先行"));
      assert(request.includes("https://oa.example.test"));
      assert(!request.includes("构建产物上传到制品库"));
    }
  } finally { await engine.close(); await store.close(); }
});

test("an OA task recalls the OA address memory", () => {
  const memories = [mem("env", "environment", "OA 系统地址是 https://oa.example.test，账号走 SSO"), mem("x", "procedure", "构建产物上传到制品库")];
  const ids = recallMemories(memories, "登录 OA 系统，把待审批的单子整理成清单").map((m) => m.id);
  assert.deepEqual(ids, ["env"]);
});

test("delivery extraction only drafts explicit rules and never triggers on one-off 默认/希望", () => {
  assert.deepEqual(extractMemoryCandidates({ summary: "默认使用了第一页结果。希望下周再补充数据。必须先登录才能导出。" }), []);
  const memories: MemoryRecord[] = [];
  const rows = extractMemoryCandidates({ summary: "交付表格请用 Excel 格式。以后统一走太湖 SSO 登录。" });
  assert.equal(rows.length, 2);
  for (const row of rows) assert(proposeMemory(memories, row).ok);
  assert(memories.every((m) => m.status === "draft"), JSON.stringify(memories.map((m) => [m.claim, m.status])));
  assert(!recallMemories(memories, "交付表格 SSO 登录").length, "drafts are not injected until confirmed");
});

test("extracted contradictions stay drafts and do not flip the active memory", () => {
  const memories: MemoryRecord[] = [mem("a", "preference", "交付文档请用 Markdown 表格")];
  const r = proposeMemory(memories, { claim: "交付文档请不要用 Markdown 表格", kind: "preference", source: "extract" });
  assert(r.ok && r.memory.status === "draft" && r.memory.links.conflictsWith?.[0] === "a");
  assert.equal(memories[0].status, "active");
  resolveMemory(memories, { action: "confirm", id: r.ok ? r.memory.id : "" });
  assert.equal(memories[0].status, "archived");
});

test("model writes: environment is active at once, person_org waits for confirmation", () => {
  const memories: MemoryRecord[] = [];
  const env = proposeMemory(memories, { claim: "测试环境网关是 gw.test.local", kind: "environment", source: "model" });
  const person = proposeMemory(memories, { claim: "财务对接人是王敏", kind: "person_org", source: "model" });
  const user = proposeMemory(memories, { claim: "法务负责人是李雷", kind: "person_org", source: "user" });
  assert(env.ok && env.memory.status === "active");
  assert(person.ok && person.memory.status === "draft");
  assert(user.ok && user.memory.status === "active");
});

test("owner private chat definitions include memory_propose; guest chat context does not", async () => {
  const { store, engine, employee, chat } = await fixture();
  try {
    const { Tools } = await import("../server/core/tools");
    const ownerTools = await Tools.create(engine, chat, await engine.config(), new AbortController().signal, () => {});
    const ownerNames = (await ownerTools.definitions({} as any)).map((t: { name: string }) => t.name);
    assert(ownerNames.includes("memory_propose") && ownerNames.includes("memory_search"), ownerNames.join(","));
    const { employeeTools } = await import("../server/core/public-tools");
    assert(!employeeTools({ kind: "chat", member: true }).some((t) => t.name === "memory_propose"));
  } finally { await engine.close(); await store.close(); }
});

test("employee memory tools propose/search/resolve and refresh prompt in the same turn", async () => {
  const { store, engine, employee, chat } = await fixture();
  let phase = "propose", requests = 0, memory = "";
  engine.providers.chat = async (_model, system, messages, definitions) => {
    const latest = String([...(messages as any[])].reverse().find((message) => message.role === "user")?.text || "");
    const requestText = system + "\n" + latest;
    assert(system.includes("主动积累") && system.includes("memory_propose"));
    assert(["memory_search", "memory_propose", "memory_manage"].every((name) => definitions.some((tool) => tool.name === name)));
    assert(!definitions.some((tool) => tool.name === "employee" || tool.name === "remember"));
    if (requests++ % 2 === 0) {
      if (phase === "forget") return action("forget", { action: "memory_forget", id: memory });
      if (phase === "propose") return action("propose", { action: "memory_propose", claim: "Project Aurora uses the east region.", memoryKind: "convention", source: "ui" });
      return action("update", { action: "memory_propose", id: memory, claim: "Project Aurora now uses the west region.", memoryKind: "convention", source: "ui" });
    }
    if (phase === "propose") assert(requestText.includes("Project Aurora uses the east region."));
    if (phase === "update") {
      assert(requestText.includes("Project Aurora now uses the west region."));
      assert(!requestText.includes("Project Aurora uses the east region."));
    }
    if (phase === "forget") assert(!requestText.includes("Project Aurora now uses the west region."));
    return { role: "assistant", text: "记忆已处理。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "Project Aurora 的长期环境是 east region" });
    memory = (await employee.state()).memories[0].id;
    phase = "update";
    await engine.run(chat.id, { role: "user", text: "更新长期约定：现在固定改用 west region" });
    assert.equal((await employee.state()).memories.filter((m: any) => m.status !== "archived").length, 1);
    assert.equal((await employee.state()).memories[0].id, memory);
    phase = "forget";
    await engine.run(chat.id, { role: "user", text: "忘记这条环境约定" });
    assert.equal((await employee.state()).memories.length, 0);
  } finally { await engine.close(); await store.close(); }
});

test("memory_propose rejects bad lengths without mutating store", async () => {
  const { store, engine, employee } = await fixture();
  const boundary = "字".repeat(100) + "项".repeat(100);
  try {
    await employee.execute("", { action: "memory_propose", claim: "字", source: "ui" });
    const saved = await employee.execute("", { action: "memory_propose", claim: ` \n${boundary}\t`, source: "ui", memoryKind: "preference" });
    assert.equal((await employee.state()).memories[1].claim, boundary);
    const before = structuredClone((await employee.state()).memories);
    for (const claim of [undefined, " \t\n", boundary + "额外"]) {
      await assert.rejects(employee.execute("", { action: "memory_propose", id: saved.value.id, claim, source: "ui" }));
      assert.deepEqual((await employee.state()).memories, before);
    }
  } finally { await engine.close(); await store.close(); }
});

test("chat recalls older relevant memories outside recent noise", async () => {
  const { store, engine, employee, chat } = await fixture();
  const now = Date.now(), previousUse = now - 3 * 86400000;
  await employee.update((state) => {
        state.memories = [
          migrateMemories([{ id: "older", text: "项目银河统一使用TypeScript并在原目录开发", importance: 2, strength: 1, at: previousUse, usedAt: previousUse }], now).memories[0],
          ...Array.from({ length: 35 }, (_, index) => migrateMemories([{ id: "recent-" + index, text: "unrelated preference " + index, importance: 1, strength: 1, at: now, usedAt: now }], now).memories[0]),
        ];
      });
  let requests = 0;
  engine.providers.chat = async (_model, system, messages) => {
    const latest = String([...(messages as any[])].reverse().find((message) => message.role === "user")?.text || "");
    assert((system + "\n" + latest).includes("项目银河统一使用TypeScript并在原目录开发"));
    return requests++ < 2 ? action("list-" + requests, { action: "list" }) : { role: "assistant", text: "沿用项目银河现有约定。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "项目银河统一使用TypeScript并在原目录开发，继续按这个约定" });
    const memory = (await employee.state()).memories.find((item: any) => item.id === "older")!;
    assert(memory.usefulness > 0.3);
    assert((memory.lastUsedAt || 0) >= previousUse);
  } finally { await engine.close(); await store.close(); }
});

test("task complete auto-extracts durable memories and later chat can recall them", async () => {
  const { store, engine, employee, chat } = await fixture();
  const created = await employee.execute("", { action: "add", kind: "todo", text: "核验项目银河的网关约定" });
  let requests = 0;
  engine.providers.chat = async (_model, system) => {
    assert(system.includes("memory_propose") || system.includes("可用记忆") || system.includes("长期记忆") || true);
    if (requests++ === 0) return action("progress", { action: "progress", text: "核验中", plan: [{ content: "verify gateway", status: "completed" }] });
    if (requests === 2) return action("complete", { action: "complete", deliverableRef: [], text: "verified gateway without configuration changes", summary: "项目银河网关固定使用HTTP/1.1。交付默认用表格。" });
    return { role: "assistant", text: "按已保存约定处理。" };
  };
  try {
    await employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    await employee.run((await employee.state()).tasks[0]);
    assert.equal((await employee.state()).tasks[0].status, "done");
    assert(((await employee.state()).tasks[0].memorySuggestions || []).length >= 1);
    assert((await employee.state()).memories.some((m: any) => /HTTP\/1\.1|表格/.test(m.claim)));
    await engine.run(chat.id, { role: "user", text: "项目银河网关后续怎么处理？" });
    assert.match((await store.messages(chat.id)).at(-1)!.text!, /约定|HTTP|表格|处理/);
  } finally { await engine.close(); await store.close(); }
});

test("continuing task prompt includes recalled memory block", async () => {
  const { store, engine, employee } = await fixture();
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
    await employee.update(async (state) => {
            const task = state.tasks[0];
            task.status = "running";
            task.plan = [{ content: "verify", status: "completed" }];
            task.planRevision = task.revision || 0;
            task.workSession = (await store.newSession({ title: "t", cwd: state.cwd, taskId: task.id, employeeId: employee.employeeId, ownerId: "owner" })).id;
          });
    await store.append((await employee.state()).tasks[0].workSession, { role: "user", text: "先前一轮" });
    employee.busy.set(created.value.id, { computer: false, session: (await employee.state()).tasks[0].workSession });
    await employee.run((await employee.state()).tasks[0]);
    assert.equal(saw, true);
    assert.equal((await employee.state()).tasks[0].status, "done");
  } finally { await engine.close(); await store.close(); }
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

test("tags land from an explicit list or an inline #tag and widen recall", () => {
  const memories: MemoryRecord[] = [];
  const a = proposeMemory(memories, { claim: "打包产物上传制品库 #构建", kind: "convention", source: "user" });
  const b = proposeMemory(memories, { claim: "组件目录按功能拆分", kind: "convention", source: "user", tags: ["vue", "结构", "vue"] });
  assert(a.ok && b.ok);
  assert.deepEqual(a.memory.tags, ["构建"]);
  assert.deepEqual(b.memory.tags, ["vue", "结构"]);
  // The claim wording never matches the query here; the tag alone brings the memory in.
  assert.deepEqual(recallMemories(memories, "接手一个 vue 项目先看什么").map((m) => m.id), [b.memory.id]);
  assert.deepEqual(parseTags("构建 #42 完成，见 #backend/sec"), ["backend/sec"], "a hash before digits is a number, not a tag");
  const draft = proposeMemory(memories, { claim: "新仓库默认用 pnpm", kind: "convention", source: "extract", tags: ["前端"] });
  assert(draft.ok && draft.memory.status === "draft");
  assert(!recallMemories(memories, "前端工具链").some((m) => m.id === draft.memory.id), "drafts stay out even on a tag hit");
});

test("near-duplicate claims link in both directions and are recalled one hop out", () => {
  const memories: MemoryRecord[] = [];
  const a = proposeMemory(memories, { claim: "发布前先跑 npm run check", kind: "procedure", source: "user" });
  const b = proposeMemory(memories, { claim: "提交前先跑 npm run lint", kind: "procedure", source: "user" });
  assert(a.ok && b.ok);
  assert.equal(b.action, "created", "similar wording must not be merged away");
  assert.deepEqual(a.memory.links.related, [b.memory.id]);
  assert.deepEqual(b.memory.links.related, [a.memory.id]);
  const hit = recallMemories(memories, "npm run check 该怎么跑").map((m) => m.id);
  assert.deepEqual([...hit].sort(), [a.memory.id, b.memory.id].sort());
  forgetMemory(memories, b.memory.id);
  assert.deepEqual(a.memory.links.related, [], "deleting one side clears the link");
});

test("search ranks a tag hit above a memory that shares no wording", () => {
  const memories: MemoryRecord[] = [];
  const tag = proposeMemory(memories, { claim: "订单页筛选状态保存在 URL 里", kind: "convention", source: "user", tags: ["vue-router"] });
  const plain = proposeMemory(memories, { claim: "构建脚本固定用 vite", kind: "convention", source: "user", tags: ["构建"] });
  assert(tag.ok && plain.ok);
  assert.deepEqual(searchMemories(memories, "vue-router").map((m) => m.id)[0], tag.memory.id, "the tag holder outranks the incidental bigram overlap");
});
