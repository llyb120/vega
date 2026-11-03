import { assert, type Obj } from "./util";
import { normalizeAction } from "./browser-actions";

export function validatePlan(plan: Obj) {
  const valid = (s: unknown, max: number) => typeof s === "string" && !!s.trim() && s.length <= max;
  assert(plan && valid(plan.task, 2000) && Array.isArray(plan.steps) && plan.steps.length >= 1 && plan.steps.length <= 24, "run requires task and 1–24 steps");
  const fieldsOnly = (value: Obj, keys: string[]) => assert(Object.keys(value).every((key) => keys.includes(key)), "Unknown run plan field");
  fieldsOnly(plan, ["task", "authorization", "expectedText", "inputs", "steps", "maxActions", "controlNames", "useExperience"]);
  assert(Number.isInteger(plan.maxActions ?? 32) && (plan.maxActions ?? 32) >= 1 && (plan.maxActions ?? 32) <= 64, "maxActions must be 1–64");
  for (const [key, max] of [["authorization", 1000], ["expectedText", 500]] as const)
    if (plan[key] !== undefined) assert(valid(plan[key], max), `Invalid plan.${key}`);
  assert(plan.inputs === undefined || (Array.isArray(plan.inputs) && plan.inputs.length <= 8), "Use at most 8 plan inputs");
  const fields = new Set<string>();
  for (const input of plan.inputs || []) {
    assert(input && typeof input.text === "string" && input.text.length <= 4000 && typeof input.name === "string" && input.name.length <= 300 && (input.name.trim() || input.role || input.fieldContext), "Invalid plan input");
    fieldsOnly(input, ["name", "role", "fieldContext", "text"]);
    if (input.role !== undefined) assert(valid(input.role, 80), "Invalid input role");
    if (input.fieldContext !== undefined) assert(valid(input.fieldContext, 600), "Invalid input fieldContext");
    const key = JSON.stringify([input.name, input.role, input.fieldContext]);
    assert(!fields.has(key), "Duplicate plan input"); fields.add(key);
  }
  for (const step of plan.steps) {
    assert(step && ["click", "fill", "press", "scroll"].includes(step.action), "Invalid run action");
    fieldsOnly(step, ["action", "target", "name", "role", "within", "text", "key", "direction", "when", "expect", "expectedText", "repeat", "optional"]);
    for (const [key, max] of [["target", 300], ["name", 300], ["role", 80], ["within", 300], ["when", 500], ["expect", 500], ["expectedText", 500]] as const)
      if (step[key] !== undefined) assert(valid(step[key], max), `Invalid step.${key}`);
    assert(Number.isInteger(step.repeat ?? 0) && (step.repeat ?? 0) >= 0 && (step.repeat ?? 0) <= 3, "repeat must be 0–3");
    assert(step.optional === undefined || typeof step.optional === "boolean", "Invalid optional flag");
    if (["click", "fill"].includes(step.action)) assert(step.name || step.target, "click/fill requires name or target");
    if (step.action === "fill") assert(typeof step.text === "string" && step.text.length <= 4000, "fill requires text up to 4000 characters");
    else assert(step.text === undefined, "Only fill accepts text");
    if (step.action === "press") {
      assert(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space", "Backspace"].includes(step.key), "Invalid run key");
      normalizeAction({ action: "press", key: step.key });
    } else assert(step.key === undefined, "Only press accepts key");
    if (step.direction !== undefined) assert(step.action === "scroll" && ["up", "down", "left", "right"].includes(step.direction), "Invalid scroll direction");
  }
}

export function literalMet(pages: Obj[], expected: string) {
  const text = pages.map((p) => `${p.url || ""} ${p.visibleText ?? p.text ?? ""} ${p.title || ""}`).join("\n").toLowerCase();
  return expected.split(/[|｜]/).map((s) => s.trim().toLowerCase()).filter(Boolean).some((s) => text.includes(s));
}

export type Candidate = { action: Obj; item: Obj; key: string; loose: string; fresh?: boolean };
export function runCandidates(pages: Obj[]): Candidate[] {
  const out: Candidate[] = [];
  const add = (action: Obj, item: Obj, state: unknown) => {
    const loose = JSON.stringify([action.action, action.frame, item.name, item.role, item.region, item.fieldContext, item.column?.name, item.href, Math.sign(action.delta || action.delta_x || 0)]);
    out.push({ action, item, loose, key: JSON.stringify([loose, item.nodeId, state]) });
  };
  for (const [frame, page] of pages.entries()) {
    const scrolls = (item?: Obj) => {
      for (const horizontal of [false, true]) {
        const s = item?.scroll, vp = page.viewport || {}, doc = page.documentSize || {};
        const top = item ? s?.[horizontal ? "left" : "top"] : vp[horizontal ? "scrollX" : "scrollY"];
        const size = item ? s?.[horizontal ? "width" : "height"] : doc[horizontal ? "width" : "height"];
        const extent = item ? s?.[horizontal ? "viewportWidth" : "viewportHeight"] : vp[horizontal ? "width" : "height"];
        const min = horizontal ? (item ? s?.minLeft : vp.minScrollX) || 0 : 0;
        if (![top, size, extent].every(Number.isFinite) || extent <= 0 || size <= extent || (item?.blockedBy && !s?.[horizontal ? "pointX" : "pointY"])) continue;
        const amount = Math.round(Math.max(80, Math.min(1200, extent * 0.8)));
        for (const delta of [-amount, amount]) {
          if ((delta < 0 && top <= min) || (delta > 0 && top >= min + size - extent - 1)) continue;
          add({ action: "scroll", frame, ...(item ? { ref: item.ref } : {}), delta: horizontal ? 0 : delta, ...(horizontal ? { delta_x: delta } : {}) }, { ...item, direction: horizontal ? delta > 0 ? "right" : "left" : delta > 0 ? "down" : "up" }, [top, size, extent]);
        }
      }
    };
    if (frame === 0) scrolls();
    for (const item of page.items || []) {
      if (item.inView !== true || item.disabled || typeof item.ref !== "string" || (item.name || "").length > 300) continue;
      scrolls(item);
      if (item.blockedBy || item.password) continue;
      if (!item.editable && !item.actionable && !["button", "a", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "checkbox", "combobox", "summary"].includes(item.role) && !["true", "menu", "listbox", "tree", "grid", "dialog"].includes(item.haspopup) && !((item.role === "input" || item.column) && item.tabIndex >= 0 && !item.scroll)) continue;
      add({ action: "click", frame, ref: item.ref }, item, [item.selected, item.expanded, item.sort, item.icon, item.column]);
    }
  }
  return out;
}

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
function terms(text: string) {
  const words = new Set<string>();
  const stop = new Set("the and or to of in on for an by with then is be it as at all only".split(" "));
  for (const part of lower(text).match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+|[\p{L}\p{N}]+/gu) || []) {
    if (/^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(part)) for (let i = 0; i + 1 < part.length; i++) words.add(part.slice(i, i + 2));
    else if (part.length >= 2 && !stop.has(part)) words.add(part);
  }
  return words;
}
const generic = terms("点击 click 按钮 button 复选框 勾选 checkbox 输入框 文本框 input 图标 icon 排序 链接 link 菜单 menu 选项 option 下的 里的 中的 面板 panel 的 列 column");
function negated(target: string, name: string) {
  if (name.length < 8 && !name.includes(" ")) return false;
  let found = false, offset = 0;
  for (;;) {
    const at = target.indexOf(name, offset);
    if (at < 0) return found;
    found = true;
    if (!/不是|不要|禁止|别点|别选|勿|避免|而非|不用|不需要|无需|不点|排除/.test(target.slice(Math.max(0, at - 12), at))) return false;
    offset = at + name.length;
  }
}
function score(step: Obj, c: Candidate) {
  const item = c.item, kind = c.action.action;
  if ((step.action === "fill" && !item.editable) || (step.action === "click" && kind !== "click")) return -Infinity;
  if (step.action === "scroll") {
    if (kind !== "scroll" || item.direction !== (step.direction || "down")) return -Infinity;
    if (!step.target) return c.action.ref ? 1 : 60;
  }
  const name = lower(item.name), target = lower(step.target), role = lower(item.role), col = lower(item.column?.name), group = lower(item.column?.group);
  const context = lower([item.region, item.fieldContext, col, group].filter(Boolean).join(" "));
  const label = lower([name, role, item.icon, context, item.href].filter(Boolean).join(" "));
  let value = 0;
  if (step.name) {
    const wanted = lower(step.name), hit = (s: string) => s.length >= 2 && (s === wanted || s.includes(wanted) || wanted.includes(s));
    value += hit(col) ? !name ? 60 : name === wanted ? 100 : 25 : hit(group) ? 25 : name === wanted ? 100 : name && (name.includes(wanted) || wanted.includes(name)) ? 35 : -60;
  }
  for (const match of String(step.target || "").matchAll(/[“"「『‘]([^“”"「」『』‘’\n]{1,60})[”"」』’]/g)) {
    const quoted = lower(match[1]);
    if (!negated(target, quoted)) value += name === quoted ? 80 : label.includes(quoted) ? 25 : 0;
  }
  if (name.length >= 2 && target.includes(name)) value += negated(target, name) ? -60 : 30 + Math.min(name.length, 20);
  const wanted = [...terms(target)].filter((t) => !generic.has(t)), available = terms(label), hits = wanted.filter((t) => available.has(t)).length;
  value += hits * 12 + (wanted.length && hits === wanted.length ? 15 : 0);
  if (/复选框|勾选|checkbox/.test(target) && (["checkbox", "menuitemcheckbox"].includes(role) || item.selected != null)) value += 25;
  if (/搜索框|输入框|文本框|input|search box/.test(target) && item.editable) value += 25;
  if (/图标|icon/.test(target)) value += name ? -30 : 25;
  if (/排序|sort/.test(target) && (/sort|caret|order|asc|desc/.test(item.icon || "") || item.sort != null)) value += 25;
  if (/按钮|button/.test(target) && role === "button") value += 10;
  if (/链接|link|菜单|menu/.test(target) && ["a", "link", "menuitem", "li"].includes(role)) value += 10;
  if (/选项|option/.test(target) && ["option", "menuitemcheckbox", "menuitemradio", "checkbox", "radio"].includes(role)) value += 10;
  if (col.length >= 2 && target.includes(col)) value += 20;
  if (group.length >= 2 && target.includes(group)) value += 10;
  if (step.within) value += context.includes(lower(step.within)) || label.includes(lower(step.within)) ? 40 : -40;
  if (step.role) value += role === lower(step.role) ? 30 : -30;
  if (c.fresh) value += 15;
  return value;
}
export function bindStep(step: Obj, inputs: Obj[], candidates: Candidate[]) {
  if (step.action === "press") return { candidate: { action: { action: "press", key: step.key }, item: {}, key: "press:" + step.key, loose: "press:" + step.key } as Candidate };
  const ranked = candidates.filter((c) => step.action !== "fill" || !inputs.some((i) => i.text === step.text) || inputs.some((i) => i.text === step.text && (!i.name ? c.item.name === "" || i.fieldContext !== undefined : i.name === c.item.name || i.name === c.item.fieldContext) && (!i.role || i.role === c.item.role) && (!i.fieldContext || (i.fieldContext.length >= 24 ? c.item.fieldContext?.startsWith(i.fieldContext) : c.item.fieldContext === i.fieldContext))))
    .map((candidate) => ({ candidate, score: score(step, candidate) })).filter((v) => v.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return {};
  if (ranked[0].score < 40 || (ranked[1] && ranked[0].score - ranked[1].score < 25)) return { ambiguous: true };
  const c = ranked[0].candidate;
  return { candidate: step.action === "fill" ? { ...c, action: { ...c.action, action: "fill", text: step.text }, key: c.key + "|fill|" + step.text } : c };
}
export function chains(step: Obj, candidate: Candidate, next: Obj) {
  if (next.when || step.expect || step.expectedText || step.repeat) return false;
  return step.action === "fill" || (step.action === "press" && step.key === "Tab") || (step.action === "click" && ["checkbox", "radio", "option", "menuitemcheckbox", "menuitemradio"].includes(candidate.item.role) && candidate.item.haspopup == null);
}

export function runState(pages: Obj[]) {
  // Tooltip text and fresh refs are not progress and must not permit a replay.
  return JSON.stringify(pages.map((p) => [p.frame, p.url, p.viewport, (p.items || []).map((i: Obj) => [i.nodeId, i.name, i.inView, i.disabled, i.editable, i.value, i.selected, i.expanded, i.sort, i.scroll]), (p.tables || []).map((t: Obj) => [t.headers, t.rows, t.totalRows])]));
}
