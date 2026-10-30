import type { Message } from "./store";
import type { Obj } from "./util";
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
  options: {
    completedBefore?: number;
    stripReasoning?: boolean;
    trimImages?: boolean;
  } = {},
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
    if (
      m.role === "assistant" &&
      options.stripReasoning &&
      (m.seq ?? Infinity) < (options.completedBefore ?? 0)
    ) {
      m.thinking = undefined;
      m.signature = undefined;
      m.opaque = undefined;
    }
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
  const dom = new Map<string, number>(),
    images = new Map<string, number>();
  let otherImages = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    let m = rows[i];
    if (m.role !== "tool") continue;
    const parsed = m.name === "chrome" ? resultBody(m) : undefined,
      tab = parsed?.value.tabTag;
    if (tab && parsed?.value.pages?.length) {
      const n = (dom.get(tab) || 0) + 1;
      dom.set(tab, n);
      if (n > 2) {
        const value = { ...parsed.value };
        delete value.pages;
        value.domOmitted =
          "Only the latest two DOM observations for this tab remain in context; original data is available at documentPath.";
        m = rows[i] = { ...m, text: parsed.prefix + JSON.stringify(value) };
      }
    }
    if (!m.images?.length) continue;
    const stream =
      m.name === "chrome"
        ? "chrome:" +
          (tab || parsed?.value.images?.[0]?.frameStream || "default")
        : "other";
    const count = images.get(stream) || 0,
      drop =
        m.name === "chrome"
          ? count >= 2
          : !!options.trimImages && otherImages >= 2;
    if (m.name !== "chrome") otherImages++;
    if (drop)
      rows[i] = {
        ...m,
        images: [],
        text:
          (m.text || "") +
          "\n[Older tool image omitted from model view; original image/metadata remains archived in SQLite.]",
      };
    images.set(stream, count + 1);
  }
  return rows;
}
