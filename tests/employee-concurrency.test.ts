import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { sleep } from "../server/core/util";
import { chromeCall, employeeCall } from "./public-call";

const legacy = (name: string, args: any) => name === "employee" ? employeeCall(args) : name === "chrome" ? chromeCall(args) : { name, arguments: args };
const call = (id: string, name: string, arguments_: any) => ({ role: "assistant", calls: [{ id, ...legacy(name, arguments_) }] });

test("a lightweight shell query releases its workspace lease before later model reasoning finishes", { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vega-transient-work-")), store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "p/light", scenes: { lightweight: ["p/light"], coding: ["p/code"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { limit: { context: 128000, output: 8192 } }, code: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Command employee", cwd }, "owner").id), requests = new Map<string, number>();
  let query = "", writer = "", reasoning = false, release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const until = async (condition: () => boolean) => { for (let index = 0; index < 1000; index++) { if (condition()) return; await sleep(5); } throw Error("parallel command condition not reached"); };
  engine.providers.chat = async (model, _system, messages, _definitions, _signal, _emit, sessionId) => {
    const id = store.session(sessionId!).taskId!, attempt = requests.get(id) || 0; requests.set(id, attempt + 1);
    assert(attempt < 8);
    if (id === query) {
      assert.equal(model.selection, "p/light");
      if (!attempt) return call("query", "bash", { command: process.platform === "win32" ? "Write-Output 'query complete'" : "printf 'query complete'" });
      if (attempt === 1) { assert(messages.findLast(message => message.role === "tool")!.text!.includes("query complete")); reasoning = true; await gate; }
    } else {
      assert.equal(id, writer);
      if (model.selection === "p/light") return call("code", "switch_scene", { scene: "coding", message: "验证编码阶段可继续执行" });
      assert([...engine.employee.writers.values()].some(lease => lease.taskId === writer));
    }
    return employee.task(employee.state(), id).plan?.length
      ? call("done", "employee", { action: "complete", deliverableRef: [], text: "verified result", summary: "已验证。" })
      : call("plan", "employee", { action: "progress", text: "verified", plan: [{ content: "verify", status: "completed" }] });
  };
  try {
    query = (await employee.execute("", { action: "add", kind: "todo", text: "普通命令查询并整理" })).value.id;
    engine.employee.closed = false; await engine.employee.drain();
    await until(() => reasoning);
    assert.equal(engine.employee.writers.size, 0, "the completed shell query must not hold a whole-task write lock");
    writer = (await employee.execute("", { action: "add", kind: "todo", text: "独立编码阶段" })).value.id;
    await engine.employee.drain();
    await until(() => employee.task(employee.state(), writer).status === "done");
    assert.equal(employee.task(employee.state(), query).status, "running");
    release();
    await until(() => employee.task(employee.state(), query).status === "done" && !employee.busy.size);
    assert.equal(engine.employee.writers.size, 0);
  } finally {
    engine.employee.closed = true; release(); await engine.close();
    for (let index = 0; index < 100 && employee.busy.size; index++) await sleep(5);
    store.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("ordinary tasks keep progressing while a shared-directory code writer is active, and a blocked writer resumes in its original session without replay", { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vega-parallel-work-"));
  await writeFile(join(cwd, "input.txt"), "read-only input");
  const store = new Store(":memory:"), engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "p/light", scenes: { lightweight: ["p/light"], coding: ["p/code"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { limit: { context: 128000, output: 8192 } }, code: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Parallel employee", cwd }, "owner").id);
  const jobs: Record<string, string> = {}, requests = new Map<string, number>();
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => release = resolve);
  const add = async (name: string) => { const result = await employee.execute("", { action: "add", kind: "todo", text: name }); jobs[name] = result.value.id; return result.value.id; };
  const until = async (condition: () => boolean, description: string) => {
    for (let index = 0; index < 500; index++) { if (condition()) return; await sleep(5); }
    throw Error("Task condition not reached: " + description);
  };
  engine.providers.chat = async (model, _system, messages, _definitions, signal, _emit, sessionId) => {
    const session = store.session(sessionId!), id = session.taskId!, task = employee.task(employee.state(), id);
    const attempt = (requests.get(id) || 0) + 1; requests.set(id, attempt);
    assert(attempt <= 15, "task cannot loop on a blocked operation");
    const successful = (name: string) => messages.some(message => message.role === "tool" && message.name === name && !message.error);
    if ([jobs.writer, jobs.waiter].includes(id) && model.selection === "p/light") return call(id + "-scene-" + attempt, "switch_scene", { scene: "coding", message: "按授权修改并验证当前工作区，不重放提交" });
    if (id === jobs.writer) {
      entered = true;
      await Promise.race([gate, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      if (!successful("write")) return call("write-once", "write", { path: "shared.txt", content: "A verified" });
    } else if (id === jobs.waiter) {
      assert.equal(model.selection, "p/code");
      if (!successful("read")) return call("read-after-lock", "read", { path: "shared.txt" });
      const original = messages.findLast(message => message.role === "tool" && message.name === "read")!.text!;
      assert(original.includes("A verified"), "resuming a blocked writer must see the previous writer's actual result");
      if (!successful("edit")) return call("edit-once", "edit", { path: "shared.txt", edits: [{ oldText: "A verified", newText: "A verified + C verified" }] });
    } else {
      assert.equal(model.selection, "p/light");
      if (id === jobs.reader && !successful("read")) return call("read-in-parallel", "read", { path: "input.txt" });
    }
    return task.plan?.every((step: any) => step.status === "completed") && task.plan.length
      ? call("done", "employee", { action: "complete", deliverableRef: [], text: "verified actual result", summary: "已验证。" })
      : call("plan", "employee", { action: "progress", text: "verified actual result", plan: [{ content: "verify authorized result", status: "completed" }] });
  };
  try {
    await add("writer");
    engine.employee.closed = false; await engine.employee.drain();
    await until(() => entered, "first writer holds its code phase");
    await add("reader"); await add("waiter"); await add("summary");
    await engine.employee.drain();
    await until(() => employee.state().tasks.find(task => task.id === jobs.waiter)?.workspaceWait && !employee.busy.has(jobs.waiter), "second writer yields instead of retrying");
    const blocked = employee.task(employee.state(), jobs.waiter), originalSession = blocked.workSession;
    assert.equal(blocked.status, "queued");
    assert.equal(blocked.recovery, undefined);
    assert.equal(blocked.failures || 0, 0);
    assert(store.messages(originalSession).some(message => message.role === "tool" && message.text?.includes('"status":"queued"')));
    await until(() => [jobs.reader, jobs.summary].every(id => employee.task(employee.state(), id).status === "done"), "read and summary tasks finish while writer is still active");
    assert.equal(employee.task(employee.state(), jobs.writer).status, "running");
    assert.equal(await readFile(join(cwd, "input.txt"), "utf8"), "read-only input");
    release();
    await until(() => Object.values(jobs).every(id => employee.task(employee.state(), id).status === "done") && !employee.busy.size, "all original jobs finish");
    assert.equal(employee.task(employee.state(), jobs.waiter).workSession, originalSession);
    assert.equal(await readFile(join(cwd, "shared.txt"), "utf8"), "A verified + C verified");
    assert.equal(engine.employee.writers.size, 0);
    assert.equal(store.sessions().length, 4);
    assert.equal(store.messages(employee.task(employee.state(), jobs.writer).workSession).filter(message => message.role === "tool" && message.name === "write").length, 1);
    assert.equal(store.messages(originalSession).filter(message => message.role === "tool" && message.name === "edit").length, 1);
  } finally {
    engine.employee.closed = true; release(); await engine.close();
    for (let index = 0; index < 100 && employee.busy.size; index++) await sleep(5);
    store.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
