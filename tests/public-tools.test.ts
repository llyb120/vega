import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Tools } from "../server/core/tools";
import {
  ArgumentError, BROWSER_TOOLS, CHROME_TOOL_DEFINITIONS, STANDALONE_TOOLS, checkArgs, employeeTools, toInternal, vaultTools, type ToolContext,
} from "../server/core/public-tools";

const all = (ctx: ToolContext) => [...employeeTools(ctx), ...vaultTools(ctx), ...CHROME_TOOL_DEFINITIONS];
const schemaOf = (name: string, ctx: ToolContext) => {
  const tool = all(ctx).find((t) => t.name === name);
  assert(tool, `${name} visible in ${JSON.stringify(ctx)}`);
  return tool.parameters;
};
const map = (name: string, args: any, ctx: ToolContext = { kind: "normal" }) => toInternal(name, checkArgs(schemaOf(name, ctx), args), ctx);
const task: ToolContext = { kind: "task" };
const chat: ToolContext = { kind: "chat" };

test("every public tool maps onto the unchanged internal executor arguments", () => {
  const cases: [string, any, any, ToolContext?][] = [
    ["browser_tabs", { action: "list", query: "jira" }, { operation: "browser_tabs", action: "list", query: "jira" }],
    ["browser_tabs", { action: "list", incognito: false }, { operation: "browser_tabs", action: "list", incognito: false }],
    ["browser_tabs", { action: "open", url: "https://a.test" }, { operation: "browser_tabs", action: "open", url: "https://a.test" }],
    ["browser_tabs", { action: "open", url: "https://a.test", incognito: true }, { operation: "browser_tabs", action: "open", url: "https://a.test", incognito: true }],
    ["browser_tabs", { action: "goto", tab: "C1", url: "https://a.test" }, { operation: "browser_tabs", action: "goto", tab: "C1", url: "https://a.test" }],
    ["browser_tabs", { action: "switch", tab: "C1" }, { operation: "browser_tabs", action: "switch", tab: "C1" }],
    ["browser_tabs", { action: "close", tab: "C1" }, { operation: "browser_tabs", action: "close", tab: "C1" }],
    ["browser_tabs", { action: "reload", tab: "C1" }, { operation: "browser_tabs", action: "reload", tab: "C1" }],
    ["browser_tabs", { action: "back", tab: "C1", view: false }, { operation: "browser_tabs", action: "back", tab: "C1", view: false }],
    ["browser_view", { tab: "C1", scope: "viewport", screenshot: false, maxItems: 3, maxTextChars: 60 },
      { operation: "browser_view", tab: "C1", scope: "viewport", screenshot: false, maxItems: 3, maxTextChars: 60 }],
    ["browser_view", { tab: "C1", zoom: { id: 2 } }, { operation: "browser_view", tab: "C1", zoom: { id: 2 } }],
    ["browser_view", { tab: "C1", zoom: { x: 0, y: 0, width: 100, height: 80 } }, { operation: "browser_view", tab: "C1", zoom: { x: 0, y: 0, width: 100, height: 80 } }],
    ["browser_act", { tab: "C1", screenshot: false, notes: "test", steps: [
      { op: "click", id: 1, clicks: 2 },
      { op: "type", id: 2, text: "hi", clear: true, submit: true },
      { op: "hover", x: 10, y: 20 },
      { op: "drag", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 240 },
      { op: "scroll", dy: 300, dx: 0 },
      { op: "press", key: "Enter" },
      { op: "dismiss" },
      { op: "wait", ms: 0 },
      { op: "upload", selector: "#f", files: ["a.png"] },
    ] }, {
      operation: "browser_act", tab: "C1", screenshot: false, notes: "test", steps: [
        { op: "click", id: 1, clicks: 2 },
        { op: "type", id: 2, text: "hi", clear: true, submit: true },
        { op: "hover", x: 10, y: 20 },
        { op: "drag", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 240 },
        { op: "scroll", dy: 300, dx: 0 },
        { op: "press", key: "Enter" },
        { op: "dismiss" },
        { op: "wait", ms: 0 },
        { op: "upload", selector: "#f", files: ["a.png"] },
      ],
    }],
    ["browser_eval", { tab: "C1", code: "1", view: false }, { operation: "browser_eval", tab: "C1", code: "1", view: false }],
    ["browser_eval", { tab: "C1", code: "document.title" }, { operation: "browser_eval", tab: "C1", code: "document.title" }],
    ["browser_debug", { kind: "console", tab: "C1", level: "error", limit: 50 }, { operation: "browser_debug", kind: "console", tab: "C1", level: "error", limit: 50 }],
    ["browser_debug", { kind: "network", tab: "C1", requestId: "r1" }, { operation: "browser_debug", kind: "network", tab: "C1", requestId: "r1" }],
    ["browser_debug", { kind: "downloads", since: 0 }, { operation: "browser_debug", kind: "downloads", since: 0 }],
    ["browser_experience", { action: "search", scope: "https://example.com", task: "*" }, { operation: "browser_experience", action: "search", scope: "https://example.com", task: "*" }],
    ["employee_status", {}, { action: "list" }],
    ["employee_status", { memoryQuery: "部署" }, { action: "list", query: "部署" }],
    ["employee_status", { taskId: "t1" }, { action: "list", id: "t1" }],
    ["employee_status", { dedupeKey: "tapd:1", status: "active" }, { action: "list", key: "tapd:1", status: "active" }],
    ["employee_status", { status: "all" }, { action: "list" }],
    ["employee_task_create", { instructions: "x", profile: "编码" }, { action: "add", kind: "todo", text: "x", profile: "编码" }],
    ["employee_task_manage", { taskId: "t1", request: { command: "update", instructions: "new", profile: "轻量化", delayMinutes: 5 } }, { action: "update", id: "t1", text: "new", profile: "轻量化", nextCheckInMinutes: 5 }],
    ["employee_task_manage", { taskId: "t1", request: { command: "update", profile: "coding", runAt: null } }, { action: "update", id: "t1", profile: "coding" }],
    ["employee_task_create", { instructions: "do it", dedupeKey: "k", runAt: "2030-01-01 09:00" }, { action: "add", kind: "todo", text: "do it", key: "k", nextAt: "2030-01-01 09:00" }],
    ["employee_task_create", { instructions: "later", delayMinutes: 30, profile: "coding" }, { action: "add", kind: "todo", text: "later", nextCheckInMinutes: 30, profile: "coding" }],
    ["employee_task_create", { instructions: "now" }, { action: "add", kind: "todo", text: "now" }],
    ["employee_task_manage", { taskId: "t1", request: { command: "reschedule", runAt: "2030-01-01 09:00" } }, { action: "update", id: "t1", nextAt: "2030-01-01 09:00" }],
    ["employee_task_manage", { taskId: "t1", request: { command: "reschedule", delayMinutes: 60 } }, { action: "update", id: "t1", nextCheckInMinutes: 60 }],
    ["employee_task_manage", { taskId: "t1", request: { command: "set_profile", profile: "lightweight" } }, { action: "update", id: "t1", profile: "lightweight" }],
    ["task_reschedule", { delayMinutes: 120 }, { action: "update", id: "self", nextCheckInMinutes: 120 }, { ...task, taskId: "self" }],
    ["task_reschedule", { runAt: "2030-01-01 09:00" }, { action: "update", id: "self", nextAt: "2030-01-01 09:00" }, { ...task, taskId: "self" }],
    ["employee_task_manage", { taskId: "t1", request: { command: "cancel" } }, { action: "done", id: "t1" }],
    ["employee_task_manage", { taskId: "t1", request: { command: "resume" } }, { action: "resume", id: "t1" }, chat],
    ["employee_task_manage", { taskId: "t1", request: { command: "answer", answer: "yes" } }, { action: "answer", id: "t1", text: "yes" }, chat],
    ["employee_task_manage", { taskId: "t1", request: { command: "stop" } }, { action: "stop", id: "t1" }, chat],
    ["task_progress", { message: "m", plan: [{ content: "a", status: "completed" }] }, { action: "progress", text: "m", plan: [{ content: "a", status: "completed" }] }, task],
    ["task_request_approval", { request: "pay" }, { action: "ask", text: "pay" }, task],
    ["task_ask_user", { question: "code?" }, { action: "help", text: "code?" }, task],
    ["task_wait", { checkpoint: "job 1", delayMinutes: 5 }, { action: "defer", text: "job 1", nextCheckInMinutes: 5 }, task],
        ["task_complete", { evidence: "ok", deliverableRefs: [] }, { action: "complete", text: "ok", deliverableRef: [] }, task],
    ["task_complete", { evidence: "ok", outlineReview: [{ requirement: "test", status: "met", evidence: "receipt" }] }, { action: "complete", text: "ok", outlineReview: [{ requirement: "test", status: "met", evidence: "receipt" }] }, task],
    ["task_complete", { outlineReviewRetry: "r1", outlineReview: [{ requirement: "later", status: "met", evidence: "receipt" }] }, { action: "complete", outlineReviewRetry: "r1", outlineReview: [{ requirement: "later", status: "met", evidence: "receipt" }] }, task],
    ["task_complete", { outlineReviewRetry: "r1", outlineReview: [{ changedStep: 1, status: "met", evidence: "receipt" }] }, { action: "complete", outlineReviewRetry: "r1", outlineReview: [{ changedStep: 1, status: "met", evidence: "receipt" }] }, task],
    ["memory_propose", { claim: "c", memoryKind: "convention" }, { action: "memory_propose", claim: "c", memoryKind: "convention" }, chat],
    ["memory_propose", { claim: "c", pinned: true, memoryKind: null }, { action: "memory_propose", claim: "c", pinned: true }, chat],
    ["memory_manage", { request: { command: "feedback", memoryId: "a", signal: "correction", claim: "new" } }, { action: "memory_resolve", resolveAction: "feedback", id: "a", signal: "correction", claim: "new" }, chat],
    ["memory_manage", { request: { command: "merge", memoryIds: ["a", "b"] } }, { action: "memory_resolve", resolveAction: "merge", ids: ["a", "b"] }, chat],
    ["memory_manage", { request: { command: "forget", memoryId: "a" } }, { action: "memory_resolve", resolveAction: "drop", id: "a" }, chat],
    ["memory_manage", { request: { command: "unpin", memoryId: "a" } }, { action: "memory_pin", id: "a", pinned: false }, chat],
    ["vault_get", { credentialId: "v1", purpose: "login" }, { action: "vault_get", id: "v1", text: "login" }, task],
  ];
  for (const [name, args, internal, ctx] of cases)
    assert.deepEqual(map(name, args, ctx).args, internal, name + " " + JSON.stringify(args));
  assert.throws(() => map("task_complete", { summary: "no evidence" }, task), /缺少必填字段 evidence/);
  assert.deepEqual(map("vault_get", { credentialId: "v1", purpose: "login" }, chat), { tool: "employee", args: { action: "vault_get", id: "v1", text: "login" } }, "an employee chat reads its own vault through the employee executor");
  assert.equal(map("employee_task_manage", { taskId: "t1", request: { command: "cancel" } }).target, "task");
});

