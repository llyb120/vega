import { createHash } from "node:crypto";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Store } from "../server/core/store";
import { Context, parseStage } from "../server/core/context";
import { mutate } from "../server/core/tools";
import { Vault } from "../server/core/vault";
import {
  Employee,
  applyDuty,
  nextFixed,
  retention,
  recallMemory,
  workSlot,
  type EmployeeRuntime,
} from "../server/core/employee";
import { Experiences } from "../server/core/experiences";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Chrome } from "../server/core/chrome";
import { Engine, dependencies } from "../server/core/engine";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
const cleanup: (() => Promise<any> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "vega-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function store() {
  const s = await Store.open(":memory:");
  cleanup.push(async () => await s.close());
  return s;
}
async function employee(given?: Store) {
  const s = given || await store();
  const vault = new Vault(s);
  let instance: Employee;
  const runtime: EmployeeRuntime = {
    run: async () => {},
    cancel: () => {},
    isRunning: () => false,
    emit: () => {},
    config: () => ({}),
  };
  instance = new Employee(s, vault, runtime);
  instance.closed = true;
  cleanup.push(() => instance.close());
  return instance;
}
async function engine() {
  const s = await store(),
    auth = new Subscriptions(s, ""),
    catalog = new Catalog(s, auth),
    bridge = new ChromeBridge(),
    chrome = new Chrome(
      s,
      bridge,
      readFileSync(
        new URL("../server/assets/browser/browser-page.js", import.meta.url),
        "utf8",
      ),
    );
  const e = await Engine.create(s, catalog, chrome);
  e.employee.closed = true;
  cleanup.push(() => e.close());
  return e;
}
async function http(handler: any) {
  const server = createServer(handler);
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  cleanup.push(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
export function completion(res: any, data: any) {
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: data, finish_reason: data.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
export const toolCall = (id: string, name: string, args: any) => ({
  index: 0,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const cfg = (url: string) => ({
  scenes: { lightweight: ["test/m"], coding: ["test/m"], computer: ["test/m"] },
  model: "test/m",
  provider: {
    test: {
      api: "openai-completions",
      baseURL: url,
      models: {
        m: {
          limit: { context: 128000, output: 1000 },
          modalities: { input: ["text", "image"] },
        },
      },
    },
  },
  contextMode: "acp",
});
test("SQLite reopen, independent Stage history, current source timeline", async () => {
  const dir = await temp(),
    path = join(dir, "db");
  let s = await Store.open(path);
  const first = await s.newSession({ cwd: dir, model: "p/m" });
  await s.append(first.id, { role: "user", text: "one" });
  await s.append(first.id, { role: "assistant", text: "done" });
  const stage = await s.stage(first.id);
  assert.equal(stage.model, undefined);
  assert.equal(stage.cwd, first.cwd);
  await s.close();
  s = await Store.open(path);
  cleanup.push(async () => await s.close());
  assert.equal((await s.messages(stage.id)).length, 0);
  await s.append(first.id, { role: "user", text: "latest requirement" });
  assert.match(await (await Context.open(s, first.id)).stage(), /latest requirement/);
  assert.deepEqual((await s.sessionFamily(first.id)).map((v) => v.id).sort(), [first.id, stage.id].sort());
  await s.deleteSession(first.id);
  await assert.rejects(async () => await s.session(stage.id), /Session not found/);
  assert.equal((await s.messages(stage.id)).length, 0);
});
test("exact edits reject ambiguous/overlap without modifying file", async () => {
  const dir = await temp(),
    path = join(dir, "a");
  await writeFile(path, "alpha beta gamma");
  await assert.rejects(() =>
    mutate(dir, "edit", {
      path: "a",
      edits: [
        { oldText: "alpha", newText: "A" },
        { oldText: "absent", newText: "x" },
      ],
    }),
  );
  assert.equal(await readFile(path, "utf8"), "alpha beta gamma");
  await assert.rejects(() =>
    mutate(dir, "edit", {
      path: "a",
      edits: [
        { oldText: "alpha beta", newText: "a" },
        { oldText: "beta gamma", newText: "b" },
      ],
    }),
  );
  await mutate(dir, "edit", {
    path: "a",
    edits: [
      { oldText: "alpha", newText: "A" },
      { oldText: "gamma", newText: "G" },
    ],
  });
  assert.equal(await readFile(path, "utf8"), "A beta G");
});
test("nested context blocks are reversible and preserve original users", async () => {
  const s = await store(),
    session = await s.newSession(),
    ctx = await Context.open(s, session.id);
  for (let i = 0; i < 24; i++)
    await s.append(session.id, {
            role: i % 2 ? "assistant" : "user",
            text:
              i % 2
                ? "original " + i + " " + "finished evidence ".repeat(200)
                : "original " + i,
          });
  const one = (await ctx.compress([
      {
        startRef: "m00001",
        endRef: "m00007",
        summary:
          "First work finished; original requirements, evidence and decisions remain recoverable.",
      },
    ]))[0];
  const two = (await ctx.compress([
      {
        startRef: one.id,
        endRef: "m00011",
        summary:
          "Combined finished work; preserve all remaining decisions and original requirements.",
      },
    ]))[0];
  await ctx.decompress(two.id);
  assert((await ctx.folds()).find((f) => f.id === one.id)?.active);
  await ctx.decompress(one.id);
  assert.equal((await ctx.view()).length, 24);
  await assert.rejects(async () =>
    await ctx.compress([{ startRef: "m00020", endRef: "m00024", summary: "bad" }]),
  );
  assert.equal((await s.messages(session.id)).length, 24);
});
test("context protects tool pairs and current turn", async () => {
  const s = await store(),
    session = await s.newSession(),
    ctx = await Context.open(s, session.id);
  await s.append(session.id, {
        role: "assistant",
        calls: [{ id: "c", name: "read", arguments: {} }],
      });
  await s.append(session.id, { role: "tool", callId: "c", text: "done" });
  for (let i = 0; i < 10; i++)
    await s.append(session.id, { role: "user", text: "next" });
  await assert.rejects(async () =>
    await ctx.compress([{ startRef: "m00001", endRef: "m00001", summary: "split" }]),
  );
  assert.deepEqual(parseStage("one /stage2 two"), {
    current: "one",
    prompt: "two",
    index: 1,
  });
  assert.throws(() => parseStage("/stage0 bad"));
  assert.throws(() => parseStage("/stage"));
  assert.equal(parseStage("path/stage.txt"), null);
});
test("employee task permissions, key dedup, approval reuses original sessions", async () => {
  const e = await employee();
  const d = await e.execute("", {
    action: "add",
    kind: "duty",
    text: "workflow",
    manual: true,
  });
  await e.update((s) =>
        s.tasks.push({
          id: "task",
          text: "work",
          status: "running",
          createdAt: Date.now(),
          profile: "lightweight",
          cwd: process.cwd(),
          owner: { token: "", name: "" },
          dutyId: d.value.id,
          workSession: "original",
        }),
      );
  e.busy.set("task", { computer: false, session: "original" });
  await assert.rejects(() =>
    e.execute("task", { action: "update", id: d.value.id, text: "hijacked" }),
  );
  await assert.rejects(() =>
    e.execute("task", { action: "done", id: d.value.id }),
  );
  const pause = await e.execute("task", {
    action: "ask",
    text: "approve exact operation",
  });
  assert(pause.stop);
  e.busy.clear();
  await e.control({ action: "approve", id: "task", approved: true });
  const task = (await e.state()).tasks.find((t) => t.id === "task")!;
  assert.equal(task.status, "queued");
  assert.equal(task.workSession, "original");
  const a = await e.execute("", {
      action: "add",
      kind: "todo",
      key: "tapd:1",
      text: "one",
    }),
    b = await e.execute("", {
      action: "add",
      kind: "todo",
      key: "tapd:1",
      text: "two",
    });
  assert.equal(a.value.id, b.value.id);
  assert(b.value.exists);
});
test("duty validation, manual scheduling and removed Orbit do not trigger work", async () => {
  const e = await employee(),
    now = Date.now();
  for (const a of [
    { times: ["25:00"] },
    { times: ["09:00"], everyMinutes: 1 },
    { manual: true, events: ["orbit.added"] },
    { nextAt: "2000-01-01 00:00" },
    { everyMinutes: 0.5 },
  ])
    assert.throws(() => applyDuty({ text: "work" }, a));
  await assert.rejects(() =>
    e.execute("", {
      action: "add",
      kind: "duty",
      text: "removed event",
      events: ["orbit.changed"],
    }),
  );
  await assert.rejects(() =>
    e.execute("", { action: "orbit_add", text: "not available" }),
  );
  const d = await e.execute("", {
    action: "add",
    kind: "duty",
    text: "manual workflow",
    manual: true,
  });
  await e.update((s) => {
        s.enabled = true;
        s.workStart = s.workEnd = "00:00";
      });
  e.closed = false;
  await e.tick();
  assert.equal((await e.state()).tasks.length, 0);
  e.close();
  const manual = {
    id: "manual",
    text: "m",
    manual: false,
    everyMinutes: 5,
    times: ["09:00"],
    events: ["orbit.added"],
    nextCheckAt: 9,
  };
  applyDuty(manual, { manual: true }, now);
  assert.equal(manual.everyMinutes, 0);
  assert.deepEqual(manual.times, []);
  assert(
    workSlot("22:00", "06:00", Date.parse("2026-02-01T23:00:00+08:00")) ===
      Date.parse("2026-02-01T23:00:00+08:00"),
  );
});
test("memory relevance floor, migration and feedback-driven usefulness", () => {
  const now = Date.now();
  const state: any = {
    memories: [
      { id: "perm", text: "午餐偏好麻辣烫", importance: 3, at: now - 40 * 86400000 },
      { id: "lunch", text: "食堂周五供应麻辣烫", importance: 1, at: now - 40 * 86400000 },
      { id: "code", text: "长期项目使用TS", importance: 2, strength: 1, at: now - 3 * 86400000, usedAt: now - 3 * 86400000 },
    ],
  };
  const result = recallMemory(state, "长期项目使用TS", now, true);
  assert(result.some((m: any) => m.id === "code"));
  assert(result.some((m: any) => m.id === "perm"), "standing preferences are injected regardless of relevance");
  assert(!result.some((m: any) => m.id === "lunch"), "unrelated ordinary facts stay behind the relevance floor");
  assert.equal(state.memories.find((m: any) => m.id === "code").claim, "长期项目使用TS");
  assert(state.memories.find((m: any) => m.id === "code").usefulness > 0.3);
  assert.equal(retention(state.memories.find((m: any) => m.id === "perm"), now), 1);
});
test("experience routes dedup wording, share only identical prefixes and fail closed on scope", async () => {
  const e = new Experiences(await store()),
    a = {
      operation: "experience_save",
      snapshotId: "s",
      experience: {
        scope: "https://a.test",
        task: "导出报表",
        conditions: ["已登录"],
        steps: ["打开 报表", "点击导出"],
        checks: ["下载完成"],
        pitfalls: [],
        outcome: "success",
        evidence: "完成",
        redacted: true,
      },
    };
  const first: any = await e.execute("one", a, { id: "s", origin: "https://a.test" });
  a.experience.steps = ["打开报表。", "点击 导出"];
  const again: any = await e.execute("two", a, { id: "s", origin: "https://a.test" });
  assert.equal(first.experience.id, again.experience.id);
  assert.equal(again.experience.confidence, "reused");
  await assert.rejects(async () =>
    await e.execute("one", a, { id: "s", origin: "https://b.test" }),
  );
  assert(await e.hint("one", "https://a.test"));
  assert.equal(await e.hint("one", "https://a.test"), undefined);
  const result = await e.execute("one", {
      operation: "experience_search",
      experience: { scope: "https://a.test", task: "*" },
    });
  assert.equal(result.totalRoutes, 1);
  assert.equal(result.graph.roots.length, 1);
});
test("agent retries provider only, shares scene history, leaves one side effect", async () => {
  let n = 0;
  const url = await http((req: any, res: any) => {
    const chunks: any[] = [];
    req.on("data", (c: any) => chunks.push(c));
    req.on("end", () => {
      n++;
      if (n === 1)
        completion(res, {
          tool_calls: [
            toolCall("c", "write", { path: "once", content: "done" }),
          ],
        });
      else if (n === 2) {
        res.writeHead(503);
        res.end("temporary");
      } else completion(res, { content: "finished" });
    });
  });
  const e = await engine(),
    dir = await temp();
  await e.store.put("config", cfg(url));
  const session = await e.store.newSession({ cwd: dir });
  let starts = 0;
  e.events.on("event", (event) => {
    if (event.type === "tool_start") starts++;
  });
  await e.run(session.id, { role: "user", text: "work" });
  assert.equal(starts, 1);
  assert.equal(n, 3);
  assert.equal(await readFile(join(dir, "once"), "utf8"), "done");
  assert.deepEqual(dependencies("[1]", 1), [0]);
  assert.throws(() => dependencies([2], 1));
});
test("Go backup record and byte-identical vendored source digests are portable", async () => {
  assert(
    readFileSync("reference/source-manifest.json", "utf8").includes(
      "vega-go-backup-20261030-202628",
    ),
  );
  const manifest = JSON.parse(
    readFileSync("reference/ported-assets.json", "utf8"),
  );
  for (const record of manifest) {
    const hash = createHash("sha256")
      .update(await readFile(record.path))
      .digest("hex")
      .toUpperCase();
    assert.equal(
      hash,
      record.sha256,
      `Vendored source changed: ${record.path}`,
    );
  }
});
