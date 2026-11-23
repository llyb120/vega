import type { Tool } from "./provider";
import { assert, type Obj } from "./util";

/**
 * 剑来桌面工具：与 Nova `scripts/jianlai-tools.json` + `src-tauri/src/jianlai_tools.rs`
 * 完全同构的 5 工具接口（在 Vega 中保持 `appuse_*` 命名）。
 * 服务端只负责参数校验、别名归一与形态映射；截图/UIA/安全护栏与输入执行仍在客户端本地完成。
 */

const maxEdge = {
  anyOf: [{ type: "integer", enum: [0] }, { type: "integer", minimum: 640, maximum: 3840 }],
  description: "截图长边像素上限：0 为原分辨率，或 640–3840，默认 1600",
};
const windowId = {
  type: "integer",
  minimum: 0,
  description: "目标窗口 ID（来自 list 返回的 windowId，非 pid）",
};
const action = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "double_click", "move", "drag", "type", "press", "scroll", "dismiss", "wait"] },
    id: { type: "integer", minimum: 1, description: "目标控件编号（来自最新截图的 [1][2] 标注，优先使用；支持 click/double_click/move/type/scroll）" },
    x: { type: "integer", minimum: -2147483648, maximum: 2147483647, description: "截图像素横坐标（coordinateSpace=screen 时为屏幕物理像素，可为负）" },
    y: { type: "integer", minimum: -2147483648, maximum: 2147483647, description: "截图像素纵坐标（与 x 同给）" },
    toX: { type: "integer", minimum: -2147483648, maximum: 2147483647, description: "drag 终点横坐标" },
    toY: { type: "integer", minimum: -2147483648, maximum: 2147483647, description: "drag 终点纵坐标" },
    button: { type: "string", enum: ["left", "right", "middle"], description: "click/double_click/drag 按键，默认 left" },
    text: { type: "string", maxLength: 10000, description: "type 文本（Windows 整段粘贴并自动恢复原剪贴板；可配 id/x/y 自动点击聚焦、clear 清空、submit 回车）" },
    clear: { type: "boolean", description: "仅 type：输入前是否 Ctrl+A + Backspace 清空，默认 false" },
    submit: { type: "boolean", description: "仅 type：输入后是否自动按 Enter 提交，默认 false" },
    key: { type: "string", minLength: 1, description: "仅 press：单键或组合键，如 Enter、Tab、Escape、Ctrl+C、Ctrl+L、Alt+F4（最多 4 键）" },
    delta: { type: "integer", minimum: -100, maximum: 100, description: "仅 scroll：滚轮格数，正数向下/向右；翻约一屏 5–10 格" },
    axis: { type: "string", enum: ["vertical", "horizontal"], description: "仅 scroll：滚动方向，默认 vertical" },
    ms: { type: "integer", minimum: 0, maximum: 10000, description: "仅 wait：等待毫秒数（0–10000，仅用于明确加载/动画过渡）" },
    glide: { type: "boolean", description: "是否沿拟人三次贝塞尔轨迹滑行移动（click/double_click/move/drag/type-with-coords/dismiss 默认 true；false 瞬移）" },
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
      "列出桌面窗口或切换激活指定窗口：action=list（默认）列出窗口，query 按应用名/标题过滤，observe=true 同次附目标所在屏幕截图与带 [编号] 控件清单（不激活窗口，未指定目标看所有显示器）；action=activate 按 windowId 把指定窗口切到前台并立即返回新截图与控件清单。",
      {
        action: { type: "string", enum: ["list", "activate"], description: "操作类型：list（默认，列窗口/可选观察）或 activate（按 windowId 切到前台）" },
        query: { type: "string", minLength: 1, description: "action=list 时按应用名或窗口标题过滤（不区分大小写）" },
        windowId,
        observe: { type: "boolean", description: "action=list 时是否同次截图并附 [1][2] 控件清单，默认 false" },
        background: { type: "boolean", description: "仅 action=list：独立后台模式（仅 macOS/Linux 支持，Windows 不支持）；绝不回退到真实前台" },
        maxEdge,
        notes: { type: "string", maxLength: 12000, description: "可选：简短记录当前观察意图" },
      },
      [],
    ),
    def(
      "appuse_view",
      "统一桌面观察（截图 + 快速 Windows 控件树 + 离线 [1][2] 编号标注）：默认 screenshot=true 截桌面/指定屏/窗口所在屏并自动附带可见控件清单 elements（[1] Button \"保存\" @(x,y)）、打开的菜单/弹层 overlay（含安全空白点 outsidePoint）与可滚动提示 scrollHint；screenshot=false 时只读 Windows UIA 控件树（极速、不产图，支持 depth/filter/x/y/windowId）。支持 zoom 按控件 id 或区域局部特写。appuse_act 与 appuse_windows(activate/observe) 已自动附图，勿紧接着重复调用。",
      {
        target: { type: "string", enum: ["desktop", "monitor", "window", "zoom"], description: "观察目标：desktop（默认，所有显示器）、monitor（指定 monitorId）、window（windowId 所在屏；后台 macOS 仅该窗口）、zoom（配合 zoom 参数局部放大）" },
        windowId,
        monitorId: { type: "integer", minimum: 0, description: "目标显示器 ID（target=monitor 或 monitor 原始裁剪时使用）" },
        zoom: {
          type: "object",
          properties: {
            id: { type: "integer", minimum: 1, description: "按最新截图中的控件编号 id 自动局部放大特写" },
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
            space: { type: "string", enum: ["image", "source"], description: "区域坐标系：image（默认，最新截图像素，需 snapshotId+imageId）或 source（原图物理像素，需 windowId 或 monitorId）" },
          },
          additionalProperties: false,
          description: "局部放大特写：传 id 按控件放大，或传 x/y/width/height 按矩形裁剪",
        },
        snapshotId: { type: "string", minLength: 1, description: "zoom(image) 裁剪或 screenshot=false 换算图片像素所依据的快照 ID" },
        imageId: { type: "string", minLength: 1, description: "多图快照中的目标图片 ID" },
        screenshot: { type: "boolean", description: "是否截图，默认 true；false 只读 Windows UIA 控件树（极速、不产新图）" },
        controls: { type: "boolean", description: "screenshot=true 时是否自动附带快速 UIA 控件清单与 [1][2] 编号，默认 true" },
        filter: { type: "string", minLength: 1, maxLength: 60, description: "按控件名/类型/automationId 关键词过滤（不区分大小写）" },
        depth: { type: "integer", minimum: 1, maximum: 6, description: "仅 screenshot=false：控件树遍历深度（1–6，默认 3）" },
        maxItems: { type: "integer", minimum: 1, maximum: 120, description: "返回控件上限（1–120，截图默认 70，纯树默认 40）" },
        x: { type: "integer", minimum: 0, description: "仅 screenshot=false：图片像素横坐标（需与 y 同给，观察该点最上层窗口）" },
        y: { type: "integer", minimum: 0, description: "仅 screenshot=false：图片像素纵坐标（需与 x 同给）" },
        background: { type: "boolean", description: "独立后台模式（仅 macOS/Linux；screenshot=false 不支持）" },
        maxEdge,
        notes: { type: "string", maxLength: 12000, description: "可选：观察意图说明" },
      },
      [],
    ),
    def(
      "appuse_act",
      "按顺序执行 1–16 个真实桌面鼠标键盘动作并自动返回最新截图与 [1][2] 控件清单。优先使用最新截图上的控件编号 id（click/double_click/move/type/scroll 均支持 id），自绘控件或精准落点可直接传截图像素 x/y。type 支持传 id 或 x/y 自动滑行点击聚焦、clear=true 全选清空、submit=true 自动回车。无确认按钮的弹出菜单/浮层可用 action=dismiss 自动点安全空白处（无空白点则发 Escape）。scroll 省略 id/x/y 时自动定位主可滚区域（delta 正数向下/向右）。snapshotId 可省略，自动绑定本会话最新可用观察；coordinateSpace=screen 时可免截图按屏幕物理像素执行指针动作。",
      {
        actions: { type: "array", minItems: 1, maxItems: 16, description: "按顺序执行的动作数组（1–16 步；同屏确定的多步合并执行）", items: action },
        coordinateSpace: { type: "string", enum: ["image", "screen"], description: "坐标空间：image（默认，截图像素与 id）或 screen（屏幕物理像素，免截图，仅指针动作且不可配 background）" },
        snapshotId: { type: "string", description: "可选：留空自动绑定本会话最新同模式可用观察" },
        imageId: { type: "string", minLength: 1, description: "多屏/多图快照时指定所依据的图片 ID" },
        windowId,
        feedback: { type: "string", enum: ["screenshot", "desktop", "none"], description: "动作后反馈画面：screenshot（默认，同屏截图与控件清单）、desktop（所有屏）、none（不附图）" },
        notes: { type: "string", maxLength: 12000, description: "可选：简短说明本批动作意图" },
        background: { type: "boolean", description: "后台模式开关，须与快照模式一致" },
        maxEdge,
      },
      ["actions"],
    ),
    def(
      "appuse_recall",
      "回看本会话先前保存的桌面截图（仅返回历史图片，不可直接在其上输入）。",
      { imagePath: { type: "string", minLength: 1, description: "本会话先前返回的桌面截图文件路径" } },
      ["imagePath"],
    ),
    def(
      "appuse_experience",
      "桌面应用操作经验记忆：action=search 按应用名(scope)与通用目标(task，传 * 浏览全部)检索已验证路径；action=save 在最新观察确认任务成功时保存脱敏路径（redacted=true）；action=feedback 汇报既有 routeId 的复用成败。",
      {
        action: { type: "string", enum: ["search", "save", "feedback"], description: "经验操作类型" },
        scope: { type: "string", minLength: 1, maxLength: 200, description: "桌面应用名（来自 appuse_windows 的 app 原值）" },
        task: { type: "string", minLength: 1, maxLength: 300, description: "通用任务目标（不含业务数据；search 传 * 浏览全部）" },
        prefix: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
        snapshotId: { type: "string", minLength: 1, description: "本会话 180 秒内的最新截图 ID（save/feedback 用）" },
        conditions: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
        steps: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
        checks: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
        pitfalls: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
        alternatives: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              at: { type: "integer", minimum: 0, maximum: 12 },
              actions: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 500 } },
            },
            required: ["at", "actions"],
            additionalProperties: false,
          },
        },
        evidence: { type: "string", minLength: 1, maxLength: 1000 },
        redacted: { type: "boolean" },
        routeId: { type: "string", minLength: 1, maxLength: 80 },
        outcome: { type: "string", enum: ["success", "transient", "precondition", "invalid"] },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      ["action", "scope", "task"],
    ),
  ];
}

