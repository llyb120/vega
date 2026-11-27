export function groupTurns(messages) {
  const turns = [];
  let current;
  for (const message of messages) {
    if ((message.role === "user" && !message.phaseReturned) || !current) {
      current = { user: null, body: [] };
      turns.push(current);
    }
    if (message.phaseReturned) continue;
    if (message.role === "user") current.user = message;
    else current.body.push(message);
  }
  return turns.map((turn) => {
    let conclusion = -1;
    for (let i = turn.body.length - 1; i >= 0; i--) {
      if (turn.body[i].agentPhase || turn.body[i].role !== "assistant" || turn.body[i].calls?.length || !(turn.body[i].text?.trim() || turn.body[i].images?.length)) break;
      conclusion = i;
    }
    return {
      ...turn,
      process: conclusion < 0 ? turn.body : turn.body.slice(0, conclusion),
      conclusion: conclusion < 0 ? [] : turn.body.slice(conclusion),
    };
  });
}

/** Chat page: everything the employee wrote is shown as soon as it exists, including text written alongside tool calls; tool calls, results and thinking stay hidden. */
export function employeeChatMessages(messages) {
  return messages.filter((message) => message.role === "user" || message.delivery || message.notice ||
    (message.role === "assistant" && !!(message.text?.trim() || message.images?.length)));
}

/** Single task a message belongs to (explicit topicTaskId, or its sole linked task). */
export function messageTaskId(message) {
  if (!message || message.notice) return "";
  if (message.topicTaskId) return message.topicTaskId;
  if (message.tasks?.length === 1 && message.tasks[0]?.id) return message.tasks[0].id;
  return "";
}

const TASK_ACCENTS = ["#3b6de0", "#0d8a72", "#7c4dff", "#c47000", "#c93b6b", "#0881a3", "#3f8629", "#933ea8"];

/** Deterministic subtle accent color per task so concurrent group tasks stay visually distinct. */
export function taskAccentColor(taskId) {
  const key = String(taskId || "");
  if (!key) return "";
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return TASK_ACCENTS[(hash >>> 0) % TASK_ACCENTS.length];
}

function compactObjectUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts.at(-1);
    if (last && last.length <= 28 && !/^[a-f\d]{24,}$/i.test(last)) return `${parsed.hostname}/${last}`;
    return parsed.hostname;
  } catch {
    return "";
  }
}