test("memory source is decided by the server and memory_manage requires an explicit command", () => {
  assert.throws(() => map("memory_propose", { claim: "c", memoryKind: "convention", source: "ui" }, chat), /不接受字段 source/);
  assert.throws(() => map("memory_propose", { claim: "c", memoryKind: "guess" }, chat), /memoryKind/);
  assert.throws(() => map("memory_manage", { request: { memoryId: "a" } }, chat), ArgumentError);
});

test("schema errors catch invalid browser arguments before any browser work", () => {
  assert.throws(() => map("browser_tabs", { action: "elsewhere" }), /参数\.action 只能是/);
  assert.throws(() => map("browser_act", { tab: "C1", steps: [{ op: "click", x: -1, y: 0 }] }), /x/);
  assert.throws(() => map("browser_view", { tab: "C1", zoom: { x: 0, y: 0, width: 0, height: 10 } }), /width 必须大于 0/);
  assert.throws(() => map("browser_view", { tab: "C1", scope: "invalid" }), /参数\.scope 只能是/);
  assert.throws(() => map("browser_view", { tab: "C1", unknown: true }), /不接受字段 unknown/);
  assert.throws(() => map("task_wait", { checkpoint: "x" }, task), /resumeAt 和 参数\.delayMinutes 必须恰好填一个/);
  assert.throws(() => map("task_wait", { checkpoint: "x", delayMinutes: 5, resumeAt: "2030-01-01 09:00" }, task), /恰好填一个/);
  assert.throws(() => map("employee_task_create", { instructions: "x", runAt: "tomorrow 9am" }), /runAt 至少 16 个字符|runAt 格式不对/);
  const self = { ...task, taskId: "self" };
  assert.throws(() => map("task_reschedule", {}, self), /runAt 和 参数\.delayMinutes 必须恰好填一个/);
  assert.throws(() => map("task_reschedule", { runAt: "2030-01-01 09:00", delayMinutes: 5 }, self), /恰好填一个/);
  assert.throws(() => map("task_reschedule", { delayMinutes: 5, taskId: "other" }, self), /不接受字段 taskId/, "a task can only reschedule itself");
  assert.throws(() => map("employee_task_create", { instructions: "x", runAt: "2030-01-01 09:00", delayMinutes: 5 }), /最多填一个/);
  assert.throws(() => map("employee_task_manage", { taskId: "t1", request: { command: "reschedule" } }), /request\.runAt 和 参数\.request\.delayMinutes 必须恰好填一个/);
  assert.throws(() => map("employee_task_create", { instructions: "x", profile: "computer" }), /profile/);
  assert.throws(() => map("employee_task_create", { instructions: "x", profile: "电脑" }), /profile/, "computer work uses switch_scene, not a task profile");
  assert.throws(() => map("employee_task_manage", { taskId: "t1", request: { command: "update" } }), /至少要改一项/);
  assert.throws(() => map("employee_task_manage", { taskId: "t1", request: { command: "update", runAt: "2030-01-01 09:00", delayMinutes: 5 } }), /恰好填一个/);
});