export const APPUSE_TOOLS = new Set(appuseTools().map((tool) => tool.name));

/**
 * 弱模型等价动作形状归一（同 Nova normalize_action / jianlai.rs L2442）。
 */
export function normalizeDesktopAction(raw: any): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const a: Obj = { ...raw };
  const take = (from: string, to: string) => {
    if (!(to in a) && from in a) { a[to] = a[from]; delete a[from]; }
  };
  if (!("action" in a)) {
    const k = typeof a.op === "string" ? a.op : typeof a.type === "string" ? a.type : undefined;
    if (k !== undefined) {
      a.action = k;
      delete a.op;
      delete a.type;
    }
  }
  for (const [from, to] of [["keys", "key"], ["value", "text"], ["content", "text"], ["to_x", "toX"], ["to_y", "toY"], ["duration", "ms"], ["durationMs", "ms"], ["duration_ms", "ms"]] as const)
    take(from, to);
  for (const key of ["id", "x", "y", "toX", "toY", "delta", "ms"]) {
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
    close_overlay: "dismiss", close_popup: "dismiss", dismiss_overlay: "dismiss",
    sleep: "wait", delay: "wait",
    mouse_drag: "drag", drag_and_drop: "drag", dragto: "drag",
  };
  const named = typeof a.action === "string" ? canonical[a.action] : undefined;
  if (named) a.action = named;
  if (a.action === "press" && !("key" in a) && typeof a.text === "string") { a.key = a.text; delete a.text; }
  else if (a.action === "type" && !("text" in a) && typeof a.key === "string") a.action = "press";
  return a;
}

