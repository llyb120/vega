import { CHROME_TOOLS, LEGACY_CHROME_TOOLS } from "./public-tools";
import type { Message } from "./store";
import { clip, type Obj } from "./util";

const isBrowserToolName = (name: string) => CHROME_TOOLS.has(name) || LEGACY_CHROME_TOOLS.has(name);
const isAppuseToolName = (name: string) => name.startsWith("appuse_") || name.startsWith("jianlai_");
export type Unit = { start: number; end: number; ref?: number; open: boolean };
export const refName = (seq: number) => "m" + String(seq).padStart(5, "0");
export function units(rows: Message[]): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  const text = (m: Message) => m.role === "assistant" && !m.calls?.length;
  while (i < rows.length) {
    const m = rows[i];
    let end = i + 1,
      ref: number | undefined,
      open = false;
    if (m.role === "user") {
      ref = m.seq;
      while (end < rows.length && text(rows[end])) end++;
    } else if (m.role === "assistant" && m.calls?.length) {
      const ids = new Set(m.calls.map((c) => c.id)),
        seen = new Set<string>();
      while (end < rows.length && rows[end].role === "tool") {
        const r = rows[end];
        seen.add(r.callId!);
        ref ??= r.seq;
        end++;
      }
      open = [...ids].some((id) => !seen.has(id));
      if (!open) while (end < rows.length && text(rows[end])) end++;
    }
    out.push({
      start: m.seq ?? i + 1,
      end: rows[end - 1].seq ?? end,
      ref,
      open,
    });
    i = end;
  }
  return out;
}
export function protectedStart(rows: Message[]) {
  const all = units(rows),
    keep = Math.max(0, all.length - 2),
    open = all.findIndex((u) => u.open),
    at = open < 0 ? keep : Math.min(keep, open);
  return all[at]?.start ?? (rows.at(-1)?.seq ?? 0) + 1;
}
function resultBody(m: Message): { prefix: string; value: Obj } | undefined {
  const text = m.text || "",
    tag = /^\[m\d+\]\s*/.exec(text),
    prefix = tag?.[0] || "";
  try {
    return { prefix, value: JSON.parse(text.slice(prefix.length)) };
  } catch {
    return;
  }
}
const privateTools = new Set(["bash", "bash_poll", "read", "write", "edit", "mcp", "polaris", "recall", "search_context"]);
// Keep partial/uncertain outcomes even when the full result is archived before projection.
function receiptFields(value: Obj | undefined) {
  const fields: Obj = {};
  for (const k of ["status", "inputAttempted", "completedActions", "verification", "exitCode", "jobId", "error", "reason", "observationError"]) {
    const v = value?.[k];
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") fields[k] = typeof v === "string" ? v.slice(0, 240) : v;
  }
  return fields;
}
/** Only the request view changes. Shared instructions, conclusions, plan and switch receipts stay verbatim. */
export function sceneHistory(rows: Message[], scene?: string): Message[] {
  const foreign = new Set<string>();
  return rows.map(row => {
    if (row.role === "tool") {
      if (!foreign.delete(row.callId!)) return row;
      const text = row.text || "";
      if (!row.images?.length && text.length <= 480) return row;
      const parsed = resultBody(row)?.value;
      const receipt = receiptFields(parsed);
      for (const k of ["tab", "tabTag", "documentPath", "archivePath"]) if (typeof parsed?.[k] === "string") receipt[k] = parsed[k];
      const files = row.images?.slice(-8).map(im => im.url || im.path || im.blobId).filter(Boolean);
      return { ...row, images: undefined, text: `[Scene receipt #${row.seq}; original: recall(positions:[${row.seq}]); do not replay] ` +
        JSON.stringify({ ...receipt, ...(files?.length ? { files } : {}), ...(row.error || !Object.keys(receipt).length ? { excerpt: text.slice(0, 180) } : {}) }) };
    }
    foreign.clear();
    if (!row.calls?.length) return row;
    const { toolScene, ...m } = row;
    if (!scene || toolScene === scene) return m;
    let changed = false;
    const calls = row.calls.map(c => {
      // Legacy batches have no provenance: Chrome alone unambiguously identifies its scene.
      if (!(toolScene ? privateTools.has(c.name) || isBrowserToolName(c.name) || c.name.startsWith("jianlai_") || c.name.startsWith("appuse_") : scene !== "computer" && isBrowserToolName(c.name))) return c;
      foreign.add(c.id);
      changed = true;
      if (JSON.stringify(c.arguments).length <= 320) return c;
      return { ...c, arguments: { archived: `see original batch #${row.seq}`, ...(typeof c.arguments.path === "string" ? { path: c.arguments.path.slice(0, 240) } : {}) } };
    });
    return changed ? { ...m, calls, thinking: undefined, opaque: undefined, signature: undefined } : m;
  });
}
export function promptHistory(
  input: Message[],
  options: { trimImages?: boolean } = {},
): Message[] {
  const rows: Message[] = [],
    pending = new Map<string, string>();
  const close = () => {
    for (const [id, name] of pending)
      rows.push({
        role: "tool",
        callId: id,
        name,
        error: true,
        text: "Interrupted or missing tool result. It may have executed; inspect actual state, do not replay automatically.",
      });
    pending.clear();
  };
  for (const original of input) {
    const m = { ...original };
    if (m.runtime === "turn_aborted") m.role = "user";
    if (m.role === "tool") {
      if (!m.callId || !pending.has(m.callId)) continue;
      pending.delete(m.callId);
      rows.push(m);
      continue;
    }
    close();
    if (m.calls?.length) {
      const seen = new Set<string>();
      m.calls = m.calls.filter((c) => {
        if (!c.id || seen.has(c.id)) return false;
        seen.add(c.id);
        pending.set(c.id, c.name);
        return true;
      });
    }
    rows.push(m);
  }
  close();
  const dom = new Map<string, number>();
  for (let i = rows.length - 1; i >= 0; i--) {
    let m = rows[i];
    if (m.role !== "tool") continue;
    const browser = isBrowserToolName(m.name || ""),
      appuse = !browser && isAppuseToolName(m.name || "");
    if (!browser && !appuse) continue;
    const parsed = resultBody(m),
      value = parsed?.value;
    if (!value) continue;
    if (browser) {
      const tab = value.tabTag ?? value.tab;
      // An archived observation keeps documentPath; its preview stands in for pages / frameStream.
      const hasDom = Boolean(
        value.pages?.length ||
          value.frameStream?.length ||
          typeof value.elements === "string" ||
          typeof value.text === "string" ||
          (value.archivePath && value.documentPath && value.preview),
      );
      if (tab && hasDom) {
        const n = (dom.get(`browser:${tab}`) || 0) + 1;
        dom.set(`browser:${tab}`, n);
        if (n > 2) {
          const { pages: _pages, frameStream: _frameStream, preview: _preview, elements: _elements, text: _text, ...rest } = value;
          rest.domOmitted = rest.documentPath
            ? `[DOM 已移出上下文：${rest.documentPath}，需要时用 read 分页读回]`
            : "该标签仅保留最近两次 DOM；旧观察正文已省略。";
          m = rows[i] = { ...m, text: parsed!.prefix + JSON.stringify(rest) };
        }
      }
    } else {
      const hasControls = Boolean(
        (Array.isArray(value.elements) && value.elements.length) ||
          typeof value.elements === "string" ||
          (Array.isArray(value.items) && value.items.length),
      );
      if (!hasControls) continue;
      const stream =
        value.images?.[0]?.frameStream ||
        value.images?.[0]?.imageId ||
        (value.windowId != null ? `win-${value.windowId}` : "desktop");
      const n = (dom.get(`appuse:${stream}`) || 0) + 1;
      dom.set(`appuse:${stream}`, n);
      if (n > 2) {
        const { elements: _elements, items: _items, ...rest } = value;
        rest.elementsOmitted = "仅保留最近两次桌面控件清单；旧控件列表已省略。";
        m = rows[i] = { ...m, text: parsed!.prefix + JSON.stringify(rest) };
      }
    }
  }
  return historyImages(rows, options);
}

