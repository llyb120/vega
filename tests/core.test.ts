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
function store() {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  return s;
}
function employee(s = store()) {
  const vault = new Vault(s);
  let instance: Employee;
  const runtime: EmployeeRuntime = {
    run: async () => {},
    cancel: () => {},
    isRunning: () => false,
    emit: () => {},
    send: async () => {},
    config: () => ({}),
  };
  instance = new Employee(s, vault, runtime);
  instance.closed = true;
  cleanup.push(() => instance.close());
  return instance;
}
function engine() {
  const s = store(),
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
  const e = new Engine(s, catalog, chrome);
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
  let s = new Store(path);
  const first = s.newSession({ cwd: dir, model: "p/m" });
  s.append(first.id, { role: "user", text: "one" });
  s.append(first.id, { role: "assistant", text: "done" });
  const stage = s.stage(first.id);
  assert.equal(stage.model, undefined);
  assert.equal(stage.cwd, first.cwd);
  s.close();
  s = new Store(path);
  cleanup.push(() => s.close());
  assert.equal(s.messages(stage.id).length, 0);
  s.append(first.id, { role: "user", text: "latest requirement" });
  assert.match(new Context(s, first.id).stage(), /latest requirement/);
  assert.deepEqual(s.sessionFamily(first.id).map((v) => v.id).sort(), [first.id, stage.id].sort());
  s.deleteSession(first.id);
  assert.throws(() => s.session(stage.id), /Session not found/);
  assert.equal(s.messages(stage.id).length, 0);
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
  const s = store(),
    session = s.newSession(),
    ctx = new Context(s, session.id);
  for (let i = 0; i < 24; i++)
    s.append(session.id, {
      role: i % 2 ? "assistant" : "user",
      text:
        i % 2
          ? "original " + i + " " + "finished evidence ".repeat(200)
          : "original " + i,
    });
  const one = ctx.compress([
    {
      startRef: "m00001",
      endRef: "m00007",
      summary:
        "First work finished; original requirements, evidence and decisions remain recoverable.",
    },
  ])[0];
  const two = ctx.compress([
    {
      startRef: one.id,
      endRef: "m00011",
      summary:
        "Combined finished work; preserve all remaining decisions and original requirements.",
    },
  ])[0];
  ctx.decompress(two.id);
  assert(ctx.folds().find((f) => f.id === one.id)?.active);
  ctx.decompress(one.id);
  assert.equal(ctx.view().length, 24);
  assert.throws(() =>
    ctx.compress([{ startRef: "m00020", endRef: "m00024", summary: "bad" }]),
  );
  assert.equal(s.messages(session.id).length, 24);
});
test("context protects tool pairs and current turn", () => {
  const s = store(),
    session = s.newSession(),
    ctx = new Context(s, session.id);
  s.append(session.id, {
    role: "assistant",
    calls: [{ id: "c", name: "read", arguments: {} }],
  });
  s.append(session.id, { role: "tool", callId: "c", text: "done" });
  for (let i = 0; i < 10; i++)
    s.append(session.id, { role: "user", text: "next" });
  assert.throws(() =>
    ctx.compress([{ startRef: "m00001", endRef: "m00001", summary: "split" }]),
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
  const e = employee();
  const d = await e.execute("", {
    action: "add",
    kind: "duty",
    text: "workflow",
    manual: true,
  });
  e.update((s) =>
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
  const task = e.state().tasks.find((t) => t.id === "task")!;
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
  const e = employee(),
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
  e.update((s) => {
    s.enabled = true;
    s.workStart = s.workEnd = "00:00";
  });
  e.closed = false;
  await e.tick();
  assert.equal(e.state().tasks.length, 0);
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
test("memory forgetting, permanent retention and relevant reinforcement", () => {
  const e = employee(),
    now = Date.now();
  const state = e.state();
  state.memories = [
    {
      id: "old",
      text: "obsolete",
      at: now - 40 * 86400000,
      importance: 1,
      strength: 1,
    },
    {
      id: "keep",
      text: "长期项目使用Go",
      at: now - 1000 * 86400000,
      importance: 3,
      strength: 1,
    },
    {
      id: "related",
      text: "长期项目使用TS",
      at: now,
      importance: 1,
      strength: 1,
    },
  ];
  const result = recallMemory(state, "长期项目使用TS", now);
  assert.equal(result.length, 2);
  assert.equal(state.memories[1].strength, 2);
  assert.equal(retention(state.memories[0], now), 1);
});
test("vault AES-GCM/X25519 matches original wire format and task-limited temporary entries", () => {
  const s1 = store(),
    s2 = store(),
    a = new Vault(s1),
    b = new Vault(s2);
  const entry = a.save({
    name: "service",
    condition: "authorized use",
    content: "super-secret",
    share: true,
  }).id;
  const pk = b.request("req"),
    sealed = a.sealFor(entry, "req", pk),
    received = b.receive("req", "test task", sealed.sealed);
  assert.throws(() => b.get(received.id, "purpose", "another-task"));
  assert.equal(b.get(received.id, "purpose", "req").content, "super-secret");
  assert(!JSON.stringify(a.list()).includes("super-secret"));
  b.dropTemp("req");
  assert.equal(b.list().length, 0);
  assert.throws(() => b.receive("req", "task", sealed.sealed));
  assert(!JSON.stringify(s1.objects("vault")).includes("super-secret"));
});
test("experience routes dedup wording, share only identical prefixes and fail closed on scope", () => {
  const e = new Experiences(store()),
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
  const first: any = e.execute("one", a, { id: "s", origin: "https://a.test" });
  a.experience.steps = ["打开报表。", "点击 导出"];
  const again: any = e.execute("two", a, { id: "s", origin: "https://a.test" });
  assert.equal(first.experience.id, again.experience.id);
  assert.equal(again.experience.confidence, "reused");
  assert.throws(() =>
    e.execute("one", a, { id: "s", origin: "https://b.test" }),
  );
  assert(e.hint("one", "https://a.test"));
  assert.equal(e.hint("one", "https://a.test"), undefined);
  const result = e.execute("one", {
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
  const e = engine(),
    dir = await temp();
  e.store.put("config", cfg(url));
  const session = e.store.newSession({ cwd: dir });
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