test("narrow fallback: only null or an empty value its own bound rejects counts as omitted; legal '' and 0 are kept", () => {
  assert.deepEqual(map("browser_debug", { kind: "downloads", downloadId: "", since: 0 }).args, { operation: "browser_debug", kind: "downloads", downloadId: "", since: 0 });
  assert.deepEqual(map("browser_view", { tab: "C1", query: null, maxItems: 0 }).args, { operation: "browser_view", tab: "C1" });
  assert.deepEqual(map("memory_propose", { claim: "c", evidence: "" }, chat).args.evidence, "");
  const act = map("browser_act", { tab: "C1", steps: [{ op: "scroll", x: 0, y: 0, dy: 0 }] }).args;
  assert.deepEqual(act.steps, [{ op: "scroll", x: 0, y: 0, dy: 0 }]);
  assert.deepEqual(map("browser_tabs", { action: "list", incognito: false }).args, { operation: "browser_tabs", action: "list", incognito: false }, "false is a real filter, never dropped");
  assert.throws(() => map("browser_eval", { code: "" }), /code/, "an empty required minLength string is rejected");
});

test("a whole-schema default fill is rejected before any browser or employee side effect", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  let browser = 0, employee = 0;
  const session = await store.newSession({ scene: "computer" });
  const engine = {
    store, vault: new Vault(store), mcpFor: () => ({}),
    chromeFor: async () => { browser++; throw Error("must not reach Chrome"); },
    employeeFor: () => { employee++; throw Error("must not reach the employee"); },
  } as any;
  const tools = await Tools.create(engine, session, { model: "", provider: {} } as any, new AbortController().signal, () => {});
  const filled = { tab: "C1", steps: [{ op: "click", id: 1, button: "", unexpected: 1 }] };
  await assert.rejects(tools.execute({ id: "a", name: "browser_act", arguments: filled }, {} as any), ArgumentError);
  await assert.rejects(tools.execute({ id: "b", name: "browser_tabs", arguments: { action: "open", url: "https://a.test", extra: true } }, {} as any), /不接受字段 extra/);
  await assert.rejects(tools.execute({ id: "c", name: "employee_task_manage", arguments: { taskId: "t1", request: { command: "reschedule", runAt: "", instructions: "" } } }, {} as any), ArgumentError);
  assert.equal(browser, 0);
  assert.equal(employee, 0);
});