/** Text kept in context for an oversized result. Chrome results keep the fields history pruning relies on. */
export function archivedResult(name: string, value: Obj, raw: string, archivePath: string, warning?: string) {
  const tail = { archivePath, truncated: true, ...(warning ? { archiveWarning: warning } : {}), next: "完整结果已保存于 archivePath，用 read 按 offset/limit 分页读，hasMore 时从 nextOffset 继续" };
  if (!isBrowserToolName(name) || !value || typeof value !== "object") return JSON.stringify({ ...receiptFields(value), preview: clip(raw, 32000), ...tail });
  const { tab, tabTag, snapshotId, images, documentPath, ...rest } = value,
    head = { ...receiptFields(value), ...(tab !== undefined ? { tab } : {}), ...(tabTag !== undefined ? { tabTag } : {}), snapshotId, images, documentPath };
  return JSON.stringify({ ...head, preview: clip(JSON.stringify(rest), Math.max(4000, 32000 - JSON.stringify(head).length)), ...tail });
}

/**
 * Chrome & appuse images show a page/desktop state that later operations make stale: per stream only the images of the latest two
 * image-bearing results stay (all images of one result together, duplicate frames counted once); the rest become
 * their file paths, readable with read. Other tools' images
 * may stay useful and are only trimmed beyond two when trimImages is set.
 */
