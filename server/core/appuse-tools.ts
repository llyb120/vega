import type { Tool } from "./provider";
import type { Obj } from "./util";

/**
 * 剑来桌面工具：与 Nova 的 scripts/jianlai-tools.json 同构的窄 schema。
 *
 * Nova 的 8 个工具共享同一个执行器：窄工具只负责参数形状，映射后交给 appuse 执行器。
 * 这里保持同样的分工——参数校验在服务端可见 schema 上完成，执行与安全校验仍在客户端。
 * 服务端不重造执行逻辑，只把 capture.kind / routeId 这类 Nova 的形状翻译成执行器参数。
 */

const maxEdge = {
  anyOf: [{ type: "integer", enum: [0] }, { type: "integer", minimum: 640, maximum: 3840 }],
  description: "截图长边：0 原像素，否则 640–3840；局部放大建议 1200。返回图即模型所见，不超过长边 1568。",
};
const background = {
  type: "boolean",
  description:
    "仅显式 background:true 启用独立后台/隔离模式（默认不启用；windows/screenshot/act 同用，act 必须与其快照模式一致）：不动真实光标、键盘焦点和前台窗口。Windows 不支持，绝不回退到真实前台；当前客户端在非 Windows 上报错而不是假装成功。",
};
const region = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  },
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
};
const windowId = {
  type: "integer",
  minimum: 0,
  description: "windows 返回的窗口 ID（不是 pid）。普通截图只用来定位所在显示器并截整屏，不裁窗口、不激活窗口。",
};
const action = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "double_click", "move", "drag", "type", "press", "scroll", "wait"] },
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    toX: { type: "integer", minimum: 0 },
    toY: { type: "integer", minimum: 0 },
    button: { type: "string", enum: ["left", "right", "middle"] },
    text: { type: "string", maxLength: 10000 },
    key: { type: "string" },
    delta: { type: "integer", minimum: -100, maximum: 100 },
    axis: { type: "string", enum: ["vertical", "horizontal"] },
    ms: { type: "integer", minimum: 0, maximum: 2000 },
    glide: { type: "boolean" },
  },
  required: ["action"],
  additionalProperties: false,
};

const def = (name: string, description: string, parameters: Obj, required: string[]): Tool =>
  ({ name, description, parameters: { type: "object", properties: parameters, required, additionalProperties: false } }) as Tool;