test("visible tools and branches follow session, scene and permission like the old definitions", () => {
  const names = (ctx: ToolContext) => [...employeeTools(ctx), ...vaultTools(ctx)].map((t) => t.name).sort();
  const commands = (ctx: ToolContext, tool: string) => JSON.stringify(employeeTools(ctx).find((t) => t.name === tool)?.parameters).match(/"enum":\["[^\]]+"\]/g)?.join(",") || "";
  assert.deepEqual(names({ kind: "normal" }), ["employee_status", "employee_task_create", "employee_task_manage", "memory_manage", "memory_propose", "memory_search"], "a plain session belongs to no employee and has no vault");
  assert.deepEqual(names(chat).filter((name) => name.startsWith("vault_")), ["vault_get", "vault_list"]);
  assert(!commands({ kind: "normal" }, "employee_task_manage").includes("resume"), "resume/answer/stop are chat-only");
  assert(commands(chat, "employee_task_manage").includes("stop"));
  assert(names(chat).includes("memory_propose"), "owner chat exposes memory_propose");
  assert.deepEqual(names({ kind: "chat", member: true }), ["employee_status", "employee_task_create", "employee_task_manage", "vault_get", "vault_list"]);
  assert(!names({ kind: "chat", member: true }).includes("memory_propose"), "group guest has no memory tools");
  assert(!/update|set_instructions|set_profile|reschedule|cancel/.test(commands({ kind: "chat", member: true }, "employee_task_manage")));
  const main = names({ kind: "task" });
  assert.deepEqual(main, ["employee_status", "employee_task_create", "memory_manage", "memory_propose", "memory_search", "task_ask_user", "task_complete", "task_progress", "task_request_approval", "task_reschedule", "task_wait", "vault_get", "vault_list"]);
  const computer = names({ kind: "task", computer: true });
  assert(!computer.includes("task_relay_computer") && !computer.includes("task_complete") && !main.includes("task_relay_computer"));
  assert(!main.includes("employee_duty_create") && !main.includes("employee_duty_manage"));
  for (const name of ["task_request_approval", "task_ask_user", "task_wait", "task_relay_computer", "task_complete"]) assert(STANDALONE_TOOLS.has(name));
});

