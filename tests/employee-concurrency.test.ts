import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  const cwd = await mkdtemp(join(tmpdir(), "vega-transient-work-")), store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/light", scenes: { lightweight: ["p/light"], coding: ["p/code"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { limit: { context: 128000, output: 8192 } }, code: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Command employee", cwd }, "owner")).id), requests = new Map<string, number>();
  let query = "", writer = "", reasoning = false, release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const until = async (condition: () => boolean | Promise<boolean>) => { for (let index = 0; index < 1000; index++) { if (await condition()) return; await sleep(5); } throw Error("parallel command condition not reached"); };
  engine.providers.chat = async (model, _system, messages, _definitions, _signal, _emit, sessionId) => {
    const session = await store.session(sessionId!), id = session.taskId!, attempt = requests.get(id) || 0; requests.set(id, attempt + 1);
    assert(attempt < 10);
    if (id === query) {
      assert.equal(model.selection, "p/light");
      if (!attempt) return call("query", "bash", { command: `cd '${cwd}'; ` + (process.platform === "win32" ? "Write-Output 'query complete'" : "printf 'query complete'") });
      if (attempt === 1) { assert(messages.findLast(message => message.role === "tool")!.text!.includes("query complete")); reasoning = true; await gate; }
    } else {
      assert.equal(id, writer);
      if (model.selection === "p/light") {
        const taskPrompt = messages.find(message => message.role === "user" && message.text?.includes("[热心市民任务"))?.text || "";
        assert.match(taskPrompt, /git switch -c <新分支> <基线SHA>/);
        assert.match(taskPrompt, /git worktree add -b <新分支> <目录> <基线SHA>/);
        if (!messages.some(message => message.role === "tool" && message.name === "code_agent"))
          return call("code", "code_agent", { task: "验证编码阶段可继续执行" });
      } else {
        assert.equal(session.phaseRole, "code_agent");
        if (!messages.some(message => message.role === "tool" && message.name === "write")) {
          assert.equal(engine.employee.writers.size, 0, "entering coding does not reserve a writer");
          return call("actual-write", "write", { path: join(cwd, "code.txt"), content: "verified" });
        }
        assert([...engine.employee.writers.values()].some(lease => lease.taskId === writer));
        return { role: "assistant", text: "code.txt written" };
      }
    }
    return employee.task(await employee.state(), id).plan?.length
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
    await until(async () => employee.task(await employee.state(), writer).status === "done");
    assert.equal(employee.task(await employee.state(), query).status, "running");
    release();
    await until(async () => employee.task(await employee.state(), query).status === "done" && !employee.busy.size);
    assert.equal(engine.employee.writers.size, 0);
  } finally {
    engine.employee.closed = true; release(); await engine.close();
    for (let index = 0; index < 100 && employee.busy.size; index++) await sleep(5);
    await store.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a sibling Git worktree and read-only probes run in parallel; an overlapping writer resumes without replay", { timeout: 15000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vega-parallel-work-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const cwd = join(root, "repo"), nested = join(cwd, "nested"), worktree = join(root, "repo-topic");
  await mkdir(nested, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=.git/no-hooks", ...args], { timeout: 5000 });
  git("init", "-q");
  await writeFile(join(cwd, "input.txt"), "read-only input");
  git("add", "input.txt");
  git("-c", "user.name=Vega Test", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  git("worktree", "add", "--quiet", "--detach", worktree);
  const store = await Store.open(":memory:"), engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/light", scenes: { lightweight: ["p/light"], coding: ["p/code"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { limit: { context: 128000, output: 8192 } }, code: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Parallel employee", cwd }, "owner")).id);
  const jobs: Record<string, string> = {}, requests = new Map<string, number>();
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => release = resolve);
  const add = async (name: string, directory = cwd) => { const result = await employee.execute("", { action: "add", kind: "todo", text: name, cwd: directory }); jobs[name] = result.value.id; return result.value.id; };
  const until = async (condition: () => unknown, description: string) => {
    for (let index = 0; index < 500; index++) { if (await condition()) return; await sleep(5); }
    throw Error("Task condition not reached: " + description);
  };
  const waiterPhases = { count: 0 };
  engine.providers.chat = async (model, _system, messages, _definitions, signal, _emit, sessionId) => {
    const session = await store.session(sessionId!), id = session.taskId!, task = employee.task(await employee.state(), id);
    const attempt = (requests.get(id) || 0) + 1; requests.set(id, attempt);
    assert(attempt <= 18, "task cannot loop on a blocked operation");
    const receipts = messages.filter(message => message.role === "tool");
    const successful = (name: string) => receipts.some(message => message.name === name && !message.error);
    if (id !== jobs.summary && model.selection === "p/light") {
      if (!successful("code_agent")) return call(id + "-code-" + attempt, "code_agent", { task: "按任务范围核对和操作当前工作区" });
    } else if (id === jobs.writer) {
      if (!successful("write")) return call("write-once", "write", { path: join(cwd, "shared.txt"), content: "A verified" });
      entered = true;
      await Promise.race([gate, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      return { role: "assistant", text: "writer done" };
    } else if (id === jobs.waiter) {
      assert.equal(model.selection, "p/code");
      if (!waiterPhases.count && !receipts.some(message => message.name === "bash")) {
        waiterPhases.count++;
        // A read-like prefix and a caller-supplied flag do not make arbitrary shell read-only.
        const command = process.platform === "win32" ? "Get-Location; Set-Content -LiteralPath stamp.txt -Value ran" : "pwd; printf ran > stamp.txt";
        return call("blocked-bash", "bash", { command: `cd '${nested}'; ${command}`, readOnly: true });
      }
      if (!successful("read")) return call("read-after-lock", "read", { path: join(cwd, "shared.txt") });
      const original = receipts.findLast(message => message.name === "read")!.text!;
      assert(original.includes("A verified"), "resuming a blocked writer must see the previous writer's actual result");
      if (!successful("edit")) return call("edit-once", "edit", { path: join(cwd, "shared.txt"), edits: [{ oldText: "A verified", newText: "A verified + C verified" }] });
      return { role: "assistant", text: "waiter done" };
    } else if (id === jobs.reader) {
      assert.equal(model.selection, "p/code");
      if (!successful("workspace_probe")) return call("probe-in-parallel", "workspace_probe", { paths: [nested, join(cwd, "input.txt"), join(cwd, "missing")] });
      const probe = JSON.parse(receipts.findLast(message => message.name === "workspace_probe")!.text!);
      assert.equal(probe.execution, "server");
      assert.equal(probe.platform, process.platform === "win32" ? "windows" : process.platform);
      assert.equal(probe.cwd, undefined);
      assert.deepEqual(probe.directories.map((entry: any) => entry.isDir), [true, false, false]);
      if (!successful("read")) return call("read-in-parallel", "read", { path: join(cwd, "input.txt") });
      return { role: "assistant", text: "reader done" };
    } else if (id === jobs.topic) {
      assert.equal(session.cwd, cwd);
      if (!successful("write")) return call("write-worktree", "write", { path: join(worktree, "shared.txt"), content: "linked checkout" });
      return { role: "assistant", text: "topic done" };
    } else assert.equal(model.selection, "p/light");
    return task.plan?.every((step: any) => step.status === "completed") && task.plan.length
      ? call("done", "employee", { action: "complete", deliverableRef: [], text: "verified actual result", summary: "已验证。" })
      : call("plan", "employee", { action: "progress", text: "verified actual result", plan: [{ content: "verify authorized result", status: "completed" }] });
  };
  try {
    await add("writer");
    engine.employee.closed = false; await engine.employee.drain();
    await until(() => entered, "first writer holds its code phase");
    await add("reader"); await add("waiter", nested); await add("summary");
    await engine.employee.drain();
    await until(async () => (await employee.state()).tasks.find(task => task.id === jobs.waiter)?.workspaceWait && !employee.busy.has(jobs.waiter), "second writer yields instead of retrying");
    const blocked = employee.task(await employee.state(), jobs.waiter), originalSession = blocked.workSession;
    assert.equal(blocked.status, "queued");
    assert.equal(blocked.recovery, undefined);
    assert.equal(blocked.failures || 0, 0);
    assert((await store.messages(originalSession)).some(message => message.role === "tool" && message.name === "code_agent" && message.text?.includes('"status":"queued"')));
    await assert.rejects(readFile(join(nested, "stamp.txt")), { code: "ENOENT" });
    await until(async () => { const state = await employee.state(); return [jobs.reader, jobs.summary].every((id) => employee.task(state, id).status === "done"); }, "read and summary tasks finish while writer is still active");
    await add("topic"); await engine.employee.drain();
    await until(async () => (await employee.findTask(jobs.topic))?.status === "done", "sibling worktree finishes while the original checkout is still locked");
    assert.equal((await employee.findTask(jobs.topic))?.cwd, cwd);
    assert.equal(await readFile(join(worktree, "shared.txt"), "utf8"), "linked checkout");
    assert.equal(await readFile(join(cwd, "shared.txt"), "utf8"), "A verified");
    assert.equal(employee.task(await employee.state(), jobs.writer).status, "running");
    assert.equal(await readFile(join(cwd, "input.txt"), "utf8"), "read-only input");
    release();
    await until(async () => { const state = await employee.state(); return Object.values(jobs).every((id) => employee.task(state, id).status === "done") && !employee.busy.size; }, "all original jobs finish");
    assert.equal(employee.task(await employee.state(), jobs.waiter).workSession, originalSession);
    assert.equal(await readFile(join(cwd, "shared.txt"), "utf8"), "A verified + C verified");
    assert.equal(engine.employee.writers.size, 0);
    assert.equal((await store.sessions()).filter(s => !s.phaseRole).length, 5);
    const writerPhases = (await store.sessionsByStageSource(employee.task(await employee.state(), jobs.writer).workSession)).filter(s => s.phaseRole === "code_agent");
    assert.equal(writerPhases.length, 1);
    assert.equal((await store.messages(writerPhases[0].id)).filter(message => message.role === "tool" && message.name === "write").length, 1);
    const waiterStageMsgs = (await Promise.all((await store.sessionsByStageSource(originalSession)).map(s => store.messages(s.id)))).flat();
    const waiterTools = waiterStageMsgs.filter(message => message.role === "tool");
    assert.equal(waiterTools.filter(message => message.name === "edit").length, 1);
    assert.equal(waiterTools.filter(message => message.name === "bash").length, 1);
    await assert.rejects(readFile(join(nested, "stamp.txt")), { code: "ENOENT" });
  } finally {
    engine.employee.closed = true; release(); await engine.close();
    for (let index = 0; index < 100 && employee.busy.size; index++) await sleep(5);
    await store.close();
  }
});
