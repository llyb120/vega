import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Tools } from "../server/core/tools";
import {
  ArgumentError, CHROME_TOOL_DEFINITIONS, STANDALONE_TOOLS, checkArgs, employeeTools, toInternal, vaultTools, type ToolContext,
} from "../server/core/public-tools";

const all = (ctx: ToolContext) => [...employeeTools(ctx), ...vaultTools(ctx), ...CHROME_TOOL_DEFINITIONS];
const schemaOf = (name: string, ctx: ToolContext) => {
  const tool = all(ctx).find((t) => t.name === name);
  assert(tool, `${name} visible in ${JSON.stringify(ctx)}`);
  return tool.parameters;
};
const map = (name: string, args: any, ctx: ToolContext = { kind: "normal" }) => toInternal(name, checkArgs(schemaOf(name, ctx), args), ctx);
const task: ToolContext = { kind: "task", dutyCommands: ["schedule_next", "disable"], vaultRequest: true, vaultSend: true };
const chat: ToolContext = { kind: "chat" };

test("every public tool maps onto the unchanged internal executor arguments", () => {
  const cases: [string, any, any, ToolContext?][] = [
    ["chrome_tabs", { query: "jira" }, { operation: "tabs", query: "jira" }],
    ["chrome_tabs", { incognito: false }, { operation: "tabs", incognito: false }],
    ["chrome_navigate", { url: "https://a.test", target: { kind: "new_tab" } }, { operation: "open", url: "https://a.test" }],
    ["chrome_navigate", { url: "https://a.test", target: { kind: "new_tab", incognito: true } }, { operation: "open", url: "https://a.test", incognito: true }],
    ["chrome_navigate", { url: "https://a.test", target: { kind: "existing_tab", tabTag: "C1" } }, { operation: "goto", tabTag: "C1", url: "https://a.test" }],
    ["chrome_tab_control", { tabTag: "C1", command: "select" }, { operation: "select_tab", tabTag: "C1" }],
    ["chrome_tab_control", { tabTag: "C1", command: "close" }, { operation: "close_tab", tabTag: "C1" }],
    ["chrome_tab_control", { tabTag: "C1", command: "reload" }, { operation: "reload", tabTag: "C1" }],
    ["chrome_tab_control", { tabTag: "C1", command: "back", observe: "none" }, { operation: "back", tabTag: "C1", observe: "none" }],
    ["chrome_navigate", { url: "https://a.test", target: { kind: "existing_tab", tabTag: "C1" }, observe: "screenshot", settleMs: 3000, visual: "none" },
      { operation: "goto", tabTag: "C1", url: "https://a.test", observe: "screenshot", settleMs: 3000, visual: "none" }],
    ["chrome_tabs", { query: "jira", visual: "none" }, { operation: "tabs", query: "jira", visual: "none" }],
    ["chrome_act", { tabTag: "C1", actions: [{ action: "type", text: "" }, { action: "wait" }] }, { operation: "act", tabTag: "C1", actions: [{ action: "type", text: "" }, { action: "wait" }] }],
    ["chrome_run", { tabTag: "C1", task: "t", steps: [{ action: "click", target: "Submit", expectedText: "ok" }] }, { operation: "run", tabTag: "C1", plan: { task: "t", steps: [{ action: "click", target: "Submit", expectedText: "ok" }] } }],
    ["chrome_downloads", { since: 0 }, { operation: "downloads", since: 0 }],
    ["chrome_act", { tabTag: "C1", actions: [{ action: "hover", ref: "e1" }, { action: "hover", ref: "e2", frame: 1 }] }, { operation: "act", tabTag: "C1", actions: [{ action: "hover", ref: "e1" }, { action: "hover", ref: "e2", frame: 1 }] }],
    // Summary budgets on every tool that returns an observation, as the old single tool allowed; null = omitted.
    ["chrome_act", { tabTag: "C1", maxItems: 5, maxTextChars: 200, actions: [{ action: "wait" }] }, { operation: "act", tabTag: "C1", maxItems: 5, maxTextChars: 200, actions: [{ action: "wait" }] }],
    ["chrome_act", { tabTag: "C1", maxItems: null, actions: [{ action: "wait" }] }, { operation: "act", tabTag: "C1", actions: [{ action: "wait" }] }],
    ["chrome_screenshot", { tabTag: "C1", maxItems: 1, capture: { kind: "viewport" } }, { operation: "screenshot", tabTag: "C1", maxItems: 1 }],
    ["chrome_navigate", { url: "https://a.test", target: { kind: "new_tab" }, maxTextChars: 100 }, { operation: "open", url: "https://a.test", maxTextChars: 100 }],
    ["chrome_screenshot", { tabTag: "C1", capture: { kind: "viewport" }, maxTextChars: 0 }, { operation: "screenshot", tabTag: "C1", maxTextChars: 0 }],
    ["chrome_tab_control", { tabTag: "C1", command: "reload", maxItems: 2 }, { operation: "reload", tabTag: "C1", maxItems: 2 }],
    ["chrome_evaluate", { tabTag: "C1", expression: "1", maxItems: 3 }, { operation: "evaluate", tabTag: "C1", expression: "1", maxItems: 3 }],
    ["chrome_tabs", { query: "jira", maxItems: 4 }, { operation: "tabs", query: "jira", maxItems: 4 }],
    ["chrome_inspect", { tabTag: "C1", scope: "viewport", visual: "none" }, { operation: "inspect", tabTag: "C1", scope: "viewport", visual: "none" }],
    ["chrome_screenshot", { tabTag: "C1", capture: { kind: "viewport" } }, { operation: "screenshot", tabTag: "C1" }],
    ["chrome_screenshot", { tabTag: "C1", capture: { kind: "page", tileOffset: 2 } }, { operation: "screenshot", tabTag: "C1", fullPage: true, tileOffset: 2 }],
    ["chrome_screenshot", { tabTag: "C1", capture: { kind: "element", ref: "e3", frame: 1 } }, { operation: "screenshot", tabTag: "C1", ref: "e3", frame: 1 }],
    ["chrome_screenshot", { tabTag: "C1", capture: { kind: "region", region: { x: 0, y: 0, width: 10, height: 20 } } }, { operation: "screenshot", tabTag: "C1", region: { x: 0, y: 0, width: 10, height: 20 } }],
    ["chrome_screenshot", { tabTag: "C1", capture: { kind: "scroll_area" } }, { operation: "screenshot", tabTag: "C1", expandScroll: true }],
    ["chrome_act", { tabTag: "C1", actions: [
      { action: "click", ref: "e1", clickCount: 2 }, { action: "fill", ref: "e2", value: "" }, { action: "type", text: "hi" }, { action: "press", key: "Enter" },
      { action: "scroll", deltaY: 0, deltaX: 40 }, { action: "wait", milliseconds: 0 }, { action: "upload", selector: "#f", files: ["a.png"] },
      { action: "click_at", x: 0, y: 0 }, { action: "move", x: 1, y: 2 }, { action: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 100 }, { action: "scroll_at", x: 5, y: 6, deltaY: -100 },
    ], settleMs: 0 }, { operation: "act", tabTag: "C1", settleMs: 0, actions: [
      { action: "click", ref: "e1", click_count: 2 }, { action: "fill", ref: "e2", text: "" }, { action: "type", text: "hi" }, { action: "press", key: "Enter" },
      { action: "scroll", delta: 0, delta_x: 40 }, { action: "wait", ms: 0 }, { action: "upload", selector: "#f", files: ["a.png"] },
      { action: "click_at", x: 0, y: 0 }, { action: "move", x: 1, y: 2 }, { action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, duration_ms: 100 }, { action: "scroll_at", x: 5, y: 6, delta: -100 },
    ] }],
    ["chrome_evaluate", { tabTag: "C1", expression: "1", observe: false }, { operation: "evaluate", tabTag: "C1", expression: "1", feedback: "none" }],
    ["chrome_evaluate", { tabTag: "C1", expression: "1" }, { operation: "evaluate", tabTag: "C1", expression: "1" }],
    ["chrome_connection", { command: "status" }, { operation: "status" }],
    ["chrome_connection", { command: "cancel_operation" }, { operation: "stop" }],
    ["chrome_downloads", { downloadId: "42" }, { operation: "downloads", downloadId: "42" }],
    ["chrome_devtools", { tabTag: "C1", kind: "network", requestId: "r1" }, { operation: "devtools", tabTag: "C1", devtools: { kind: "network", requestId: "r1" } }],
    ["employee_status", {}, { action: "list" }],
    ["employee_status", { memoryQuery: "部署" }, { action: "list", query: "部署" }],
    ["employee_status", { taskId: "t1" }, { action: "list", id: "t1" }],
    ["employee_status", { dedupeKey: "tapd:1", status: "active" }, { action: "list", key: "tapd:1", status: "active" }],
    ["employee_status", { status: "all" }, { action: "list" }],
    ["employee_task_create", { instructions: "x", profile: "编码" }, { action: "add", kind: "todo", text: "x", profile: "编码" }],
    ["employee_task_manage", { taskId: "t1", request: { command: "update", instructions: "new", profile: "轻量化", delayMinutes: 5 } }, { action: "update", id: "t1", text: "new", profile: "轻量化", nextCheckInMinutes: 5 }],
    ["employee_task_manage", { taskId: "t1", request: { command: "update", profile: "coding", runAt: null } }, { action: "update", id: "t1", profile: "coding" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "update", instructions: "i", note: "", profile: "coding", enabled: false, trigger: { kind: "daily", times: ["09:00"] } } },
      { action: "update", id: "d1", text: "i", note: "", profile: "coding", enabled: false, manual: false, times: ["09:00"], everyMinutes: 0 }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "update", trigger: { kind: "dynamic", runAt: "2030-01-01 09:00" } } }, { action: "update", id: "d1", manual: false, times: [], everyMinutes: 0, nextAt: "2030-01-01 09:00" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "update", note: "n", trigger: { kind: "condition", condition: "每 30 分钟" } } }, { action: "update", id: "d1", note: "n", condition: "每 30 分钟" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "update", trigger: { kind: "manual" } } }, { action: "update", id: "d1", manual: true }],
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
    ["employee_duty_create", { instructions: "daily report", trigger: { kind: "condition", condition: "每天 9 点" } }, { action: "add", kind: "duty", text: "daily report", condition: "每天 9 点" }],
    ["employee_duty_create", { instructions: "on demand", trigger: { kind: "manual" } }, { action: "add", kind: "duty", text: "on demand", manual: true }],
    ["employee_duty_create", { instructions: "r", trigger: { kind: "daily", times: ["09:00", "14:30"] }, profile: "coding" }, { action: "add", kind: "duty", text: "r", profile: "coding", times: ["09:00", "14:30"] }],
    ["employee_duty_create", { instructions: "r", trigger: { kind: "interval", everyMinutes: 30 } }, { action: "add", kind: "duty", text: "r", everyMinutes: 30 }],
    ["employee_duty_create", { instructions: "r", trigger: { kind: "dynamic", delayMinutes: 10 } }, { action: "add", kind: "duty", text: "r", nextCheckInMinutes: 10 }],
    ["employee_duty_create", { instructions: "r", trigger: { kind: "dynamic", runAt: "2030-01-01 09:00" } }, { action: "add", kind: "duty", text: "r", nextAt: "2030-01-01 09:00" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "set_daily", times: ["08:00"] } }, { action: "update", id: "d1", manual: false, times: ["08:00"], everyMinutes: 0 }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "set_interval", everyMinutes: 15 } }, { action: "update", id: "d1", manual: false, everyMinutes: 15, times: [] }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "set_profile", profile: "coding" } }, { action: "update", id: "d1", profile: "coding" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "enable" } }, { action: "update", id: "d1", enabled: true }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "schedule_next", delayMinutes: 45 } }, { action: "update", id: "d1", nextCheckInMinutes: 45 }, task],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "set_note", note: "" } }, { action: "update", id: "d1", note: "" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "disable" } }, { action: "update", id: "d1", enabled: false }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "set_manual" } }, { action: "update", id: "d1", manual: true }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "remove" } }, { action: "done", id: "d1" }],
    ["employee_duty_manage", { dutyId: "d1", request: { command: "schedule_next", runAt: "2030-01-01 09:00" } }, { action: "update", id: "d1", nextAt: "2030-01-01 09:00" }, task],
    ["task_progress", { message: "m", plan: [{ content: "a", status: "completed" }] }, { action: "progress", text: "m", plan: [{ content: "a", status: "completed" }] }, task],
    ["task_request_approval", { request: "pay" }, { action: "ask", text: "pay" }, task],
    ["task_ask_user", { question: "code?" }, { action: "help", text: "code?" }, task],
    ["task_wait", { checkpoint: "job 1", delayMinutes: 5 }, { action: "defer", text: "job 1", nextCheckInMinutes: 5 }, task],
    ["task_relay_computer", { handoff: "open page" }, { action: "relay", scene: "computer", text: "open page" }, task],
    ["task_complete", { evidence: "ok", deliverableRefs: [] }, { action: "complete", text: "ok", deliverableRef: [] }, task],
    ["memory_propose", { claim: "c", memoryKind: "convention" }, { action: "memory_propose", claim: "c", memoryKind: "convention" }, chat],
    ["memory_propose", { claim: "c", pinned: true, memoryKind: null }, { action: "memory_propose", claim: "c", pinned: true }, chat],
    ["memory_manage", { request: { command: "feedback", memoryId: "a", signal: "correction", claim: "new" } }, { action: "memory_resolve", resolveAction: "feedback", id: "a", signal: "correction", claim: "new" }, chat],
    ["memory_manage", { request: { command: "merge", memoryIds: ["a", "b"] } }, { action: "memory_resolve", resolveAction: "merge", ids: ["a", "b"] }, chat],
    ["memory_manage", { request: { command: "forget", memoryId: "a" } }, { action: "memory_resolve", resolveAction: "drop", id: "a" }, chat],
    ["memory_manage", { request: { command: "unpin", memoryId: "a" } }, { action: "memory_pin", id: "a", pinned: false }, chat],
    ["vault_get", { credentialId: "v1", purpose: "login" }, { action: "vault_get", id: "v1", text: "login" }, task],
    ["vault_send", { credentialId: "v1" }, { action: "vault_send", id: "v1" }, task],
  ];
  for (const [name, args, internal, ctx] of cases)
    assert.deepEqual(map(name, args, ctx).args, internal, name + " " + JSON.stringify(args));
  assert.deepEqual(map("vault_get", { credentialId: "v1", purpose: "login" }, chat), { tool: "employee", args: { action: "vault_get", id: "v1", text: "login" } }, "an employee chat reads its own vault through the employee executor");
  assert.equal(map("employee_task_manage", { taskId: "t1", request: { command: "cancel" } }).target, "task");
  assert.equal(map("employee_duty_manage", { dutyId: "d1", request: { command: "remove" } }).target, "duty");
});

