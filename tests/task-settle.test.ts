import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { resolveDeliverable } from "../server/core/employee";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Settle" }, "owner")).id);
  return { store, engine, employee };
}

test("task_complete cannot auto-finish a trailing in_progress step", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Open baidu" });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    const plan = [
      { content: "relay browser", status: "completed" },
      { content: "verify result", status: "in_progress" },
    ];
    await employee.update((state) => { Object.assign(state.tasks[0], { status: "running", revision: 0, planRevision: 0, plan }); });
    const delivery = { action: "complete", deliverableRef: [], text: "Opened https://www.baidu.com, title ok, search box present.", summary: "百度首页已打开。" };
    await assert.rejects(employee.execute(created.value.id, delivery), /未验证步骤=2:in_progress/);
    assert.equal((await employee.state()).tasks[0].plan[1].status, "in_progress");
    await employee.execute(created.value.id, { action: "progress", text: "verified", plan: [plan[0], { ...plan[1], status: "completed" }] });
    const done = await employee.execute(created.value.id, delivery);
    assert.equal(done.stop, true);
    assert.equal((await employee.state()).tasks[0].completion.includes("baidu.com"), true);
  } finally { await engine.close(); await store.close(); }
});

test("task_complete still rejects a non-trailing or non-single in_progress step", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify" });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    await employee.update((state) => {
      Object.assign(state.tasks[0], {
        status: "running",
        revision: 0,
        planRevision: 0,
        plan: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "pending" },
        ],
      });
    });
    await assert.rejects(
      employee.execute(created.value.id, { action: "complete", deliverableRef: [], text: "partial", summary: "partial" }),
      /未验证步骤=1:in_progress、2:pending/,
    );
  } finally { await engine.close(); await store.close(); }
});

test("first recover resumes immediately; later attempts back off", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Recover timing" });
    const now = Date.now();
    await employee.update((state) => {
      const t = state.tasks[0];
      employee.recover(t, "执行轮已结束但未验证交付。上次结果：draft", now);
      assert.equal(t.status, "recovering");
      assert.equal(t.nextCheckAt, now);
      employee.recover(t, "仍未交付", now);
      assert.equal(t.nextCheckAt, now + 30_000);
      employee.recover(t, "仍未交付", now);
      assert.equal(t.nextCheckAt, now + 60_000);
    });
  } finally { await engine.close(); await store.close(); }
});

test("ending a turn with a long delivery and settled plan nudges instead of recovering", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Open page" });
    const job = (await employee.state()).tasks[0];
    const body = "页面已打开。最终 URL 是 https://www.baidu.com/，标题正常，搜索框可用，未输入任何内容。" + "细节。".repeat(20);
    employee.runtime.run = async (session: string) => {
      await store.append(session, { role: "assistant", model: "fixture/model", text: body });
    };
    await employee.update((state) => {
      Object.assign(state.tasks[0], {
        status: "running",
        plan: [
          { content: "open", status: "completed" },
          { content: "deliver", status: "completed" },
        ],
        planRevision: 0,
        revision: 0,
      });
    });
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run((await employee.state()).tasks[0]);
    const task = (await employee.state()).tasks[0];
    assert.equal(task.status, "queued");
    assert.equal(task.settleNudges, 1);
    assert.match(task.answer || "", /task_complete/);
    assert.ok((task.nextCheckAt || 0) <= Date.now() + 1000);
  } finally { await engine.close(); await store.close(); }
});

test("omitted deliverableRefs pick the latest substantial body during complete", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Write list" });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    const session = await store.newSession({ cwd: process.cwd(), employeeId: employee.employeeId, taskId: created.value.id, scene: "lightweight", model: "fixture/model", ownerId: "owner" });
    const body = "# 清单\n" + "条目一。\n".repeat(40);
    await store.append(session.id, { role: "assistant", model: "fixture/model", text: body });
    await employee.update((state) => {
      Object.assign(state.tasks[0], {
        status: "running",
        workSession: session.id,
        plan: [{ content: "write", status: "completed" }],
        planRevision: 0,
        revision: 0,
      });
    });
    await employee.execute(created.value.id, { action: "complete", text: "已核对清单条目。", summary: "清单已交付。" });
    const task = (await employee.state()).tasks[0];
    assert.equal(task.deliverable?.startsWith("# 清单"), true);
    assert.deepEqual(task.deliverableRefs?.length, 1);
  } finally { await engine.close(); await store.close(); }
});

test("resolveDeliverable upgrades a stale citation past a newer long body", () => {
  const body = "正文".repeat(200);
  const newer = body + "更新";
  const messages: any[] = [
    { seq: 1, role: "user", text: "go" },
    { seq: 2, role: "assistant", model: "m", text: body },
    { seq: 3, role: "assistant", model: "m", text: newer },
  ];
  const r = resolveDeliverable(messages, [2]);
  assert.equal(r.upgraded, true);
  assert.deepEqual(r.refs, [3]);
  assert.equal(r.texts[0], newer.trim());
});