const ACTION_ALLOWED: Record<string, Set<string>> = {
  click: new Set(["action", "id", "x", "y", "button", "glide"]),
  double_click: new Set(["action", "id", "x", "y", "button", "glide"]),
  move: new Set(["action", "id", "x", "y", "glide"]),
  drag: new Set(["action", "x", "y", "toX", "toY", "button", "glide"]),
  type: new Set(["action", "id", "x", "y", "text", "clear", "submit", "glide"]),
  press: new Set(["action", "key"]),
  scroll: new Set(["action", "id", "x", "y", "delta", "axis"]),
  dismiss: new Set(["action", "x", "y", "glide"]),
  wait: new Set(["action", "ms"]),
};

function checkActItems(actions: Obj[]) {
  for (let i = 0; i < actions.length; i++) {
    const item = actions[i];
    const kind = String(item.action || "");
    const allowed = ACTION_ALLOWED[kind];
    assert(allowed, `actions[${i}] 未知动作 ${kind}`);
    for (const k of Object.keys(item)) {
      assert(allowed.has(k), `actions[${i}] 不接受字段 ${k}`);
    }
    const hasId = item.id !== undefined;
    const hasX = item.x !== undefined;
    const hasY = item.y !== undefined;
    assert(hasX === hasY, `actions[${i}] 的 x 与 y 必须同时提供`);
    if (kind === "click" || kind === "double_click" || kind === "move") {
      assert(hasId || hasX, `actions[${i}]（${kind}）需要 id 或 x/y`);
    } else if (kind === "drag") {
      assert(hasX && item.toX !== undefined && item.toY !== undefined, `actions[${i}]（drag）需要 x、y、toX、toY`);
    } else if (kind === "type") {
      assert(typeof item.text === "string", `actions[${i}]（type）缺少 text`);
    } else if (kind === "press") {
      assert(typeof item.key === "string" && item.key.length > 0, `actions[${i}]（press）缺少 key`);
    } else if (kind === "scroll") {
      assert(item.delta !== undefined, `actions[${i}]（scroll）缺少 delta`);
    }
  }
}