/** Single-line task title: keep ticket/PR IDs and compact object URLs instead of leaving bare colons. */
export function cleanTaskTitle(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  let cleaned = raw.replace(
    /(?:([:：])\s*)?(https?:\/\/[^\s"'<>。，；！？、）】》”’]+)(\s*(?=[。，；！？、）】》”’,.;]|$))?/gi,
    (_, colon, url, trailing) => {
      const suffix = trailing || "";
      const ticket = /(?:story|bug|task|defect|iteration|workitem|issues?|pull|pulls|merge_requests|tickets?)(?:\/detail)?\/(\d{3,})/i.exec(url);
      if (ticket) return ` #${ticket[1]}${suffix}`;
      if (colon) {
        const compact = compactObjectUrl(url);
        if (compact) return ` ${compact}${suffix}`;
      }
      return suffix;
    },
  );
  cleaned = cleaned
    .replace(/[:：]\s*(?=[。，；！？,.]|$)/g, "")
    .replace(/\s+([。，；！？、）】》”’])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  const unwrapped = cleaned.replace(/^用户(?:要求|希望|交代|让我|请)\s*/, "").trim();
  if (unwrapped.length >= 6) cleaned = unwrapped;
  return cleaned.length >= 6 ? cleaned : raw;
}

/** Clear display title for a task object or string, preferring explicit title and appending key/ID when distinct. */
export function taskDisplayTitle(taskOrText) {
  if (!taskOrText) return "";
  if (typeof taskOrText === "string") return cleanTaskTitle(taskOrText);
  if (typeof taskOrText.title === "string" && taskOrText.title.trim()) return cleanTaskTitle(taskOrText.title);
  const base = cleanTaskTitle(taskOrText.text || "");
  const key = String(taskOrText.key || taskOrText.dedupeKey || "").trim();
  if (key) {
    const tail = key.split(/[:/]/).at(-1) || key;
    const hasKey = base.includes(key) || (tail.length >= 4 && base.includes(tail));
    if (!hasKey) {
      const tag = /^\d+$/.test(tail) ? `#${tail}` : `(${key})`;
      return base ? `${base} ${tag}` : tag;
    }
  }
  return base || String(taskOrText.id || "");
}

/** Consecutive non-notice messages from the same sender and task group visually without repeating avatar and name. */
export function continuesPrevious(previous, message) {
  if (!previous || !message || previous.notice || message.notice) return false;
  if (previous.role !== message.role) return false;
  if (previous.author?.id !== message.author?.id || previous.author?.kind !== message.author?.kind) return false;
  return messageTaskId(previous) === messageTaskId(message);
}

export function chatCardVisibility(messages, taskStatus) {
  const visibility = new Array(messages.length), later = new Map();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i], next = messages[i + 1];
    if (message.role !== "assistant" || message.notice) { later.clear(); continue; }
    if (message.author?.id !== next?.author?.id || message.author?.kind !== next?.author?.kind) later.clear();
    const tasks = message.tasks || [], related = new Set(tasks.map((task) => task.id));
    related.add(message.topicTaskId);
    for (const id of later.keys()) if (!related.has(id)) later.delete(id);

    const hiddenTaskIds = new Set();
    for (const { id } of tasks) {
      if (!id) continue;
      if (later.has(id)) hiddenTaskIds.add(id);
      else later.set(id, new Set());
    }
    const taskId = tasks[0]?.id, status = taskStatus?.[taskId], output = message.stepOutput, steps = later.get(taskId);
    let hideStepOutput = false;
    // Historical cards can be the only way to open the original artifact after a task is deleted.
    if (steps && status && status !== "deleted" && !output?.legacy && output?.step > 0 && output.label) {
      const key = JSON.stringify([output.step, output.label]);
      hideStepOutput = steps.has(key);
      steps.add(key);
    }
    if (hiddenTaskIds.size || hideStepOutput) visibility[i] = { hiddenTaskIds, hideStepOutput };
  }
  return visibility;
}

/** Adjacent thoughts/tools form one process segment; visible text and model changes break it. */
export function timelineOf(messages, modelState = {}) {
  const groups = [];
  const completedCalls = new Set(messages.filter((message) => message.role === "tool").map((message) => message.callId));
  const callById = new Map();
  for (const message of messages)
    for (const call of message.calls || [])
      if (call?.id) callById.set(call.id, call);
  let previousRole = "";
  const withArgs = (item, call) =>
    call?.arguments != null && item.arguments == null ? { ...item, arguments: call.arguments } : item;
  const addProcess = (item) => {
    const last = groups.at(-1);
    if (last?.kind === "process") last.items.push(item);
    else
      groups.push({
        kind: "process",
        key: `process-${item.callId || item.id || item.seq || groups.length}`,
        items: [item],
      });
  };
  for (const m of messages) {
    if (m.role === "tool") {
      addProcess(withArgs(m, callById.get(m.callId)));
      if (m.name === "switch_scene" && !m.error) modelState.current = "";
    } else {
      if (m.role === "assistant" && m.model && m.model !== modelState.current) {
        groups.push({ kind: "model", key: `model-${m.seq ?? groups.length}`, model: m.model });
        modelState.current = m.model;
      }
      if (m.thinking?.trim())
        addProcess({ ...m, role: "thought", text: m.thinking, thinking: undefined });
      if (m.role !== "assistant" || m.text?.trim() || m.images?.length) {
        groups.push({
          kind: "message",
          key: `${m.role}-${m.seq ?? groups.length}`,
          message: m,
          continuation: m.role === "assistant" && previousRole === "assistant",
        });
      }
      for (const call of m.calls || [])
        if (!completedCalls.has(call.id))
          addProcess({ role: "tool", id: call.id, name: call.name, arguments: call.arguments, pending: true });
    }
    previousRole = m.role;
  }
  return groups;
}

export function conversationTurns(messages, { running = false, thinking = "", live = "", model = "" } = {}, previous = []) {
  const turns = groupTurns(messages);
  const bySeq = new Map();
  for (const turn of previous) for (const message of [turn.user, ...turn.body])
    if (message?.seq != null) bySeq.set(message.seq, turn);
  const itemKey = (item) => `${item.role}-${item.callId || item.id || item.seq}`;
  if (running && !turns.length) turns.push({ user: null, body: [], process: [], conclusion: [] });
  return turns.map((turn, index) => {
    const active = running && index === turns.length - 1, modelState = {};
    const rows = active && model ? [...turn.body, { role: "assistant", seq: "live-model", model }] : active ? turn.body : turn.process;
    const process = timelineOf(rows, modelState), conclusion = [];
    const appendThoughts = (items) => {
      const last = process.at(-1);
      if (last?.kind === "process") last.items.push(...items);
      else process.push({ kind: "process", key: `process-final-thoughts-${items[0].seq ?? process.length}`, items });
    };
    // Reasoning stays in the fold, with the model line that precedes it.
    if (!active) for (const entry of timelineOf(turn.conclusion, modelState)) {
      if (entry.kind !== "process") conclusion.push(entry);
      else {
        if (conclusion.at(-1)?.kind === "model") process.push(conclusion.pop());
        appendThoughts(entry.items);
      }
    }
    if (active && thinking) appendThoughts([{ role: "thought", seq: "live-thought", text: thinking }]);
    if (active && live) process.push({ kind: "message", key: "assistant-live", message: { role: "assistant", text: live, streaming: true }, continuation: false });
    const lastGroup = process.findLastIndex((entry) => entry.kind !== "message");
    // Prepending can reveal a turn's user or the beginning of an open tool group: keep mounted folds by overlap.
    const old = bySeq.get(turn.user?.seq) || turn.body.map((message) => bySeq.get(message.seq)).find(Boolean);
    const keys = new Map(), used = new Set();
    for (const entry of old?.process || []) if (entry.kind === "process")
      for (const item of entry.items) keys.set(itemKey(item), entry.key);
    for (const entry of process) if (entry.kind === "process") {
      const key = entry.items.map((item) => keys.get(itemKey(item))).find((key) => key != null && !used.has(key));
      entry.key = key ?? entry.key;
      used.add(entry.key);
    }
    return {
      ...turn,
      key: old?.key ?? `turn-${turn.user?.seq ?? turn.body[0]?.seq ?? "live"}`,
      running: active,
      process,
      lastProcessIndex: process[lastGroup]?.kind === "process" ? lastGroup : -1,
      conclusion,
    };
  });
}

export function toolKind(name = "") {
  const normalized = String(name).trim().toLowerCase();
  const base = normalized.split("__").at(-1);
  if (/^(?:read|read_file|read_image)$/.test(base)) return "read";
  if (/^(?:edit|write|apply_patch|multi_edit)$/.test(base)) return "edit";
  if (/^(?:delete|remove|delete_file)$/.test(base)) return "delete";
  if (/^(?:search|grep|glob|find|list_files)$/.test(base)) return "search";
  if (/^(?:bash|shell|execute|exec)$/.test(base)) return "execute";
  if (/^(?:think|thinking)$/.test(base)) return "think";
  if (/^(?:fetch|web_fetch|http_fetch)$/.test(base)) return "fetch";
  return "tool";
}

const DETAIL_KEYS = {
  execute: ["command", "cmd"],
  read: ["path", "file", "target"],
  edit: ["path", "file"],
  delete: ["path", "file"],
  search: ["pattern", "query", "glob", "path"],
  fetch: ["url", "uri", "href"],
  tool: ["command", "path", "query", "url", "prompt"],
};

/** One-line label for a tool row: bash shows the command, others show name · key arg. */
export function toolCaption(item, limit = 120) {
  const name = String(item?.name || "工具").replace(/\s+/g, " ").trim() || "工具";
  const args = item?.arguments;
  const kind = toolKind(name);
  let detail = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const key of DETAIL_KEYS[kind] || DETAIL_KEYS.tool) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        detail = value.trim();
        break;
      }
    }
  }
  detail = detail.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  if (detail.length > limit) detail = detail.slice(0, Math.max(0, limit - 1)) + "…";
  if (!detail) return name;
  if (kind === "execute") return detail;
  return `${name} · ${detail}`;
}