test("memory source is decided by the server and memory_manage requires an explicit command", () => {
  assert.throws(() => map("memory_propose", { claim: "c", memoryKind: "convention", source: "ui" }, chat), /不接受字段 source/);
  assert.throws(() => map("memory_propose", { claim: "c", memoryKind: "guess" }, chat), /memoryKind/);
  assert.throws(() => map("memory_manage", { request: { memoryId: "a" } }, chat), ArgumentError);
});

test("branch errors name the field and the chosen branch's structure", () => {
  assert.throws(() => map("chrome_navigate", { url: "https://a.test", target: { kind: "existing_tab" } }), /tabTag.*kind="existing_tab" 的结构：必填 kind、tabTag/s);
  assert.throws(() => map("chrome_navigate", { url: "https://a.test", target: { kind: "elsewhere" } }), /target\.kind 只能是 "new_tab" \/ "existing_tab"/);
  assert.throws(() => map("chrome_act", { tabTag: "C1", actions: [{ action: "click", ref: "e1", x: 1 }] }), /不接受字段 x.*必填 action、ref/s);
  assert.throws(() => map("chrome_screenshot", { tabTag: "C1", capture: { kind: "region", region: { x: 0, y: 0, width: 0, height: 0 } } }), /width 必须大于 0/);
  assert.throws(() => map("task_wait", { checkpoint: "x" }, task), /resumeAt 和 参数\.delayMinutes 必须恰好填一个/);
  assert.throws(() => map("task_wait", { checkpoint: "x", delayMinutes: 5, resumeAt: "2030-01-01 09:00" }, task), /恰好填一个/);
  assert.throws(() => map("employee_task_create", { instructions: "x", runAt: "tomorrow 9am" }), /runAt 至少 16 个字符|runAt 格式不对/);
  const self = { ...task, taskId: "self" };
  assert.throws(() => map("task_reschedule", {}, self), /runAt 和 参数\.delayMinutes 必须恰好填一个/);
  assert.throws(() => map("task_reschedule", { runAt: "2030-01-01 09:00", delayMinutes: 5 }, self), /恰好填一个/);
  assert.throws(() => map("task_reschedule", { delayMinutes: 5, taskId: "other" }, self), /不接受字段 taskId/, "a task can only reschedule itself");
  assert.throws(() => map("employee_task_create", { instructions: "x", runAt: "2030-01-01 09:00", delayMinutes: 5 }), /最多填一个/);
  assert.throws(() => map("employee_task_manage", { taskId: "t1", request: { command: "reschedule" } }), /request\.runAt 和 参数\.request\.delayMinutes 必须恰好填一个/);
  assert.throws(() => map("employee_duty_create", { instructions: "x", trigger: { kind: "dynamic" } }), /trigger\.runAt.*恰好填一个/);
  assert.throws(() => map("employee_duty_create", { instructions: "x", trigger: { kind: "daily", times: ["9:00"] } }), /times/);
  assert.throws(() => map("employee_duty_create", { instructions: "x", trigger: { kind: "interval", everyMinutes: 30, times: ["09:00"] } }), /不接受字段 times/);
  assert.throws(() => map("employee_task_create", { instructions: "x", profile: "computer" }), /profile/);
  assert.throws(() => map("employee_task_create", { instructions: "x", profile: "电脑" }), /profile/, "computer work goes through relay, as before");
  assert.throws(() => map("employee_task_manage", { taskId: "t1", request: { command: "update" } }), /至少要改一项/);
  assert.throws(() => map("employee_duty_manage", { dutyId: "d1", request: { command: "update", note: null } }), /至少要改一项/);
  assert.throws(() => map("employee_task_manage", { taskId: "t1", request: { command: "update", runAt: "2030-01-01 09:00", delayMinutes: 5 } }), /恰好填一个/);
  assert.throws(() => map("employee_duty_manage", { dutyId: "d1", request: { command: "update", trigger: { kind: "dynamic" } } }), /request\.trigger\.runAt.*恰好填一个/);
  assert.throws(() => map("employee_duty_manage", { dutyId: "d1", request: { command: "update", condition: "x" } }), /不接受字段 condition/);
});