export function appuseTools(): Tool[] {
  return [
    def(
      "appuse_windows",
      "列出桌面窗口和显示器。query 按应用名/标题过滤；observe=true 同次附目标所在显示器整屏，windowId 优先、否则 query 唯一命中。不激活窗口；未指定目标观察所有显示器。输入前核对 focused/observedWindowFocused，需切窗用 appuse_activate。",
      { query: { type: "string" }, windowId: { type: "integer", minimum: 0 }, observe: { type: "boolean" }, maxEdge, background },
      [],
    ),
    def(
      "appuse_screenshot",
      "截图：capture.kind=desktop 所有显示器；monitor 指定一屏；window 定位窗口所在屏幕（不裁窗口、不激活）；image_region 按最新 snapshotId/imageId 的图片像素裁剪；window_region/monitor_region 按原始像素裁剪。动作已附图时不要再截图。",
      {
        capture: {
          anyOf: [
            { type: "object", properties: { kind: { type: "string", enum: ["desktop"] } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { type: "string", enum: ["monitor"] }, monitorId: { type: "integer", minimum: 0 } }, required: ["kind", "monitorId"], additionalProperties: false },
            { type: "object", properties: { kind: { type: "string", enum: ["window"] }, windowId }, required: ["kind", "windowId"], additionalProperties: false },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["image_region"] },
                snapshotId: { type: "string", minLength: 1 },
                imageId: { type: "string", minLength: 1 },
                region,
              },
              required: ["kind", "snapshotId", "imageId", "region"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["window_region"] }, windowId, region },
              required: ["kind", "windowId", "region"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["monitor_region"] }, monitorId: { type: "integer", minimum: 0 }, region },
              required: ["kind", "monitorId", "region"],
              additionalProperties: false,
            },
          ],
        },
        maxEdge,
        background,
      },
      ["capture"],
    ),
    def(
      "appuse_activate",
      "显式激活 appuse_windows 返回的 windowId（不是 PID），随后返回所在显示器的新整屏图。后台模式不能激活。系统拒绝激活时不再发送按键，也不循环重试。",
      { windowId, background },
      ["windowId"],
    ),
    def(
      "appuse_act",
      "在最新观察上执行 1–16 个已确认鼠标键盘动作并自动附图。snapshotId 可省略：直接使用本会话最新同模式可用观察；没有可用观察时才要求重新观察。ID 不代表屏幕没变，执行前仍校验现场焦点、显示器布局和落点像素。type/press 前必须先确认焦点；纯 wait 不输入、可省略快照。失败核对 completedActions/inputAttempted，不重放；actions 必须基于最新图重新决策。",
      { snapshotId: { type: "string" }, imageId: { type: "string" }, windowId, background, feedback: { type: "string", enum: ["screenshot", "desktop", "none"] }, notes: { type: "string", maxLength: 12000 }, maxEdge, actions: { type: "array", minItems: 1, maxItems: 16, items: action } },
      ["actions"],
    ),
    def(
      "appuse_recall",
      "回看本会话先前返回的桌面截图，只读，不创建新快照、不恢复旧图的输入权限；操作仍必须绑定当前观察。已在上下文的图片不要重复加载。",
      { imagePath: { type: "string", minLength: 1 } },
      ["imagePath"],
    ),
    def(
      "appuse_experience_search",
      "按准确应用名 scope 和通用目标 task 查已验证的桌面操作路径；陌生或受阻时参考，不跨 routeIds 拼接，不扩大授权。",
      { scope: { type: "string" }, task: { type: "string" }, prefix: { type: "array", items: { type: "string" } } },
      ["scope", "task"],
    ),
    def(
      "appuse_experience_save",
      "未照已有路径、经两步以上完成任务且最新图证明成功时，保存脱敏路径一次；scope 必须来自该观察。普通保存返回 accepted 即收尾。不保存凭据、业务数据、坐标或 ref。",
      {
        scope: { type: "string" }, task: { type: "string" }, conditions: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } }, checks: { type: "array", items: { type: "string" } },
        pitfalls: { type: "array", items: { type: "string" } }, alternatives: { type: "array", items: { type: "object" } },
        evidence: { type: "string" }, redacted: { type: "boolean" }, snapshotId: { type: "string" },
      },
      ["scope", "task", "conditions", "steps", "checks", "evidence", "redacted"],
    ),
    def(
      "appuse_experience_feedback",
      "报告已有桌面路径的本次结果，不重复保存路径。snapshotId/evidence 来自当前观察；outcome 为 success/transient/precondition/invalid，reason 说明依据，redacted=true。",
      {
        snapshotId: { type: "string" }, routeId: { type: "string" }, scope: { type: "string" }, task: { type: "string" },
        outcome: { type: "string", enum: ["success", "transient", "precondition", "invalid"] },
        reason: { type: "string" }, evidence: { type: "string" }, redacted: { type: "boolean" },
      },
      ["snapshotId", "routeId", "scope", "task", "outcome", "reason", "evidence", "redacted"],
    ),
  ];
}

export const APPUSE_TOOLS = new Set(appuseTools().map((tool) => tool.name));

/**
 * 弱模型（Devin 等）反复搞错的动作形状：动作名写在 type 上、把 text/key 当动作名、
 * 坐标写成字符串或小数、字段用了 to_x/duration 这类别名。这些写法没有歧义，
 * 与 Nova 的 normalize_action 一致，归一后直接执行比退回让模型重试更快也更稳；
 * 其余字段仍由窄 schema 严格校验，真正说不清的形状照旧报错。
 */
