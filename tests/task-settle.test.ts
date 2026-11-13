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
