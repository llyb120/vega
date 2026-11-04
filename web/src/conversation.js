export function groupTurns(messages) {
  const turns = [];
  let current;
  for (const message of messages) {
    if (message.role === "user" || !current) {
      current = { user: null, body: [] };
      turns.push(current);
    }
    if (message.role === "user") current.user = message;
    else current.body.push(message);
  }
  return turns.map((turn) => {
    let conclusion = -1;
    for (let i = turn.body.length - 1; i >= 0; i--) {
      if (turn.body[i].role !== "assistant" || turn.body[i].calls?.length || !(turn.body[i].text?.trim() || turn.body[i].images?.length)) break;
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
  return messages.filter((message) => message.role === "user" || message.delivery ||
    (message.role === "assistant" && !!(message.text?.trim() || message.images?.length)));
}

/** A bubble continues the previous one (no repeated avatar/name) inside one reply run; deliveries and progress notices stand alone. */
export function continuesPrevious(previous, message) {
  const standalone = (m) => m.delivery || m.progress;
  return !!previous && previous.role !== "user" && message.role !== "user" && !standalone(previous) && !standalone(message);
}

/** Match Nova: adjacent thoughts/tools form one process segment; text breaks it. */
export function timelineOf(messages) {
  const groups = [];
  const completedCalls = new Set(messages.filter((message) => message.role === "tool").map((message) => message.callId));
  let previousRole = "";
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
    if (m.role === "tool") addProcess(m);
    else {
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
        if (!completedCalls.has(call.id)) addProcess({ role: "tool", id: call.id, name: call.name, pending: true });
    }
    previousRole = m.role;
  }
  return groups;
}

export function conversationTurns(messages, { running = false, thinking = "", live = "" } = {}, previous = []) {
  const turns = groupTurns(messages);
  const bySeq = new Map();
  for (const turn of previous) for (const message of [turn.user, ...turn.body])
    if (message?.seq != null) bySeq.set(message.seq, turn);
  const itemKey = (item) => `${item.role}-${item.callId || item.id || item.seq}`;
  if (running && !turns.length) turns.push({ user: null, body: [], process: [], conclusion: [] });
  return turns.map((turn, index) => {
    const active = running && index === turns.length - 1;
    const process = timelineOf(active ? turn.body : turn.process);
    const conclusion = active ? [] : timelineOf(turn.conclusion);
    const appendThoughts = (items) => {
      const last = process.at(-1);
      if (last?.kind === "process") last.items.push(...items);
      else process.push({ kind: "process", key: "process-final-thoughts", items });
    };
    // Final answers can carry reasoning too; keep that reasoning in the fold, not in the result.
    for (const entry of conclusion) if (entry.kind === "process") appendThoughts(entry.items);
    if (active && thinking) appendThoughts([{ role: "thought", seq: "live-thought", text: thinking }]);
    if (active && live) process.push({ kind: "message", key: "assistant-live", message: { role: "assistant", text: live, streaming: true }, continuation: false });
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
      lastProcessIndex: process.findLastIndex((entry) => entry.kind === "process"),
      conclusion: conclusion.filter((entry) => entry.kind === "message"),
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
      : `${status} · ${String(item.name || "工具").replace(/\s+/g, " ").trim()}`;
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