/** 窄工具参数 → 执行器参数。只有形状翻译，不改变任何安全校验与快照规则。 */
export function appuseArguments(name: string, a: Obj, owner: string): Obj {
  const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  assert(!a.background, "Windows 不支持后台桌面操作，不会回退到前台");
  const common = defined({ snapshotId: a.snapshotId, imageId: a.imageId, windowId: a.windowId, maxEdge: a.maxEdge, notes: a.notes, feedback: a.feedback, owner });

  if (name === "appuse_windows") {
    const act = a.action || "list";
    if (act === "activate") {
      assert(a.windowId !== undefined, "action=activate 需要 windowId");
      for (const f of ["background", "query", "observe"]) assert(a[f] === undefined, `action=activate 不接受字段 ${f}`);
      return defined({ operation: "activate", windowId: a.windowId, maxEdge: a.maxEdge, notes: a.notes, owner });
    }
    return defined({ operation: "windows", query: a.query, windowId: a.windowId, observe: a.observe, maxEdge: a.maxEdge, notes: a.notes, owner });
  }

  if (name === "appuse_view") {
    const screenshot = a.screenshot ?? true;
    if (!screenshot) {
      for (const f of ["zoom", "monitorId", "maxEdge", "controls", "background"]) assert(a[f] === undefined, `screenshot=false 不接受字段 ${f}`);
      assert(a.target === undefined || a.target === "window", "screenshot=false 仅可搭配 windowId 或省略 target");
      assert((a.x === undefined) === (a.y === undefined) && !(a.windowId !== undefined && a.x !== undefined), "elements 的 x/y 必须成对，且与 windowId 二选一");
      return defined({ operation: "elements", owner, windowId: a.windowId, snapshotId: a.snapshotId, imageId: a.imageId, x: a.x, y: a.y, depth: a.depth, maxItems: a.maxItems, filter: a.filter, notes: a.notes });
    }
    for (const f of ["depth", "x", "y"]) assert(a[f] === undefined, `screenshot=true 不接受字段 ${f}（纯控件树查树请设 screenshot=false）`);
    const mapped: Obj = { operation: "screenshot", owner, maxEdge: a.maxEdge, notes: a.notes, controls: a.controls, filter: a.filter, maxItems: a.maxItems };
    if (a.zoom) {
      assert(a.target === undefined || a.target === "zoom", "zoom 不能与非 zoom 的 target 同时使用");
      if (a.zoom.id !== undefined) {
        for (const k of ["x", "y", "width", "height", "space"]) assert(a.zoom[k] === undefined, "zoom.id 不能与 x/y/width/height/space 同时使用");
        mapped.zoomId = a.zoom.id;
        if (a.snapshotId !== undefined) mapped.snapshotId = a.snapshotId;
        if (a.imageId !== undefined) mapped.imageId = a.imageId;
      } else {
        for (const k of ["x", "y", "width", "height"]) assert(a.zoom[k] !== undefined, `zoom 缺少 ${k}（或改传 zoom.id）`);
        const space = a.zoom.space || "image";
        if (space === "image") assert(a.snapshotId && a.imageId, "zoom(space=image) 需要 snapshotId 与 imageId");
        else assert(a.windowId !== undefined || a.monitorId !== undefined, "zoom(space=source) 需要 windowId 或 monitorId");
        mapped.regionSpace = space;
        mapped.region = { x: a.zoom.x, y: a.zoom.y, width: a.zoom.width, height: a.zoom.height };
        if (a.snapshotId !== undefined) mapped.snapshotId = a.snapshotId;
        if (a.imageId !== undefined) mapped.imageId = a.imageId;
        if (a.windowId !== undefined) mapped.windowId = a.windowId;
        if (a.monitorId !== undefined) mapped.monitorId = a.monitorId;
      }
    } else {
      if (a.target === "zoom") throw Error("target=zoom 需要提供 zoom 对象（id 或 x/y/width/height）");
      if (a.target === "window") {
        assert(a.windowId !== undefined, "target=window 需要 windowId");
        assert(a.monitorId === undefined, "target=window 不接受 monitorId");
      } else if (a.target === "monitor") {
        assert(a.monitorId !== undefined, "target=monitor 需要 monitorId");
        assert(a.windowId === undefined, "target=monitor 不接受 windowId");
      } else if (a.target === "desktop") {
        assert(a.windowId === undefined && a.monitorId === undefined, "target=desktop 不接受 windowId 或 monitorId");
      } else {
        assert(!(a.windowId !== undefined && a.monitorId !== undefined), "windowId 与 monitorId 不能同时提供");
      }
      if (a.windowId !== undefined) mapped.windowId = a.windowId;
      if (a.monitorId !== undefined) mapped.monitorId = a.monitorId;
    }
    return defined(mapped);
  }

  if (name === "appuse_act") {
    const actions = (a.actions || []).map(normalizeDesktopAction);
    checkActItems(actions);
    if (a.coordinateSpace === "screen") {
      assert(!a.snapshotId && !a.imageId && !a.background, "screen 坐标不能携带图片 ID 或启用后台模式");
      assert(actions.every((act: Obj) => ["click", "double_click", "move", "drag", "scroll", "wait"].includes(act.action)), "screen 坐标只允许指针动作和 wait，不允许键盘输入");
    } else {
      for (const act of actions) {
        for (const key of ["x", "y", "toX", "toY"]) {
          assert(act[key] === undefined || act[key] >= 0, "image 坐标不能为负");
        }
      }
    }
    return defined({ ...common, operation: "act", coordinateSpace: a.coordinateSpace, actions });
  }

  if (name === "appuse_recall") return defined({ operation: "recall", imagePath: a.imagePath, owner });

  // appuse_experience
  const act = a.action;
  const experience = defined({
    scope: a.scope, task: a.task, conditions: a.conditions, steps: a.steps, checks: a.checks, pitfalls: a.pitfalls,
    alternatives: a.alternatives, evidence: a.evidence, redacted: a.redacted, prefix: a.prefix,
    id: a.routeId, outcome: a.outcome, reason: a.reason,
  });
  if (act === "search") {
    for (const f of ["conditions", "steps", "checks", "pitfalls", "alternatives", "evidence", "redacted", "id", "outcome", "reason"]) {
      assert(experience[f] === undefined, `action=search 不接受字段 ${f}`);
    }
    assert(a.snapshotId === undefined, "action=search 不接受字段 snapshotId");
    return { operation: "experience_search", owner, experience };
  }
  if (act === "save") {
    for (const req of ["conditions", "steps", "checks", "evidence"]) assert(experience[req] !== undefined, `action=save 缺少 ${req}`);
    assert(experience.redacted === true, "action=save 必须确认 redacted=true（不含业务数据或凭据）");
    return defined({ operation: "experience_save", owner, snapshotId: a.snapshotId, experience: { ...experience, outcome: "success" } });
  }
  // feedback
  for (const [f, label] of [["id", "routeId"], ["outcome", "outcome"], ["reason", "reason"], ["evidence", "evidence"]] as const) {
    assert(experience[f] !== undefined, `action=feedback 缺少 ${label}`);
  }
  assert(experience.redacted === true, "action=feedback 必须确认 redacted=true");
  return defined({ operation: "experience_feedback", owner, snapshotId: a.snapshotId, experience });
}

/** 适配客户端返回的恢复建议（只改工具/动作名，绝不伪造观察或重放动作）。 */
export function appuseResult(value: Obj, args: Obj = {}): Obj {
  if (!value || typeof value !== "object") return value;
  const out = { ...value };
  if (out.nextCall && typeof out.nextCall === "object" && out.nextCall.operation === "activate") {
    const { operation: _op, ...next } = out.nextCall as Obj;
    out.nextCall = { tool: "appuse_windows", arguments: { ...next, action: "activate" } };
  }
  if (out.nextArguments && typeof out.nextArguments === "object" && out.nextArguments.operation === "act") {
    const { operation: _op, ...next } = out.nextArguments as Obj;
    for (const key of ["windowId"]) {
      if (args[key] !== undefined && next[key] === undefined) next[key] = args[key];
    }
    out.nextArguments = next;
    out.nextTool = "appuse_act";
  }
  return out;
}