export function normalizeDesktopAction(raw: any): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const a: Obj = { ...raw };
  const take = (from: string, to: string) => {
    if (!(to in a) && from in a) { a[to] = a[from]; delete a[from]; }
  };
  if (!("action" in a) && typeof a.type === "string") { a.action = a.type; delete a.type; }
  for (const [from, to] of [["keys", "key"], ["value", "text"], ["content", "text"], ["to_x", "toX"], ["to_y", "toY"], ["duration", "ms"], ["durationMs", "ms"], ["duration_ms", "ms"]] as const)
    take(from, to);
  // 坐标/时长写成字符串或小数：没有歧义，取整后执行。
  for (const key of ["x", "y", "toX", "toY", "delta", "ms"]) {
    const value = a[key];
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) a[key] = Math.round(Number(value));
    else if (typeof value === "number" && !Number.isInteger(value)) a[key] = Math.round(value);
  }
  const canonical: Record<string, string> = {
    left_click: "click", leftclick: "click", mouse_click: "click", single_click: "click", tap: "click",
    doubleclick: "double_click", dblclick: "double_click",
    mouse_move: "move", mousemove: "move", hover: "move", moveto: "move",
    input: "type", write: "type", text: "type", type_text: "type", settext: "type", send_text: "type",
    key: "press", keys: "press", keypress: "press", key_press: "press", hotkey: "press", shortcut: "press", press_key: "press", sendkeys: "press",
    wheel: "scroll", mouse_wheel: "scroll", scroll_at: "scroll", scrollat: "scroll",
    sleep: "wait", delay: "wait",
    mouse_drag: "drag", drag_and_drop: "drag", dragto: "drag",
  };
  const named = typeof a.action === "string" ? canonical[a.action] : undefined;
  if (named) a.action = named;
  // press 只给了 text，或 type 只给了 key：这两种写法只有一种意思。
  if (a.action === "press" && !("key" in a) && typeof a.text === "string") { a.key = a.text; delete a.text; }
  else if (a.action === "type" && !("text" in a) && typeof a.key === "string") a.action = "press";
  return a;
}

/** 窄工具参数 → 执行器参数。只有形状翻译，不改变任何安全校验与快照规则。 */
export function appuseArguments(name: string, a: Obj, owner: string): Obj {
  const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const common = defined({ snapshotId: a.snapshotId, imageId: a.imageId, windowId: a.windowId, maxEdge: a.maxEdge, notes: a.notes, feedback: a.feedback, owner });
  if (name === "appuse_windows") return defined({ operation: "windows", query: a.query, windowId: a.windowId, observe: a.observe, maxEdge: a.maxEdge, owner });
  if (name === "appuse_screenshot") {
    const capture = (a.capture || {}) as Obj;
    const kind = capture.kind;
    const mapped: Obj = { operation: "screenshot", owner, maxEdge: a.maxEdge };
    // image_region 用图内像素，window_region/monitor_region 用原始像素；这是执行器的 regionSpace 语义。
    if (kind === "image_region") {
      mapped.regionSpace = "image";
      mapped.snapshotId = capture.snapshotId;
      mapped.imageId = capture.imageId;
    } else if (kind === "window_region" || kind === "monitor_region") {
      mapped.regionSpace = "source";
    }
    for (const key of ["monitorId", "windowId", "region"]) if (capture[key] !== undefined) mapped[key] = capture[key];
    return defined(mapped);
  }
  if (name === "appuse_activate") return defined({ operation: "activate", windowId: a.windowId, maxEdge: a.maxEdge, owner });
  if (name === "appuse_act") return defined({ ...common, operation: "act", actions: (a.actions || []).map(normalizeDesktopAction) });
  if (name === "appuse_recall") return defined({ operation: "recall", imagePath: a.imagePath, owner });
  // 经验图谱：桌面路径与浏览器路径共用同一套存储，按 origin 分域；这里用应用名作 scope。
  const experience = defined({
    scope: a.scope, task: a.task, conditions: a.conditions, steps: a.steps, checks: a.checks, pitfalls: a.pitfalls,
    alternatives: a.alternatives, evidence: a.evidence, redacted: a.redacted, prefix: a.prefix,
    id: a.routeId, outcome: a.outcome, reason: a.reason,
  });
  const operation = name === "appuse_experience_search" ? "experience_search" : name === "appuse_experience_save" ? "experience_save" : "experience_feedback";
  return defined({ operation, snapshotId: a.snapshotId, owner, experience: name === "appuse_experience_save" ? { ...experience, outcome: "success" } : experience });
}
