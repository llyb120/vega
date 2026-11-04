import { assert, type Obj } from "./util";
export function normalizeAction(raw: Obj) {
  assert(
    raw && typeof raw === "object" && !Array.isArray(raw),
    "Action object required",
  );
  const a: Obj = { ...raw, action: raw.action || raw.type };
  delete a.type;
  for (const key of Object.keys(a)) if (a[key] === undefined) delete a[key];
  assert(
    [
      "click",
      "hover",
      "fill",
      "upload",
      "press",
      "type",
      "scroll",
      "wait",
      "click_at",
      "move",
      "drag",
      "scroll_at",
    ].includes(a.action),
    "Unknown Chrome action",
  );
  const kind = a.action,
    allowed: Record<string, string[]> = {
      click: ["frame", "ref", "button", "click_count"],
      hover: ["frame", "ref"],
      fill: ["frame", "ref", "text"],
      upload: ["frame", "selector", "files"],
      press: ["key"],
      type: ["text"],
      scroll: ["frame", "ref", "delta", "delta_x"],
      wait: ["ms"],
      click_at: ["x", "y", "button", "click_count"],
      move: ["x", "y"],
      drag: ["x", "y", "to_x", "to_y", "duration_ms"],
      scroll_at: ["x", "y", "delta", "delta_x"],
    };
  if (
    ["press", "wait", "type", "move", "click_at", "drag", "scroll_at"].includes(
      kind,
    )
  ) {
    delete a.frame;
    delete a.ref;
  }
  const unexpected = Object.keys(a).filter((k) => k !== "action" && !allowed[kind].includes(k));
  assert(
    !unexpected.length,
    `Unexpected Chrome action field for ${kind}: ${unexpected.join(", ")} (allowed: ${allowed[kind].join(", ") || "none"}; omit unused fields)`,
  );
  if (["click", "hover", "fill", "scroll", "upload"].includes(kind)) {
    a.frame ??= 0;
    assert(
      Number.isInteger(a.frame) && a.frame >= 0 && a.frame < 12,
      "Invalid frame",
    );
  }
  if (["click", "hover", "fill"].includes(kind))
    assert(typeof a.ref === "string" && a.ref, "DOM ref required");
  if (["fill", "type"].includes(kind))
    assert(
      typeof a.text === "string" && a.text.length <= 16000,
      "Text must be a string up to16000 characters",
    );
  if (["click", "click_at"].includes(kind))
    assert(
      (a.button == null || ["left", "right", "middle"].includes(a.button)) &&
        (a.click_count == null || [1, 2].includes(a.click_count)),
      "Invalid mouse button/click_count",
    );
  if (kind === "upload")
    assert(
      typeof a.selector === "string" &&
        a.selector.trim() &&
        a.selector.length <= 2000 &&
        Array.isArray(a.files) &&
        a.files.length > 0 &&
        a.files.length <= 16 &&
        a.files.every((v: any) => typeof v === "string" && v.trim()),
      "upload requires unique selector and1–16 file paths",
    );
  if (kind === "wait") {
    a.ms ??= 250;
    assert(
      Number.isInteger(a.ms) && a.ms >= 0 && a.ms <= 2000,
      "wait must be0–2000ms",
    );
  }
  if (["scroll", "scroll_at"].includes(kind))
    assert(
      Number.isInteger(a.delta) &&
        Math.abs(a.delta) <= 1200 &&
        (a.delta_x === undefined ||
          (Number.isInteger(a.delta_x) && Math.abs(a.delta_x) <= 1200)),
      "Scroll exceeds1200 pixels",
    );
  if (["click_at", "move", "drag", "scroll_at"].includes(kind))
    for (const key of kind === "drag" ? ["x", "y", "to_x", "to_y"] : ["x", "y"])
      assert(Number.isFinite(a[key]) && a[key] >= 0, "Invalid coordinates");
  if (kind === "drag" && a.duration_ms !== undefined)
    assert(
      Number.isInteger(a.duration_ms) &&
        a.duration_ms >= 80 &&
        a.duration_ms <= 1500,
      "Drag duration80–1500ms",
    );
  if (kind === "press") {
    assert(typeof a.key === "string", "press requires key");
    const parts = a.key.split("+"),
      base = parts.pop()!;
    assert(
      parts.every((p: string) =>
        ["Alt", "Ctrl", "Control", "Shift", "Meta", "Cmd"].includes(p),
      ) &&
        (/^(Enter|Tab|Escape|Backspace|Delete|Home|End|PageUp|PageDown|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space|F(?:[1-9]|1[0-2]))$/.test(
          base,
        ) ||
          (parts.some((p: string) => p !== "Shift") &&
            /^[a-z0-9]$/i.test(base))),
      "Unsupported keyboard key",
    );
  }
  return a;
}
