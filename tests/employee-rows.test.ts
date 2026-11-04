import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  return { store, engine };
}
/** Count statements touching a table by wrapping the store's statement cache. */
function spy(store: Store) {
  const seen: string[] = [], sql = store.sql.bind(store);
  (store as any).sql = (text: string) => { seen.push(text); return sql(text); };
  return (table: string, verb = "") => seen.filter((text) => text.includes(table) && text.startsWith(verb)).length;
}

test("tasks and runs are rows: the employee record holds neither, and untouched lists are never read or written", async () => {
  const { store, engine } = fixture();
  try {
    const employee = engine.employee;
    const a = await employee.execute("", { action: "add", kind: "todo", text: "first" });
    const b = await employee.execute("", { action: "add", kind: "todo", text: "second" });
    const record = store.get<any>("employee", {});
    assert.equal(record.tasks, undefined, "tasks are not stored inside the employee JSON");
    assert.equal(record.runs, undefined);
    assert.deepEqual(store.employeeTasks("default").map((row) => row.id), [a.value.id, b.value.id]);
    const count = spy(store);
    employee.update((state) => { state.name = "renamed"; });
    assert.equal(employee.state().name, "renamed");
    assert.equal(count("SELECT id,data FROM employee_tasks"), 0, "renaming never loads task rows");
    assert.equal(count("employee_tasks", "INSERT") + count("employee_tasks", "DELETE"), 0, "nor writes them");
    assert.equal(count("employee_runs"), 0);
    employee.update((state) => { employee.task(state, a.value.id).text = "first, edited"; });
    assert.equal(count("employee_tasks", "INSERT"), 1, "only the changed task row is written");
    assert.equal(employee.findTask(a.value.id)!.text, "first, edited");
    assert.equal(employee.findTask(b.value.id)!.text, "second");
    assert.equal(store.activeTaskCount("default"), 2);
  } finally { await engine.close(); store.close(); }
});

test("a save keeps tasks added meanwhile by another writer and deletes only tasks this writer removed", async () => {
  const { store, engine } = fixture();
  try {
    const employee = engine.employee;
    const a = await employee.execute("", { action: "add", kind: "todo", text: "a" });
    const b = await employee.execute("", { action: "add", kind: "todo", text: "b" });
    const stale = employee.state();
    stale.tasks; // this writer reads the list now
    const c = await employee.execute("", { action: "add", kind: "todo", text: "c" });
    stale.tasks = stale.tasks.filter((task) => task.id !== b.value.id);
    stale.tasks.find((task) => task.id === a.value.id)!.text = "a2";
    employee.save(stale);
    assert.deepEqual(store.employeeTasks("default").map((row) => row.id), [a.value.id, c.value.id]);
    assert.equal(employee.findTask(a.value.id)!.text, "a2");
    assert.equal(employee.findTask(b.value.id), undefined);
    assert.equal(employee.findTask(c.value.id)!.text, "c");
  } finally { await engine.close(); store.close(); }
});

test("runs are inserted, updated in place and trimmed as rows; tasks are found only for their own employee", async () => {
  const { store, engine } = fixture();
  try {
    const employee = engine.employee;
    employee.update((state) => { state.runs.push({ taskId: "t1", status: "running" }, { taskId: "t2", status: "running" }); });
    const [first, second] = store.employeeRuns("default");
    employee.update((state) => { state.runs[1].status = "done"; });
    assert.deepEqual(store.employeeRuns("default").map((row) => [row.id, JSON.parse(row.data).status]), [[first.id, "running"], [second.id, "done"]]);
    employee.update((state) => { state.runs = state.runs.slice(-1); });
    assert.deepEqual(store.employeeRuns("default").map((row) => row.id), [second.id]);
    const other = engine.employee.for(engine.employee.create({ name: "Other", cwd: process.cwd() }, "alice").id);
    const task = await employee.execute("", { action: "add", kind: "todo", text: "mine" });
    assert.equal(other.findTask(task.value.id), undefined, "another employee cannot reach this task by id");
    assert.equal(store.employeeTask(task.value.id)!.employee, "default");
    employee.resetting = true;
    employee.clearWork();
    employee.resetting = false;
    assert.deepEqual(store.employeeRuns("default"), []);
    assert.deepEqual(store.employeeTasks("default"), []);
  } finally { await engine.close(); store.close(); }
});

