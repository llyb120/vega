import { CHROME_TOOLS } from "./public-tools";
import type { Message } from "./store";
import { clip, type Obj } from "./util";
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
    const parsed = CHROME_TOOLS.has(m.name || "") ? resultBody(m) : undefined,
      value = parsed?.value,
      tab = value?.tabTag;
    // An archived observation keeps documentPath; its preview stands in for pages.
    if (tab && (value.pages?.length || (value.archivePath && value.documentPath && value.preview))) {
      const n = (dom.get(tab) || 0) + 1;
      dom.set(tab, n);
      if (n > 2) {
        const { pages: _pages, preview: _preview, ...rest } = value;
        rest.domOmitted =
          "Only the latest two DOM observations for this tab remain in context; original data is available at documentPath.";
        m = rows[i] = { ...m, text: parsed!.prefix + JSON.stringify(rest) };
      }
    }
  }
  return historyImages(rows, options);
}

/** Text kept in context for an oversized result. Chrome results keep the fields history pruning relies on. */
export function archivedResult(name: string, value: Obj, raw: string, archivePath: string) {
  const tail = { archivePath, truncated: true, next: "完整结果用 read 按 offset/limit 分页读 archivePath，hasMore 时从 nextOffset 继续" };
  if (!CHROME_TOOLS.has(name) || !value || typeof value !== "object") return JSON.stringify({ preview: clip(raw, 32000), ...tail });
  const { tabTag, snapshotId, images, documentPath, ...rest } = value,
    head = { tabTag, snapshotId, images, documentPath };
  return JSON.stringify({ ...head, preview: clip(JSON.stringify(rest), Math.max(4000, 32000 - JSON.stringify(head).length)), ...tail });
}

/**
 * Chrome images show a page state that later operations make stale: per tab only the images of the latest two
 * image-bearing results stay (all images of one result together, duplicate frames counted once). Other tools' images
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
    const chrome = CHROME_TOOLS.has(m.name || ""),
      parsed = chrome ? resultBody(m) : undefined;
    const keep = m.images.map(() => true);
    if (chrome) {
      const metadata: Obj[] = Array.isArray(parsed?.value.images) ? parsed.value.images : [];
      const key = String(parsed?.value.tabTag ?? "");
      let tab = tabs.get(key);
      if (!tab) tabs.set(key, tab = { results: 0, paths: new Set() });
      const full = tab.results >= 2;
      // Earlier projections may have removed sibling attachments; archive blob IDs keep the mapping stable.
      const paths = m.images.map((image, j) => {
        const meta = metadata.length === m.images!.length ? metadata[j] : metadata.find(v => image.blobId && v.blobId === image.blobId);
        return meta?.path || image.blobId;
      });
      paths.forEach((path, j) => { keep[j] = !full && !(path && tab.paths.has(path)); });
      paths.forEach((path, j) => { if (keep[j] && path) tab.paths.add(path); });
      if (keep.some(Boolean)) tab.results++;
    } else if (otherImages++ >= 2 && options.trimImages) keep.fill(false);
    if (keep.every(Boolean)) continue;
    const notice = "Older tool images omitted from model view; original images/metadata remain archived in SQLite.";
    rows[i] = {
      ...m,
      images: m.images.filter((_, j) => keep[j]),
      text: parsed
        ? parsed.prefix + JSON.stringify({ ...parsed.value, imagesOmitted: notice })
        : (m.text || "") + "\n[" + notice + "]",
    };
  }
  return rows;
}
