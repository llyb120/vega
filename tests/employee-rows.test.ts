import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  return { store, engine };
}
/** Count statements touching a table by wrapping the database's statement calls. */
function spy(store: Store) {
  const seen: string[] = [], db = store.db as any;
  for (const name of ["all", "run"]) {
    const original = db[name].bind(db);
    db[name] = (text: string, params?: unknown[]) => { seen.push(text); return original(text, params); };
  }
  return (table: string, verb = "") => seen.filter((text) => text.includes(table) && text.startsWith(verb)).length;
}

test("tasks and runs are rows: the employee record holds neither, profile changes never touch them, task edits write one row", async () => {
  const { store, engine } = await fixture();
  try {
    const employee = engine.employee;
    const a = await employee.execute("", { action: "add", kind: "todo", text: "first" });
    const b = await employee.execute("", { action: "add", kind: "todo", text: "second" });
    const record = await store.get<any>("employee", {});
    assert.equal(record.tasks, undefined, "tasks are not stored inside the employee JSON");
    assert.equal(record.runs, undefined);
    assert.deepEqual((await store.employeeTasks("default")).map((row) => row.id), [a.value.id, b.value.id]);
    const count = spy(store);
    await employee.updateProfile((state) => { state.name = "renamed"; });
    assert.equal((await employee.profile()).name, "renamed");
    assert.equal(count("SELECT id,data FROM employee_tasks"), 0, "renaming never loads task rows");
    assert.equal(count("employee_tasks", "INSERT") + count("employee_tasks", "DELETE"), 0, "nor writes them");
    assert.equal(count("employee_runs"), 0);
    await employee.update((state) => { employee.task(state, a.value.id).text = "first, edited"; });
    assert.equal(count("employee_tasks", "INSERT"), 1, "only the changed task row is written");
    assert.equal((await employee.findTask(a.value.id))!.text, "first, edited");
    assert.equal((await employee.findTask(b.value.id))!.text, "second");
    assert.equal(await store.activeTaskCount("default"), 2);
  } finally { await engine.close(); await store.close(); }
});

test("a save keeps tasks added meanwhile by another writer and deletes only tasks this writer removed", async () => {
  const { store, engine } = await fixture();
  try {
    const employee = engine.employee;
    const a = await employee.execute("", { action: "add", kind: "todo", text: "a" });
    const b = await employee.execute("", { action: "add", kind: "todo", text: "b" });
    const stale = await employee.state();
    stale.tasks; // this writer reads the list now
    const c = await employee.execute("", { action: "add", kind: "todo", text: "c" });
    stale.tasks = stale.tasks.filter((task) => task.id !== b.value.id);
    stale.tasks.find((task) => task.id === a.value.id)!.text = "a2";
    await employee.save(stale);
    assert.deepEqual((await store.employeeTasks("default")).map((row) => row.id), [a.value.id, c.value.id]);
    assert.equal((await employee.findTask(a.value.id))!.text, "a2");
    assert.equal(await employee.findTask(b.value.id), undefined);
    assert.equal((await employee.findTask(c.value.id))!.text, "c");
  } finally { await engine.close(); await store.close(); }
});

test("runs are inserted, updated in place and trimmed as rows; tasks are found only for their own employee", async () => {
  const { store, engine } = await fixture();
  try {
    const employee = engine.employee;
    await employee.update((state) => { state.runs.push({ taskId: "t1", status: "running" }, { taskId: "t2", status: "running" }); });
    const [first, second] = await store.employeeRuns("default");
    await employee.update((state) => { state.runs[1].status = "done"; });
    assert.deepEqual((await store.employeeRuns("default")).map((row) => [row.id, JSON.parse(row.data).status]), [[first.id, "running"], [second.id, "done"]]);
    await employee.update((state) => { state.runs = state.runs.slice(-1); });
    assert.deepEqual((await store.employeeRuns("default")).map((row) => row.id), [second.id]);
    const other = await engine.employee.for((await engine.employee.create({ name: "Other", cwd: process.cwd() }, "alice")).id);
    const task = await employee.execute("", { action: "add", kind: "todo", text: "mine" });
    assert.equal(await other.findTask(task.value.id), undefined, "another employee cannot reach this task by id");
    assert.equal((await store.employeeTask(task.value.id))!.employee, "default");
    employee.resetting = true;
    await employee.clearWork();
    employee.resetting = false;
    assert.deepEqual(await store.employeeRuns("default"), []);
    assert.deepEqual(await store.employeeTasks("default"), []);
  } finally { await engine.close(); await store.close(); }
});

