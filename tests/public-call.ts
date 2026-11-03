// Test fixture helper: express a model tool call in the old internal shape and get the public split tool call.
// Only for tests that exercise runtime behaviour; tests/public-tools.test.ts checks the mapping itself.
type Obj = Record<string, any>;
const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// target "self": an update issued by a task session about itself (task_reschedule).
export function employeeCall(a: Obj, target: "task" | "duty" | "self" = "task"): { name: string; arguments: Obj } {
  const call = (name: string, args: Obj = {}) => ({ name, arguments: defined(args) });
  const when = { runAt: a.nextAt, delayMinutes: a.nextCheckInMinutes };
  switch (a.action) {
    case "list": return call("employee_status");
    case "add":
      if (a.kind === "duty") {
        const trigger = a.condition ? { kind: "condition", condition: a.condition } : a.times?.length ? { kind: "daily", times: a.times }
          : a.everyMinutes ? { kind: "interval", everyMinutes: a.everyMinutes } : a.nextAt || a.nextCheckInMinutes ? defined({ kind: "dynamic", ...when }) : { kind: "manual" };
        return call("employee_duty_create", { instructions: a.text, note: a.note, profile: a.profile, trigger });
      }
      return call("employee_task_create", { instructions: a.text, dedupeKey: a.key, ...when, profile: a.profile });
    case "update":
      if (target === "duty") {
        const request = a.enabled === false ? { command: "disable" } : a.enabled === true ? { command: "enable" } : a.nextAt || a.nextCheckInMinutes ? defined({ command: "schedule_next", ...when })
          : a.condition ? { command: "set_condition", condition: a.condition } : a.manual ? { command: "set_manual" } : a.times?.length ? { command: "set_daily", times: a.times }
          : a.everyMinutes ? { command: "set_interval", everyMinutes: a.everyMinutes } : a.profile ? { command: "set_profile", profile: a.profile }
          : "note" in a ? { command: "set_note", note: a.note } : { command: "set_instructions", instructions: a.text };
        return call("employee_duty_manage", { dutyId: a.id, request });
      }
      if (target === "self") return call("task_reschedule", when);
      return call("employee_task_manage", { taskId: a.id, request: a.nextAt || a.nextCheckInMinutes ? defined({ command: "reschedule", ...when })
        : a.profile ? { command: "set_profile", profile: a.profile } : { command: "set_instructions", instructions: a.text } });
    case "done": return target === "duty" ? call("employee_duty_manage", { dutyId: a.id, request: { command: "remove" } }) : call("employee_task_manage", { taskId: a.id, request: { command: "cancel" } });
    case "resume": return call("employee_task_manage", { taskId: a.id, request: defined({ command: "resume", supplement: a.text }) });
    case "answer": return call("employee_task_manage", { taskId: a.id, request: { command: "answer", answer: a.text } });
    case "stop": return call("employee_task_manage", { taskId: a.id, request: { command: "stop" } });
    case "progress": return call("task_progress", { message: a.text, plan: a.plan });
    case "ask": return call("task_request_approval", { request: a.text });
    case "help": return call("task_ask_user", { question: a.text });
    case "defer": return call("task_wait", { checkpoint: a.text, resumeAt: a.nextAt, delayMinutes: a.nextCheckInMinutes });
    case "relay": return call("task_relay_computer", { handoff: a.text });
    case "complete": return call("task_complete", { evidence: a.text, summary: a.summary, deliverableRefs: a.deliverableRef === undefined ? undefined : [].concat(a.deliverableRef) });
    case "vault_list": return call("vault_list");
    case "vault_get": return call("vault_get", { credentialId: a.id, purpose: a.text, url: a.url });
    case "vault_request": return call("vault_request", { requirement: a.text });
    case "vault_send": return call("vault_send", { credentialId: a.id, url: a.url });
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
    case "click": return defined({ action: "click", ref: v.ref, frame: v.frame, button: v.button, clickCount: v.click_count });
    case "fill": return defined({ action: "fill", ref: v.ref, value: v.text, frame: v.frame });
    case "scroll": return defined({ action: "scroll", deltaY: v.delta, deltaX: v.delta_x, ref: v.ref, frame: v.frame });
    case "wait": return defined({ action: "wait", milliseconds: v.ms });
    case "click_at": return defined({ action: "click_at", x: v.x, y: v.y, button: v.button, clickCount: v.click_count });
    case "drag": return defined({ action: "drag", fromX: v.x, fromY: v.y, toX: v.to_x, toY: v.to_y, durationMs: v.duration_ms });
    case "scroll_at": return defined({ action: "scroll_at", x: v.x, y: v.y, deltaY: v.delta, deltaX: v.delta_x });
    default: return v;
  }
};

export function chromeCall(a: Obj): { name: string; arguments: Obj } {
  const call = (name: string, args: Obj = {}) => ({ name, arguments: defined(args) });
  switch (a.operation) {
    case "tabs": return call("chrome_tabs", { query: a.query, incognito: a.incognito, visual: a.visual });
    case "open": return call("chrome_navigate", { url: a.url, target: defined({ kind: "new_tab", incognito: a.incognito }), observe: a.observe, settleMs: a.settleMs, visual: a.visual });
    case "goto": return call("chrome_navigate", { url: a.url, target: { kind: "existing_tab", tabTag: a.tabTag }, observe: a.observe, settleMs: a.settleMs, visual: a.visual });
    case "select_tab": case "close_tab": case "back": case "forward": case "reload":
      return call("chrome_tab_control", { tabTag: a.tabTag, command: ({ select_tab: "select", close_tab: "close" } as Obj)[a.operation] || a.operation, observe: a.observe, settleMs: a.settleMs, visual: a.visual });
    case "inspect": return call("chrome_inspect", { tabTag: a.tabTag, query: a.query, scope: a.scope, visual: a.visual, maxItems: a.maxItems, maxTextChars: a.maxTextChars });
    case "screenshot": {
      const capture = a.region ? { kind: "region", region: a.region } : a.expandScroll ? defined({ kind: "scroll_area", ref: a.ref }) : a.ref ? defined({ kind: "element", ref: a.ref, frame: a.frame }) : a.fullPage ? defined({ kind: "page", tileOffset: a.tileOffset }) : { kind: "viewport" };
      return call("chrome_screenshot", { tabTag: a.tabTag, capture: defined({ ...capture, maxEdge: a.maxEdge }) });
    }
    case "act": return call("chrome_act", { tabTag: a.tabTag, actions: (a.actions || [a.action]).map(action), imageId: a.imageId, visual: a.visual, settleMs: a.settleMs });
    case "evaluate": return call("chrome_evaluate", { tabTag: a.tabTag, expression: a.expression, frame: a.frame, visual: a.visual, observe: a.feedback === "none" ? false : undefined });
    case "run": return call("chrome_run", { tabTag: a.tabTag, ...a.plan });
    case "status": case "connect": return call("chrome_connection", { command: "status" });
    case "stop": return call("chrome_connection", { command: "cancel_operation" });
    case "downloads": return call("chrome_downloads", { downloadId: a.downloadId, since: a.since });
    case "devtools": return call("chrome_devtools", { tabTag: a.tabTag, ...a.devtools });
  }
  throw Error("chromeCall: unmapped operation " + a.operation);
}

export function vaultCall(a: Obj) {
  return a.action === "list" ? { name: "vault_list", arguments: {} } : { name: "vault_get", arguments: defined({ credentialId: a.id, purpose: a.text, url: a.url }) };
}