test("browser definitions are a leading block of 6 tools only in eligible computer scenes; ineligible sessions get none", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  const engine = { store, vault: new Vault(store), mcpFor: () => ({}), employeeFor: async () => { throw new Error("no employee"); } } as any;
  const config = { model: "", provider: {}, scenes: { lightweight: ["p/l"], coding: ["p/c"], computer: ["p/x"] } } as any;
  const defs = async (session: any) => (await Tools.create(engine, session, config, new AbortController().signal, () => {})).definitions();
  const chrome = (list: any[]) => list.filter((d) => BROWSER_TOOLS.has(d.name));
  const expected = JSON.stringify(chrome(await defs(await store.newSession({ scene: "computer" }))));
  assert.equal(JSON.parse(expected).length, 6);
  assert.deepEqual(JSON.parse(expected).map((d: any) => d.name), CHROME_TOOL_DEFINITIONS.map((d) => d.name));
  for (const extra of [{}, { employeeId: "e", taskId: "task" }])
    for (const scene of ["lightweight", "coding", "computer"]) {
      const list = await defs(await store.newSession({ scene, ...extra }));
      if (scene !== "computer") { assert.deepEqual(chrome(list), []); continue; }
      assert.equal(JSON.stringify(chrome(list)), expected);
      assert.equal(JSON.stringify(list.slice(0, CHROME_TOOL_DEFINITIONS.length)), expected, "browser block leads the list");
    }
  assert.equal(chrome(await defs(await store.newSession({ scene: "computer", readOnly: true }))).length, 0, "read-only sessions stay without browser tools");
  assert.equal(chrome(await defs(await store.newSession({ scene: "lightweight", employeeId: "e" }))).length, 0, "employee chat stays without browser tools");
});

