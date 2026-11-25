// Test fixture helper: express a model tool call in the old internal shape and get the public split tool call.
// Only for tests that exercise runtime behaviour; tests/public-tools.test.ts checks the mapping itself.
type Obj = Record<string, any>;
const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// target "self": an update issued by a task session about itself (task_reschedule).
export function employeeCall(a: Obj, target: "task" | "self" = "task"): { name: string; arguments: Obj } {
  if (a.kind === "duty" || (target as string) === "duty") throw new Error("职责配置已移除");
  const call = (name: string, args: Obj = {}) => ({ name, arguments: defined(args) });
  const when = { runAt: a.nextAt, delayMinutes: a.nextCheckInMinutes };
  switch (a.action) {
    case "list": return call("employee_status");
    case "add":
      return call("employee_task_create", { instructions: a.text, dedupeKey: a.key, parentTaskId: a.parentTaskId, relation: a.relation, branchLabel: a.branchLabel, ...when, profile: a.profile });
    case "update":
      if (target === "self") return call("task_reschedule", when);
      return call("employee_task_manage", { taskId: a.id, request: a.nextAt || a.nextCheckInMinutes ? defined({ command: "reschedule", ...when })
        : a.profile ? { command: "set_profile", profile: a.profile } : { command: "set_instructions", instructions: a.text } });
    case "done": return call("employee_task_manage", { taskId: a.id, request: { command: "cancel" } });
    case "resume": return call("employee_task_manage", { taskId: a.id, request: defined({ command: "resume", supplement: a.text }) });
    case "answer": return call("employee_task_manage", { taskId: a.id, request: { command: "answer", answer: a.text } });
    case "stop": return call("employee_task_manage", { taskId: a.id, request: { command: "stop" } });
    case "progress": return call("task_progress", { message: a.text, plan: a.plan });
    case "ask": return call("task_request_approval", { request: a.text });
    case "help": return call("task_ask_user", { question: a.text });
    case "defer": return call("task_wait", { checkpoint: a.text, resumeAt: a.nextAt, delayMinutes: a.nextCheckInMinutes });
    case "relay": return call("task_relay_computer", { handoff: a.text });
    case "complete": return call("task_complete", { evidence: a.text, summary: a.summary, deliverableRefs: a.deliverableRef === undefined ? undefined : [].concat(a.deliverableRef), outlineReview: a.outlineReview });
    case "vault_list": return call("vault_list");
    case "vault_get": return call("vault_get", { credentialId: a.id, purpose: a.text, url: a.url });
    case "memory_search": return call("memory_search", { query: a.query, status: a.status, memoryScene: a.memoryScene || a.scene });
    case "memory_propose": return call("memory_propose", { claim: a.claim, memoryKind: a.memoryKind || a.kind, scope: a.scope, memoryScene: a.memoryScene || a.scene, evidence: a.evidence, memoryId: a.id, pinned: a.pinned });
    case "memory_resolve": {
      const command = a.resolveAction || "confirm";
      if (command === "merge") return call("memory_manage", { request: defined({ command, memoryIds: a.ids, keepId: a.keepId }) });
      return call("memory_manage", { request: defined({ command: command === "drop" ? "forget" : command, memoryId: a.id, claim: command === "confirm" || (command === "feedback" && a.signal === "correction") ? a.claim : undefined, signal: a.signal }) });
    }
    case "memory_pin": return call("memory_manage", { request: { command: a.pinned === false ? "unpin" : "pin", memoryId: a.id } });
    case "memory_forget": return call("memory_manage", { request: { command: "forget", memoryId: a.id } });
  }
  throw Error("employeeCall: unmapped action " + a.action);
}

const action = (v: Obj): Obj => {
  switch (v.action) {
    case "click": return defined({ op: "click", x: v.x, y: v.y, button: v.button, clicks: v.click_count, id: v.id });
    case "fill": return defined({ op: "type", text: v.text, id: v.id, clear: v.clear, submit: v.submit });
    case "scroll": return defined({ op: "scroll", dy: v.delta, dx: v.delta_x, id: v.id });
    case "wait": return defined({ op: "wait", ms: v.ms });
    case "click_at": return defined({ op: "click", x: v.x, y: v.y, button: v.button, clicks: v.click_count });
    case "drag": return defined({ op: "drag", x1: v.x, y1: v.y, x2: v.to_x, y2: v.to_y, durationMs: v.duration_ms });
    case "scroll_at": return defined({ op: "scroll", x: v.x, y: v.y, dy: v.delta, dx: v.delta_x });
    default: return v.op ? v : defined({ op: v.action, x: v.x, y: v.y, text: v.text, key: v.key, id: v.id });
  }
};

export function chromeCall(a: Obj): { name: string; arguments: Obj } {
  const call = (name: string, args: Obj = {}) => ({ name, arguments: defined(args) });
  switch (a.operation) {
    case "tabs": case "browser_tabs": return call("browser_tabs", { action: a.action || "list", query: a.query, incognito: a.incognito, view: a.observe === "none" ? false : undefined });
    case "open": return call("browser_tabs", { action: "open", url: a.url, incognito: a.incognito, view: a.observe === "none" ? false : undefined });
    case "goto": return call("browser_tabs", { action: "goto", tab: a.tabTag || a.tab, url: a.url, view: a.observe === "none" ? false : undefined });
    case "select_tab": case "close_tab": case "back": case "forward": case "reload":
      return call("browser_tabs", { tab: a.tabTag || a.tab, action: ({ select_tab: "switch", close_tab: "close" } as Obj)[a.operation] || a.operation, view: a.observe === "none" ? false : undefined });
    case "inspect": case "browser_view":
      return call("browser_view", { tab: a.tabTag || a.tab, query: a.query, scope: a.scope, screenshot: a.screenshot ?? false, maxItems: a.maxItems, maxTextChars: a.maxTextChars });
    case "screenshot": {
      const zoom = a.region ? { x: a.region.x, y: a.region.y, width: a.region.width, height: a.region.height } : undefined;
      return call("browser_view", { tab: a.tabTag || a.tab, screenshot: true, zoom, maxItems: a.maxItems, maxTextChars: a.maxTextChars });
    }
    case "act": case "browser_act":
      return call("browser_act", { tab: a.tabTag || a.tab, steps: (a.steps || a.actions || [a.action]).map(action), screenshot: a.screenshot, notes: a.notes });
    case "evaluate": case "browser_eval":
      return call("browser_eval", { tab: a.tabTag || a.tab, code: a.code || a.expression, view: a.feedback === "none" ? false : a.view });
    case "downloads": return call("browser_debug", { kind: "downloads", downloadId: a.downloadId, since: a.since });
    case "status": case "connect": case "stop": return call("browser_debug", { kind: "downloads" });
    case "devtools": case "browser_debug":
      return call("browser_debug", { kind: a.kind || a.devtools?.kind || "console", tab: a.tabTag || a.tab, ...a.devtools });
  }
  throw Error("chromeCall: unmapped operation " + a.operation);
}

export function vaultCall(a: Obj) {
  return a.action === "list" ? { name: "vault_list", arguments: {} } : { name: "vault_get", arguments: defined({ credentialId: a.id, purpose: a.text, url: a.url }) };
}