test("sessions are queried through indexed employee/task/owner/source columns", () => {
  const store = new Store(":memory:");
  try {
    const plain = store.newSession({ ownerId: "alice" }), mine = store.newSession({ ownerId: "bob" });
    const chat = store.newSession({ ownerId: "alice", employeeId: "e1" });
    const work = store.newSession({ ownerId: "alice", employeeId: "e1", taskId: "t1" });
    const stage = store.newSession({ ownerId: "alice", stageSource: work.id } as any);
    const nested = store.newSession({ ownerId: "alice", stageSource: stage.id } as any);
    const ids = (list: { id: string }[]) => list.map((s) => s.id).sort();
    assert.deepEqual(ids(store.sessionsBy("employee", "e1")), ids([chat, work]));
    assert.deepEqual(ids(store.sessionsBy("task", "t1")), [work.id]);
    assert.deepEqual(ids(store.sessionsBy("owner", "bob")), [mine.id]);
    assert.deepEqual(ids(store.plainSessions()), ids([plain, mine, stage, nested]));
    assert.deepEqual(ids(store.employeeSessions()), ids([chat, work]));
    assert.deepEqual(ids(store.sessionFamily(work.id)), ids([work, stage, nested]));
    store.deleteSession(work.id);
    assert.deepEqual(ids(store.sessions()), ids([plain, mine, chat]));
    const plan = (sql: string) => JSON.stringify(store.db.prepare("EXPLAIN QUERY PLAN " + sql).all());
    for (const column of ["employee", "task", "owner", "source"])
      assert.match(plan(`SELECT data FROM sessions WHERE ${column}='x'`), /USING INDEX/, column + " lookups use an index");
    assert.match(plan("SELECT id,data FROM employee_tasks WHERE employee='x'"), /USING INDEX/);
    assert.match(plan("SELECT count(*) FROM employee_tasks WHERE employee='x' AND active=1"), /USING (COVERING )?INDEX/);
    assert.match(plan("SELECT id,data FROM employee_runs WHERE employee='x' ORDER BY id"), /USING INDEX/);
  } finally { store.close(); }
});

test("lastMessage and findMessage read only the newest matching message", () => {
  const store = new Store(":memory:");
  try {
    const s = store.newSession({ ownerId: "alice" }).id;
    store.append(s, { role: "assistant", text: "old reply", delivery: true, tasks: [{ id: "t1" }] } as any);
    store.append(s, { role: "assistant", text: "with image", images: [{ mime: "image/png", data: "AAAA" }] } as any);
    store.append(s, { role: "assistant", text: "new reply", delivery: true, tasks: [{ id: "t2" }] } as any);
    store.append(s, { role: "user", text: "thanks", quote: { seq: 3, role: "assistant", text: "new reply" } } as any);
    assert.equal(store.lastMessage(s)!.text, "thanks");
    assert.equal(store.lastMessage(s, "assistant")!.text, "new reply");
    assert.equal(store.lastMessage(s, "images")!.text, "with image");
    assert.equal(store.lastMessage(store.newSession({}).id), undefined);
    const delivery = (id: string) => store.findMessage(s, "$.delivery", 1, (m) => m.role === "assistant" && !!(m as any).tasks?.some((t: any) => t.id === id));
    assert.equal(delivery("t1")!.seq, 1);
    assert.equal(delivery("t2")!.seq, 3);
    assert.equal(delivery("t3"), undefined);
    assert.equal(store.findMessage(s, "$.quote.seq", 3)!.text, "thanks");
    assert.throws(() => store.findMessage(s, "$.x') OR 1=1 --", 1), /Invalid message field/);
  } finally { store.close(); }
});