test("narrow fallback: only null or an empty value its own bound rejects counts as omitted; legal '' and 0 are kept", () => {
  assert.deepEqual(map("chrome_downloads", { downloadId: "", since: 0 }).args, { operation: "downloads", since: 0 });
  assert.deepEqual(map("chrome_inspect", { tabTag: "C1", query: null, maxItems: 0 }).args, { operation: "inspect", tabTag: "C1" });
  assert.deepEqual(map("employee_duty_manage", { dutyId: "d1", request: { command: "set_note", note: "" } }).args.note, "");
  const act = map("chrome_act", { tabTag: "C1", actions: [{ action: "scroll_at", x: 0, y: 0, deltaY: 0 }], settleMs: 0 }).args;
  assert.deepEqual(act.actions, [{ action: "scroll_at", x: 0, y: 0, delta: 0 }]);
  assert.equal(act.settleMs, 0);
  assert.deepEqual(map("chrome_tabs", { incognito: false }).args, { operation: "tabs", incognito: false }, "false is a real filter, never dropped");
  assert.throws(() => map("chrome_navigate", { url: "https://a.test", target: { kind: "existing_tab", tabTag: "" } }), /tabTag/, "an empty tabTag never silently means new tab");
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
  const filled = { tabTag: "C1", actions: [{ action: "click", ref: "e1", frame: 0, button: "", clickCount: 0, value: "", text: "", key: "", x: 0, y: 0 }], imageId: "", visual: "", settleMs: 0 };
  await assert.rejects(tools.execute({ id: "a", name: "chrome_act", arguments: filled }, {} as any), ArgumentError);
  await assert.rejects(tools.execute({ id: "b", name: "chrome_navigate", arguments: { url: "https://a.test", target: { kind: "new_tab", tabTag: "", incognito: false } } }, {} as any), /不接受字段 tabTag/);
  await assert.rejects(tools.execute({ id: "c", name: "employee_task_manage", arguments: { taskId: "t1", request: { command: "reschedule", runAt: "", instructions: "" } } }, {} as any), ArgumentError);
  assert.equal(browser, 0);
  assert.equal(employee, 0);
});