test("sessions are queried through indexed employee/task/owner/source columns", async () => {
  const store = await Store.open(":memory:");
  try {
    const plain = await store.newSession({ ownerId: "alice" }), mine = await store.newSession({ ownerId: "bob" });
    const chat = await store.newSession({ ownerId: "alice", employeeId: "e1" });
    const work = await store.newSession({ ownerId: "alice", employeeId: "e1", taskId: "t1" });
    const stage = await store.newSession({ ownerId: "alice", stageSource: work.id } as any);
    const nested = await store.newSession({ ownerId: "alice", stageSource: stage.id } as any);
    const ids = (list: { id: string }[]) => list.map((s) => s.id).sort();
    assert.deepEqual(ids(await store.sessionsBy("employee", "e1")), ids([chat, work]));
    assert.deepEqual(ids(await store.sessionsBy("task", "t1")), [work.id]);
    assert.deepEqual(ids(await store.sessionsBy("owner", "bob")), [mine.id]);
    assert.deepEqual(ids(await store.plainSessions()), ids([plain, mine, stage, nested]));
    assert.deepEqual(ids(await store.employeeSessions()), ids([chat, work]));
    assert.deepEqual(ids(await store.sessionFamily(work.id)), ids([work, stage, nested]));
    await store.deleteSession(work.id);
    assert.deepEqual(ids(await store.sessions()), ids([plain, mine, chat]));
    if (store.db.dialect !== "sqlite") return;
    const plan = async (sql: string) => JSON.stringify(await store.all("EXPLAIN QUERY PLAN " + sql));
    for (const column of ["employee", "task", "owner", "source"])
      assert.match(await plan(`SELECT data FROM sessions WHERE ${column}='x'`), /USING INDEX/, column + " lookups use an index");
    assert.match(await plan("SELECT id,data FROM employee_tasks WHERE employee='x'"), /USING INDEX/);
    assert.match(await plan("SELECT count(*) FROM employee_tasks WHERE employee='x' AND active=1"), /USING (COVERING )?INDEX/);
    assert.match(await plan("SELECT id,data FROM employee_runs WHERE employee='x' ORDER BY id"), /USING INDEX/);
  } finally { await store.close(); }
});

test("lastMessage and findMessage read only the newest matching message", async () => {
  const store = await Store.open(":memory:");
  try {
    const s = (await store.newSession({ ownerId: "alice" })).id;
    await store.append(s, { role: "assistant", text: "old reply", delivery: true, tasks: [{ id: "t1" }] } as any);
    await store.append(s, { role: "assistant", text: "with image", images: [{ mime: "image/png", data: "AAAA" }] } as any);
    await store.append(s, { role: "assistant", text: "new reply", delivery: true, tasks: [{ id: "t2" }] } as any);
    await store.append(s, { role: "user", text: "thanks", quote: { seq: 3, role: "assistant", text: "new reply" } } as any);
    assert.equal((await store.lastMessage(s))!.text, "thanks");
    assert.equal((await store.lastMessage(s, "assistant"))!.text, "new reply");
    assert.equal((await store.lastMessage(s, "images"))!.text, "with image");
    assert.equal(await store.lastMessage((await store.newSession({})).id), undefined);
    const delivery = async (id: string) => await store.findMessage(s, "$.delivery", 1, (m) => m.role === "assistant" && !!(m as any).tasks?.some((t: any) => t.id === id));
    assert.equal((await delivery("t1"))!.seq, 1);
    assert.equal((await delivery("t2"))!.seq, 3);
    assert.equal(await delivery("t3"), undefined);
    assert.equal((await store.findMessage(s, "$.quote.seq", 3))!.text, "thanks");
    await assert.rejects(async () => await store.findMessage(s, "$.x') OR 1=1 --", 1), /Invalid message field/);
  } finally { await store.close(); }
});