export function historyImages(
  input: Message[],
  options: { trimImages?: boolean } = {},
): Message[] {
  const rows = [...input], tabs = new Map<string, { results: number; paths: Set<string> }>();
  let otherImages = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    if (m.role !== "tool" || !m.images?.length) continue;
    const chrome = isBrowserToolName(m.name || ""),
      appuse = !chrome && isAppuseToolName(m.name || ""),
      parsed = chrome || appuse ? resultBody(m) : undefined;
    const keep = m.images.map(() => true);
    if (chrome || appuse) {
      const key = chrome
        ? `browser:${String(parsed?.value.tabTag ?? parsed?.value.tab ?? "")}`
        : `appuse:${String(
            parsed?.value.images?.[0]?.frameStream ??
              (m.images[0] as Obj)?.frameStream ??
              parsed?.value.images?.[0]?.imageId ??
              (parsed?.value.windowId != null ? `win-${parsed.value.windowId}` : "desktop"),
          )}`;
      let tab = tabs.get(key);
      if (!tab) tabs.set(key, tab = { results: 0, paths: new Set() });
      const full = tab.results >= 2;
      const paths = m.images.map((image) => image.path);
      paths.forEach((path, j) => { keep[j] = !full && !(path && tab.paths.has(path)); });
      paths.forEach((path, j) => { if (keep[j] && path) tab.paths.add(path); });
      if (keep.some(Boolean)) tab.results++;
    } else if (otherImages++ >= 2 && options.trimImages) keep.fill(false);
    if (keep.every(Boolean)) continue;
    const omitted = m.images.filter((_, j) => !keep[j]).map((image) => image.path).filter((path, j, all) => path && all.indexOf(path) === j);
    const notice = chrome
      ? `[截图已移出上下文：${omitted.join("，")}，需要时用 read 读回；看页面现状请重新截图]`
      : appuse
        ? `[桌面截图已移出上下文：${omitted.join("，")}，需要时用 read 或 appuse_recall 读回；看桌面现状请重新观察]`
        : "Older tool images omitted from model view; original images/metadata remain archived.";
    rows[i] = {
      ...m,
      images: m.images.filter((_, j) => keep[j]),
      text: parsed
        // The notice stands in for the images; their metadata is dropped with them when none is left.
        ? parsed.prefix + JSON.stringify({ ...parsed.value, images: keep.some(Boolean) ? parsed.value.images : undefined, imagesOmitted: notice })
        : (m.text || "") + "\n[" + notice + "]",
    };
  }
  return rows;
}