test("visible tools and branches follow session, scene and permission like the old definitions", () => {
  const names = (ctx: ToolContext) => [...employeeTools(ctx), ...vaultTools(ctx)].map((t) => t.name).sort();
  const commands = (ctx: ToolContext, tool: string) => JSON.stringify(employeeTools(ctx).find((t) => t.name === tool)?.parameters).match(/"enum":\["[^\]]+"\]/g)?.join(",") || "";
  assert.deepEqual(names({ kind: "normal" }), ["employee_duty_create", "employee_duty_manage", "employee_status", "employee_task_create", "employee_task_manage", "memory_manage", "memory_propose", "memory_search"], "a plain session belongs to no employee and has no vault");
  assert.deepEqual(names(chat).filter((name) => name.startsWith("vault_")), ["vault_get", "vault_list"]);
  assert(!commands({ kind: "normal" }, "employee_task_manage").includes("resume"), "resume/answer/stop are chat-only");
  assert(commands(chat, "employee_task_manage").includes("stop"));
  assert.deepEqual(names({ kind: "chat", member: true }), ["employee_status", "employee_task_create", "employee_task_manage", "vault_get", "vault_list"]);
  assert(!/update|set_instructions|set_profile|reschedule|cancel/.test(commands({ kind: "chat", member: true }, "employee_task_manage")));
  const main = names({ kind: "task", dutyCommands: [] });
  assert.deepEqual(main, ["employee_status", "employee_task_create", "memory_manage", "memory_propose", "memory_search", "task_ask_user", "task_complete", "task_progress", "task_relay_computer", "task_request_approval", "task_reschedule", "task_wait", "vault_get", "vault_list"]);
  const computer = names({ kind: "task", computer: true, dutyCommands: [] });
  assert(!computer.includes("task_relay_computer") && !computer.includes("task_complete"));
  assert(names({ kind: "task", vaultRequest: true, vaultSend: true }).includes("vault_request"));
  assert(names({ kind: "task", vaultRequest: true, vaultSend: true }).includes("vault_send"));
  assert.equal(commands({ kind: "task", dutyCommands: ["disable"] }, "employee_duty_manage"), '"enum":["disable"]', "fixed duty: a task may only disable its own duty");
  assert(commands({ kind: "task", dutyCommands: ["schedule_next", "disable"] }, "employee_duty_manage").includes("schedule_next"));
  for (const name of ["task_request_approval", "task_ask_user", "task_wait", "task_relay_computer", "task_complete", "vault_request", "vault_send"]) assert(STANDALONE_TOOLS.has(name));
});

test("chrome tools appear only where the old chrome tool did", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  const engine = { store, vault: new Vault(store), mcpFor: () => ({}) } as any;
  const config = { model: "", provider: {}, scenes: { lightweight: ["p/l"], coding: ["p/c"], computer: ["p/x"] } } as any;
  const visible = async (session: any, model?: any) => (await (await Tools.create(engine, session, config, new AbortController().signal, () => {})).definitions(model)).filter((d) => d.name.startsWith("chrome_")).length;
  assert.equal(await visible(await store.newSession({ scene: "computer" })), 14);
  assert.equal(await visible(await store.newSession({ scene: "coding" })), 0);
  assert.equal(await visible(await store.newSession({ scene: "coding" }), { selection: "p/x" }), 14);
  assert.equal(await visible(await store.newSession({ scene: "computer", readOnly: true })), 0);
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