test("same-turn [task_progress, task_complete] closes out with body text while keeping evidence and standalone guards intact", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "输出调研结论" });
    const body = "# 调研结论\n\n" + "实测价格与额度数据明细。".repeat(30);
    let turn = 0;
    engine.providers.chat = async (_model, _system, messages) => {
      turn++;
      if (turn === 1) {
        // Mixing bash + task_complete must still be rejected
        return {
          role: "assistant",
          model: "fixture/model",
          calls: [
            { id: "bad-read", name: "context_budget", arguments: {} },
            { id: "bad-done", name: "task_complete", arguments: { evidence: "premature", summary: "premature" } },
          ],
        };
      }
      if (turn === 2) {
        assert(messages.findLast(m => m.callId === "bad-done")?.error);
        // Same-turn report body + task_progress(completed) + task_complete succeeds in ONE turn
        return {
          role: "assistant",
          model: "fixture/model",
          text: body,
          calls: [
            { id: "p1", name: "task_progress", arguments: { message: "完成调研与报告", plan: [{ content: "核查并输出调研结论", status: "completed" }] } },
            { id: "c1", name: "task_complete", arguments: { evidence: "已核对官方页面原文与价格。", summary: "调研结论已交付。" } },
          ],
        };
      }
      throw Error("unexpected extra turn " + turn);
    };
    await employee.update(state => { state.tasks[0].status = "running"; });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    await employee.run((await employee.state()).tasks[0]);
    const done = (await employee.state()).tasks[0];
    assert.equal(done.status, "done");
    assert.equal(turn, 2);
    assert.equal(done.deliverable, body);
    assert.match(done.result || "", /已核对官方页面原文与价格/);
  } finally { await engine.close(); await store.close(); }
});

test("simple fresh task completes directly with real evidence without a ceremonial plan, while revised tasks still require a settled plan", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const simple = await employee.execute("", { action: "add", kind: "todo", text: "确认首页标题" });
    employee.busy.set(simple.value.id, { computer: false, session: "" });
    await employee.update(state => { state.tasks[0].status = "running"; });
    // Empty evidence is ALWAYS rejected even for simple tasks
    await assert.rejects(
      employee.execute(simple.value.id, { action: "complete", deliverableRef: [], text: " ", summary: "已确认。" }),
      /evidence=空/,
    );
    // Real evidence succeeds directly without a ceremonial 1-step plan
    const ok = await employee.execute(simple.value.id, {
      action: "complete",
      deliverableRef: [],
      text: "已访问 https://example.com，标题 Example Domain。",
      summary: "首页标题已确认。",
    });
    assert.equal(ok.stop, true);
    assert.match((await employee.state()).tasks[0].completion, /Example Domain/);

    // Once a task is revised (revision > 0), plan verification stays strictly enforced
    const revised = await employee.execute("", { action: "add", kind: "todo", text: "检查配置" });
    employee.busy.set(revised.value.id, { computer: false, session: "" });
    await employee.update(state => {
      const t = state.tasks.find((x: any) => x.id === revised.value.id)!;
      Object.assign(t, { status: "running", revision: 1, planRevision: 0, plan: [] });
    });
    await assert.rejects(
      employee.execute(revised.value.id, { action: "complete", deliverableRef: [], text: "已检查。", summary: "已完成。" }),
      /plan=0步/,
    );
  } finally { await engine.close(); await store.close(); }
});

test("closeout batch allows [task_progress, memory_propose, task_complete] in order while rejecting execution tools with task_complete", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "记录环境并交付" });
    let turn = 0;
    engine.providers.chat = async () => {
      turn++;
      if (turn === 1) {
        return {
          role: "assistant",
          model: "fixture/model",
          calls: [
            { id: "p1", name: "task_progress", arguments: { message: "核对完毕", plan: [{ content: "核对环境", status: "completed" }] } },
            { id: "m1", name: "memory_propose", arguments: { claim: "测试环境端口固定为 8080", memoryKind: "environment" } },
            { id: "c1", name: "task_complete", arguments: { deliverableRefs: [], evidence: "已实测端口 8080 监听正常。", summary: "核对完成并记录稳定环境事实。" } },
          ],
        };
      }
      throw Error("unexpected turn " + turn);
    };
    await employee.update(state => { state.tasks[0].status = "running"; });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    await employee.run((await employee.state()).tasks[0]);
    const st = await employee.state();
    assert.equal(st.tasks[0].status, "done");
    assert.equal(turn, 1, "progress + memory_propose + task_complete finishes in a single turn");
    assert(st.memories.some((m: any) => m.claim.includes("8080")));
  } finally { await engine.close(); await store.close(); }
});