const ACTION_LABEL = {
  read: "读取文件",
  edit: "修改文件",
  delete: "删除文件",
  search: "搜索文件与资料",
  execute: "执行命令",
  think: "分析思路",
  fetch: "获取资料",
  tool: "调用工具",
};

export function processSummary(items) {
  const tools = items.filter((item) => item.role === "tool");
  const counts = new Map();
  for (const tool of tools) {
    const label = ACTION_LABEL[toolKind(tool.name)];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const actions = [...counts].map(([label, n]) => `${label} ×${n}`);
  const failed = tools.filter((item) => item.error).length;
  const pending = tools.filter((item) => item.pending && !item.active).length;
  return (actions.join("、") || "分析思路") + (failed ? `（${failed} 项失败）` : "") + (pending ? `（${pending} 项结果待确认）` : "");
}

export function processLiveLines(items, wrap = (text) => text.split("\n")) {
  let lines = [];
  for (let i = items.length - 1; i >= 0 && lines.length < 2; i--) {
    const item = items[i];
    const status = item.role === "tool"
      ? item.error ? "失败" : item.active ? "进行中" : item.pending ? "结果未确认" : "已完成"
      : "";
    const text = item.role === "thought"
      ? item.text?.trimEnd() || "思考中…"
      : `${status} · ${toolCaption(item)}`;
    lines = [...wrap(text).filter((line) => line.trim()).slice(-(2 - lines.length)), ...lines];
  }
  return lines;
}

const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;

export function turnStats(messages, startedAt) {
  const times = messages.map((m) => m.at).filter((at) => finite(at) > 0);
  if (finite(startedAt) > 0) times.push(startedAt);
  const durationMs = times.length > 1 ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0;
  const stats = { durationMs, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const message of messages) {
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    stats.inputTokens += finite(usage.input);
    stats.outputTokens += finite(usage.output);
    stats.cacheReadTokens += finite(usage.cacheRead);
    stats.cacheWriteTokens += finite(usage.cacheWrite);
    stats.totalTokens += finite(usage.totalTokens) ||
      finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
  }
  return stats;
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