test("browser invocations outside the computer scene are rejected before any browser connection; computer scene runs", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  let driver = 0;
  const engine = { store, vault: new Vault(store), mcpFor: () => ({}), chromeFor: async () => { driver++; return { execute: async () => ({ connected: true }) }; } } as any;
  const config = { model: "", provider: {}, scenes: { lightweight: ["p/l"], coding: ["p/c"], computer: ["p/x"] } } as any;
  const tools = async (scene: string, cfg = config) => Tools.create(engine, await store.newSession({ scene }), cfg, new AbortController().signal, () => {});
  for (const scene of ["lightweight", "coding"]) {
    const outside = await tools(scene);
    for (const { name } of CHROME_TOOL_DEFINITIONS)
      await assert.rejects(outside.execute({ id: name, name, arguments: {} } as any, {} as any), /只能在 computer 场景执行.*browser_agent.*不是浏览器扩展故障/s, `${name} in ${scene}`);
    await assert.rejects((outside as any).chrome({ operation: "browser_debug", kind: "downloads" }), /只能在 computer 场景执行/, "internal driver entry is gated too");
  }
  assert.equal(driver, 0, "no browser was started, connected or driven");
  const unconfigured = await tools("coding", { ...config, scenes: { ...config.scenes, computer: [] } });
  await assert.rejects(unconfigured.execute({ id: "c", name: "browser_tabs", arguments: { action: "list" } } as any, {} as any), /computer 场景未配置模型/);
  assert.equal(driver, 0);
  const inside = await tools("computer");
  const result = await inside.execute({ id: "c", name: "browser_debug", arguments: { kind: "downloads" } } as any, {} as any);
  assert.deepEqual(result.value, { connected: true });
  assert.equal(driver, 1, "computer scene reaches the driver");
});

test("browser_view passes the actual tool boundary and returns JPEG/image results", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  let received: any;
  const engine = {
    store, vault: new Vault(store), mcpFor: () => ({}), taskTabs: { used() {}, opened() {} },
    chromeFor: async () => ({ execute: async (_owner: string, _cwd: string, args: any) => {
      received = args;
      return { tab: args.tab, snapshotId: "snap", images: [{ path: "fixture.jpg", mime: "image/jpeg", url: "/fixture.jpg" }] };
    } }),
  } as any;
  const session = await store.newSession({ scene: "computer" });
  const tools = await Tools.create(engine, session, { provider: {}, scenes: { computer: ["p/x"] } } as any, new AbortController().signal, () => {});
  const result = await tools.execute({ id: "shot", name: "browser_view", arguments: { tab: "C1", screenshot: true, maxItems: 3, maxTextChars: 60 } }, {} as any);
  assert.deepEqual(received, { operation: "browser_view", tab: "C1", screenshot: true, maxItems: 3, maxTextChars: 60 });
  assert.equal(result.images?.length, 1);
  assert.equal(result.images?.[0].mime, "image/jpeg");
});

test("dispatch and status descriptions steer away from copied tool names and redundant dedupe checks", () => {
  const byName = Object.fromEntries(employeeTools({ kind: "chat" }).map((t) => [t.name, t]));
  const create = byName.employee_task_create, status = byName.employee_status;
  assert.match(create.description, /不要照抄历史任务或旧记录里的工具名、动作名/);
  assert.match(create.description, /不必先查重/);
  assert.match((create.parameters as any).properties.dedupeKey.description, /重做已完成的事时用新 key/);
  assert.match(status.description, /自动去重/);
  assert.deepEqual(Object.keys((status.parameters as any).properties), ["taskId", "dedupeKey", "status", "memoryQuery"]);
});

test("memory prompt: tool-list gate and owner remember-now rule", async () => {
  const { readFileSync } = await import("node:fs");
  const prompt = readFileSync("server/core/prompt.ts", "utf8");
  assert.match(prompt, /以本轮工具列表为准：有 memory_propose 就能写/);
  assert.match(prompt, /归属用户要求记住的跨会话偏好或事实/);
  assert.match(prompt, /记忆工具仍按本轮列表使用/);
  assert(!/schema 无记忆写入权限/.test(prompt));
});

test("dispatch and task deliverable descriptions reinforce built-in preview/file hosting and auth boundaries", () => {
  const chatByName = Object.fromEntries(employeeTools({ kind: "chat" }).map((t) => [t.name, t]));
  const taskByName = Object.fromEntries(employeeTools({ kind: "task" }).map((t) => [t.name, t]));
  assert.match(chatByName.employee_task_create.description, /平台已内置/);
  assert.match(chatByName.employee_task_create.description, /不要把自起本地端口服务/);
  const completePreviewDesc = (taskByName.task_complete.parameters as any).properties.preview.description;
  assert.match(completePreviewDesc, /直接用此字段交付或发布静态网页/);
  assert.match(completePreviewDesc, /勿在执行环境自起常驻服务替代/);
  const stepPreviewDesc = (taskByName.task_progress.parameters as any).properties.stepOutput.properties.preview.description;
  assert.match(stepPreviewDesc, /task_complete\.preview/);
  assert.match(stepPreviewDesc, /勿用无登录态浏览器猜测域名访问/);
});
