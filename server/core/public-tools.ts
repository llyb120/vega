import browserTools from "../../shared/browser-tools.json";
import { ASSIST_KINDS, ASSIST_SETTINGS_ROUTES } from "../../shared/task-assist";
import type { Tool } from "./provider";
import type { Obj } from "./util";
import { omittable } from "./tool-args";

export const STEP_OUTPUT_RULE = "只有已有可独立使用的成果，或用户明确要求单独导出该内容时，才填写 stepOutput。验证类产物须有具体结论和可核对的证据（截图、实测数据或测试输出等），不只说‘已验证’。续做记录、处理范围、分支状态和排查进度等过程信息默认只写 message，省略 stepOutput；完成步骤不等于要交产物，不逐步凑数。";

/**
 * Model-facing tools are narrow, per-purpose schemas. Each one maps onto the existing internal
 * chrome / employee executors (the employee executor also owns each employee's vault), so runtime behaviour (observations, receipts, permissions,
 * suspension) stays in one place. Arguments are validated against the visible schema before any
 * side effect; the only leniency is that an optional field holding null, or an empty value that its
 * own declared lower bound rejects (0 for minimum ≥ 1, "" for minLength ≥ 1, [] for minItems ≥ 1),
 * counts as omitted.
 */
export class ArgumentError extends Error {}
const fail = (message: string): never => { throw new ArgumentError(message); };
const plain = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const typeMatches = (type: string, v: unknown) =>
  type === "integer" ? Number.isInteger(v)
  : type === "number" ? typeof v === "number" && Number.isFinite(v)
  : type === "array" ? Array.isArray(v)
  : type === "object" ? plain(v)
  : type === "null" ? v === null
  : typeof v === type;
const discriminator = (branches: Obj[]) =>
  Object.keys(branches[0]?.properties || {}).find((key) => branches.every((b) => b.properties?.[key]?.enum && b.required?.includes(key)));

export function checkArgs(schema: Obj, value: unknown, path = "参数"): any {
  if (schema.anyOf) {
    const errors: ArgumentError[] = [];
    for (const branch of schema.anyOf as Obj[])
      try { return checkArgs(branch, value, path); } catch (error) { if (!(error instanceof ArgumentError)) throw error; errors.push(error); }
    const key = discriminator(schema.anyOf);
    const choices = key ? (schema.anyOf as Obj[]).flatMap((b) => b.properties[key].enum) : [];
    if (key && plain(value)) {
      const index = (schema.anyOf as Obj[]).findIndex((b) => b.properties[key].enum.includes(value[key]));
      if (index < 0) fail(`${path}.${key} 只能是 ${choices.map((v) => JSON.stringify(v)).join(" / ")}`);
      const branch = schema.anyOf[index];
      const optional = Object.keys(branch.properties).filter((k) => !branch.required.includes(k));
      fail(`${errors[index].message}（${key}=${JSON.stringify(value[key])} 的结构：必填 ${branch.required.join("、")}${optional.length ? "；可选 " + optional.join("、") : ""}）`);
    }
    return fail(`${path} 不符合任何允许的结构${key ? `，${key} 只能是 ${choices.map((v) => JSON.stringify(v)).join(" / ")}` : ""}`);
  }
  const types: string[] = schema.type === undefined ? [] : [].concat(schema.type);
  if (types.length && !types.some((t) => typeMatches(t, value))) fail(`${path} 应为 ${types.join(" 或 ")}，收到 ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.some((v: unknown) => v === value))
    fail(`${path} 只能是 ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(" / ")}，收到 ${JSON.stringify(value)}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`${path} 至少 ${schema.minLength} 个字符`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`${path} 最多 ${schema.maxLength} 个字符，收到 ${length}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${path} 格式不对：${schema.description || schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} 不能小于 ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(`${path} 必须大于 ${schema.exclusiveMinimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} 不能大于 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`${path} 至少 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`${path} 最多 ${schema.maxItems} 项`);
    return schema.items ? value.map((item, i) => checkArgs(schema.items, item, `${path}[${i}]`)) : value;
  }
  if (plain(value) && (schema.properties || schema.additionalProperties === false)) {
    const properties: Obj = schema.properties || {}, required: string[] = schema.required || [];
    const unknown = Object.keys(value).filter((k) => !(k in properties));
    if (unknown.length && schema.additionalProperties === false)
      fail(`${path} 不接受字段 ${unknown.join("、")}；允许：${Object.keys(properties).join("、") || "无"}`);
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (!(k in properties)) { out[k] = v; continue; }
      if (!required.includes(k) && omittable(properties[k], v)) continue;
      out[k] = checkArgs(properties[k], v, `${path}.${k}`);
    }
    const missing = required.filter((k) => !(k in out));
    if (missing.length) fail(`${path} 缺少必填字段 ${missing.join("、")}`);
    return out;
  }
  return value;
}

// ---------- definitions ----------
const str = (description: string, extra: Obj = {}) => ({ type: "string", ...extra, ...(description ? { description } : {}) });
const int = (description: string, extra: Obj = {}) => ({ type: "integer", ...extra, ...(description ? { description } : {}) });
const obj = (properties: Obj, required: string[] = [], description?: string) => ({ type: "object", properties, required, additionalProperties: false, ...(description ? { description } : {}) });
const one = (value: string) => ({ type: "string", enum: [value] });
const tool = (name: string, description: string, properties: Obj = {}, required: string[] = []): Tool => ({ name, description, parameters: obj(properties, required) });
const beijing = (description: string) => str(description + "，北京时间 YYYY-MM-DD HH:MM，须晚于现在", { minLength: 16, maxLength: 16, pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$" });
const taskId = str("任务 ID（employee_status 的 tasks[].id）", { minLength: 1 });
const memoryId = str("记忆 ID（memory_search 返回的 id）", { minLength: 1 });
const credentialId = str("密码本条目 ID（vault_list 返回的 id）", { minLength: 1 });
const instructions = (what: string) => str(what + "，1–8000 字", { minLength: 1, maxLength: 8000 });
const delayMinutes = (what: string) => int(`${what}，从现在起多少分钟，1–10080`, { minimum: 1, maximum: 10080 });
const previewSpec = (description: string) => obj({
  dir: str("当前执行端工作区（或云端用户个人目录）内的静态前端产物目录绝对路径", { minLength: 1, maxLength: 4096 }),
  entry: str("可选：入口 HTML 相对路径，默认 index.html", { minLength: 1, maxLength: 256 }),
  title: str("可选：预览卡片显示标题，1–120 字", { minLength: 1, maxLength: 120 }),
}, ["dir"], description);
const profile = str("开局场景偏好：lightweight（默认）或 coding，推荐用英文值；也接受中文别名 轻量化（= lightweight）、编码（= coding）。新主任务实际总是先用轻量模型判断，真正编码时在原会话用 switch_scene 升级", { enum: ["lightweight", "coding", "轻量化", "编码"] });
const vaultUrl = str("可选：当前页面或服务地址，辅助核对使用条件；通常自动参考当前浏览器观察", { minLength: 1, maxLength: 2048 });

/** Branches of a request union, filtered to the commands visible in this context. */
function request(branches: Obj[], allowed?: string[]) {
  const visible = branches
    .map((b) => (allowed ? { ...b, properties: { ...b.properties, command: { ...b.properties.command, enum: b.properties.command.enum.filter((c: string) => allowed.includes(c)) } } } : b))
    .filter((b) => b.properties.command.enum.length);
  return { anyOf: visible };
}
const commands = (allowed: string[] | undefined, phrases: [string, string][]) =>
  phrases.filter(([command]) => !allowed || allowed.includes(command)).map(([command, text]) => `${command} ${text}`).join("；");

export const TASK_COMMANDS = ["update", "set_instructions", "set_profile", "reschedule", "cancel", "resume", "answer", "stop"];
export const MEMORY_COMMANDS = ["confirm", "merge", "keep", "archive", "restore", "feedback", "pin", "unpin", "forget"];

export type ToolContext = {
  /** normal: user session; chat: employee chat; task: employee task (main or computer side). */
  kind: "normal" | "chat" | "task";
  computer?: boolean;
  /** Group chat turn asked by someone other than the employee's owner (tasks only). */
  member?: boolean;
  /** A turn in a group chat (the bulletin decides who does the work). */
  group?: boolean;
  /** Task session: the current task's id (target of task_reschedule). */
  taskId?: string;
};

export function employeeTools(ctx: ToolContext): Tool[] {
  const out: Tool[] = [];
  const task = ctx.kind === "task";
  out.push(tool("employee_status",
    "查看当前热心市民的总览：现在时间（北京时间）、工作原则、任务摘要（每条 id、status、dedupeKey、内容和结果节选、创建/计划/结束时间，最近 50 条，taskCount 是匹配总数）、最近运行、相关记忆和待确认记忆、可用场景。沟通会话系统提示已含活跃任务摘要，新派单不必先调本工具。续做、停止或修改前用它核对 taskId，或要看某条完整内容、计划、进度和结果时传 taskId。派单不必先查重：带 dedupeKey 的 employee_task_create 会自动去重。查记忆细节用 memory_search。",
    { taskId: str("只看这条任务的完整记录（任务 ID）；省略返回总览", { minLength: 1 }),
      dedupeKey: str("只列这个 dedupeKey 的任务", { minLength: 1, maxLength: 200 }),
      status: str("任务过滤：all（默认）全部、active 未收尾、ended 已收尾（完成、失败、停止、取消、封存）", { enum: ["all", "active", "ended"] }),
      memoryQuery: str("只影响返回的相关记忆：按这个关键词挑最相关的 30 条；省略为不按关键词", { maxLength: 2000 }) }));
  out.push(tool("employee_task_create",
    "给当前热心市民派一条新的独立任务，默认立即排队；给 runAt 或 delayMinutes（二选一）则到时再做；完成后自动收尾。沟通会话可直接调用，不必先 employee_status；同一条回复用人话说你在做什么并调用本工具，勿说「已派单/已安排」、勿复述。instructions 写用户目标、范围、明确约束和可感知的交付效果，执行任务的会话会自己选择实现方式与工具；不要照抄历史任务或旧记录里的工具名、动作名（执行端工具会变），也不要替用户擅自预设未要求的底层实现或运维方案（例如未指定外部目标主机/平台时，不要把自起本地端口服务、常驻进程或启停脚本写进要求——平台已内置报告导出、文件快照下载和纯前端静态网页预览托管），需要提到操作时写要达成的效果。已完成（done）和已取消（cancelled）的任务不可原地重启或 resume；若要基于已完成交付物继续修改/追问，或对已取消/失败/停止任务开分支重做，传 parentTaskId 和 relation（follow_up 后续 / retry 重做 / fork 分叉）建任务链。dedupeKey 填业务唯一标识（如 tapd:需求ID），同 key 有进行中任务时不新建；仅存在已结束任务且未传 parentTaskId 时不新建并返回原任务，派单前不必先查重。要对查到的每一项各走一遍流程时，每项各建一条并用 dedupeKey 去重。用户明确说出的时刻或重复周期由系统记在同一条任务上，到点只续做这一条，不要为定时另建一条" +
      (task ? "；本任务自己的步骤写进 task_progress，不要拆成新任务。" : ctx.group ? "。群聊里只给按群公告归你的工作派单。其他热心市民负责的工作不要派单，直接在回复里 @ 对应成员。" : "。"),
    { instructions: instructions("任务目标、范围、明确约束和可感知的交付效果，保留用户原话；不写工具名/动作名，也不擅自预设未要求的底层实现或自起服务方案"),
      parentTaskId: str("可选：前置或来源任务 ID。对已完成任务做后续修改（follow_up）、对已取消/失败/停止任务重做（retry）或分叉探索（fork）时传入，将新任务纳入同一任务链", { minLength: 1 }),
      relation: str("可选：与 parentTaskId 的关系：follow_up 基于已完成交付继续、retry 重做（自动挂到其父节点下作兄弟分支）、fork 分叉探索；省略时按来源状态自动推断", { enum: ["follow_up", "retry", "fork"] }),
      branchLabel: str("可选：分支短标签（1–80 字），如“改用方案B”“取消后重做”", { minLength: 1, maxLength: 80 }),
      dedupeKey: str("业务唯一标识，≤200 字；同 key 已有活跃任务时不新建，已有已结束任务且未传 parentTaskId 时也不新建。传 parentTaskId 建链时可沿用原 key，仅全新重做已完成的事时用新 key", { minLength: 1, maxLength: 200 }),
      runAt: beijing("开始时间；省略立即排队"), delayMinutes: delayMinutes("多久后开始"), profile },
    ["instructions"]));
  if (!task) {
    const allowed = ctx.kind === "chat" ? (ctx.member ? ["resume", "answer", "stop"] : TASK_COMMANDS) : ["update", "set_instructions", "set_profile", "reschedule", "cancel"];
    out.push(tool("employee_task_manage",
      "管理一条指定任务（taskId），request.command 选一种：" + commands(allowed, [
        ["update", "一次改多项：instructions、profile、runAt 或 delayMinutes 中至少给一项，一起生效（任一项不合法则全部不改；内容和场景只能改尚未开始的任务）"],
        ["set_instructions", "改尚未开始的任务内容"],
        ["set_profile", "改尚未开始的任务的开局场景偏好"],
        ["reschedule", "改执行时间，runAt 或 delayMinutes 二选一"],
        ["cancel", "取消任务并保留记录，不交付（运行中的先 stop）"],
        ["resume", "仅用于未完成任务（排队/执行/恢复/等待）的补充调整，或已停止（stopped）/失败（failed）任务的断点继续（除非用户明确要求开新任务/分支）。已完成（done）和已取消（cancelled）的任务严禁使用 resume，应改用 employee_task_create(parentTaskId=...) 建任务链。正在执行的任务把补充记在原任务上，当前工具或模型输出结束后进入同一轮，不必等整步结束。审批和封存仍受原权限约束"],
        ["answer", "回答正在等待信息的任务；审批只能用户在界面点击，不能用 answer 批准"],
        ["stop", "真正停止执行：回执 executionStopped=true 才算已停，false 表示停止请求已发出、正在收尾"],
      ]) + "。",
      { taskId, request: request([
        obj({ command: one("update"), instructions: instructions("新的任务内容"), profile, runAt: beijing("新的执行时间"), delayMinutes: delayMinutes("多久后执行") }, ["command"]),
        obj({ command: one("set_instructions"), instructions: instructions("新的任务内容") }, ["command", "instructions"]),
        obj({ command: one("set_profile"), profile }, ["command", "profile"]),
        obj({ command: one("reschedule"), runAt: beijing("新的执行时间"), delayMinutes: delayMinutes("多久后执行") }, ["command"]),
        obj({ command: one("resume"), supplement: str("要追加给任务的补充要求，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["command"]),
        obj({ command: one("answer"), answer: str("给等待中任务的回答，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["command", "answer"]),
        obj({ command: { type: "string", enum: ["cancel", "stop"] } }, ["command"]),
      ], allowed) },
      ["taskId", "request"]));
  }
  if (task) {
    out.push(tool("task_progress",
      "保存当前任务进度与计划（message ≤400 字；plan 1–50 步，总计 ≤8000 字，整体替换旧计划）。简单一步任务可不建计划直接交付；多步骤或复杂任务用 plan 追踪，推进时保持已有步骤 content 不变、只改 status，真实验证成功才标 completed，受阻标 blocked，不把 task_complete 列入计划。stepOutput 仅用于需要单独导出的成果。不结束本轮；回执 outlineReviewRequired=true 时交付前逐项复核 changedSteps。",
      { message: str("当前进度，1–400 字", { minLength: 1, maxLength: 400 }),
        plan: { type: "array", minItems: 1, maxItems: 50, description: "完整计划，包括未来步骤", items: obj({
          content: str("步骤描述，1–500 字", { minLength: 1, maxLength: 500 }),
          status: str("", { enum: ["pending", "in_progress", "completed", "failed", "blocked", "cancelled"] }),
        }, ["content", "status"]) },
        tellUser: { type: "boolean", description: "true 时把 message 发到沟通会话（纯文字、不挂任务卡）。写成跟人同步进度的自然短句，例如「百度搜「你好」的结果页出来了」，不要「已派单/阶段完成」这类公文腔，也不要流水账或每步工具结果。task_ask_user / task_request_approval 与最终交付另走通知并挂任务卡。每个任务最多 12 次，超出不发送（toldUser=false，进度仍保存）。省略为 false；同时给 stepOutput 时只发送产物，不重复发送进度。" },
        stepOutput: obj({
          step: int("当前完整计划中的步骤序号，从 1 开始，不是数组下标或消息编号", { minimum: 1, maximum: 50 }),
          text: str("可选：产物的完整 Markdown 内容，不写进对话正文", { minLength: 1, maxLength: 64000 }),
          ref: int("可选：已写出的产物正文消息编号，或包含 textRef 的工具回执编号；与 text 二选一", { minimum: 1 }),
          paths: { type: "array", minItems: 1, maxItems: 16, items: str("当前工作区或云端个人目录内的产物文件绝对路径", { minLength: 1, maxLength: 4096 }), description: "可选：本步骤生成的文件（如 .zip、.xlsx、.pdf、构建包等），系统读取并保存快照供用户下载；接受当前执行端工作区或云端用户 home/tmp 内的普通文件，单个不超过 25MiB、合计不超过 64MiB。不要包含凭据。" },
          preview: previewSpec("可选：阶段性的纯前端静态网页产物目录（含入口 HTML 与相对路径静态资源），系统快照托管为鉴权沙盒预览地址供已登录用户新窗口打开；仅作中间产物，最终主交付须在 task_complete.preview 提交，勿用无登录态浏览器猜测域名访问"),
        }, ["step"], `${STEP_OUTPUT_RULE} 明确填写 text、paths、preview 或正文 ref；系统单独展示并允许导出/下载/预览。已交付的产物不重复发送，已有最终报告覆盖的内容除非明确要求单独导出，否则省略。每任务最多 50 条。草稿、未执行或未验证项须如实说明。`) },
      ["message"]));
    out.push(tool("task_reschedule",
      "把当前任务整体改到以后再继续（例如用户要求晚点或明天再处理、要等的时间点还没到）：runAt 或 delayMinutes 二选一。任务转为延后并立即结束本轮，到时在原会话续做。只改本任务自己；在等已提交的外部作业结果、需要记下恢复点时用 task_wait。用户说清的时刻或周期由系统记在同一条任务上。",
      { runAt: beijing("续做时间"), delayMinutes: delayMinutes("多久后续做") }));
    out.push(tool("task_request_approval",
      "请用户审批一项需要先确认或尚未授权的不可逆操作（支付、删除、对外发送、提交审批等）：request 写清是什么操作。任务挂起并立即结束本轮；批准后在原会话继续获批事项，驳回则任务取消。常规开发分支的提交和普通推送不需要审批；缺信息用 task_ask_user。必须单独调用。",
      { request: str("要审批的具体操作，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["request"]));
    out.push(tool("task_ask_user",
      "向交代人要只有他能提供的信息，或必须他处理的阻碍（短信/邮箱验证码、访问码、2FA/OTP、扫码登录、手动浏览器操作、多选决策或结构化表单等）：question 写清需要什么。滑块/拼图/旋转等视觉验证码先用 browser_act 拖拽，连续失败后再问，不要一上来就让用户代拖。任务挂起并立即结束本轮，回答后在原会话继续。能自己查到的不要问，低风险细节自行决定；要批准操作用 task_request_approval；等待已发出的外部作业或第三方回复用 task_wait 自动休眠并定时复查，不要仅因接口回执不含下游通知送达或已读证明就改用本工具让用户手动确认。可按场景选填结构化协助字段以提供更好交互：kind（choice/qr_login/browser_action/verification/form/settings）、options（选项与推荐标记）、fields（结构化输入项）、images（二维码或当前页截图，系统也会自动补全）、browser（tabTag/url/title 以便一键跳到标签页）、quickActions（快捷回复按钮）、externalUrl 或 settingsRoute。必须单独调用。",
      {
        question: str("要对方补充或处理的内容，1–8000 字", { minLength: 1, maxLength: 8000 }),
        kind: str("可选：协助类型，默认 general", { enum: [...ASSIST_KINDS] }),
        title: str("可选：协助卡片标题，1–80 字", { minLength: 1, maxLength: 80 }),
        hint: str("可选：额外操作提示或时效提醒，1–400 字", { minLength: 1, maxLength: 400 }),
        options: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description: "可选：给用户的候选选项（适用于决策、多选或常见处理方式）",
          items: obj({
            label: str("选项标题，1–120 字", { minLength: 1, maxLength: 120 }),
            value: str("可选：回传值，省略时使用 label，1–200 字", { minLength: 1, maxLength: 200 }),
            description: str("可选：选项说明，1–240 字", { minLength: 1, maxLength: 240 }),
            recommended: { type: "boolean", description: "true 表示推荐该项" },
            tone: str("可选样式", { enum: ["default", "primary", "danger"] }),
            needsDetail: { type: "boolean", description: "true 表示选此项时需补充说明" },
          }, ["label"]),
        },
        multiSelect: { type: "boolean", description: "可选：options 是否允许复选，默认 false（单选）" },
        allowCustom: { type: "boolean", description: "可选：有 options/fields 时是否允许附加自由输入，默认 true" },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "可选：结构化输入表单项",
          items: obj({
            key: str("字段键，1–60 字", { minLength: 1, maxLength: 60 }),
            label: str("字段标签，1–80 字", { minLength: 1, maxLength: 80 }),
            type: str("字段类型：text/textarea/code/select/checkbox", { enum: ["text", "textarea", "code", "select", "checkbox"] }),
            placeholder: str("输入提示，1–120 字", { minLength: 1, maxLength: 120 }),
            description: str("字段说明，1–200 字", { minLength: 1, maxLength: 200 }),
            required: { type: "boolean" },
            defaultValue: { type: ["string", "boolean"] },
            options: { type: "array", minItems: 1, maxItems: 20, items: str("下拉选项", { minLength: 1, maxLength: 120 }) },
          }, ["key", "label"]),
        },
        images: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "可选：展示给用户的二维码或页面截图（填浏览器工具返回的纯净图 url 或文件名）",
          items: obj({
            url: str("图片地址或当前任务截图文件名，1–500 字", { minLength: 1, maxLength: 500 }),
            caption: str("可选：图片说明，1–120 字", { minLength: 1, maxLength: 120 }),
            volatile: { type: "boolean", description: "true 表示有时效性（如二维码/动态验证码）" },
          }, ["url"]),
        },
        browser: obj({
          tabTag: str("标签页 tabTag，1–200 字", { minLength: 1, maxLength: 200 }),
          url: str("页面 URL，1–2048 字", { minLength: 1, maxLength: 2048 }),
          title: str("页面标题，1–200 字", { minLength: 1, maxLength: 200 }),
        }, [], "可选：关联的浏览器标签页信息，便于用户一键跳转操作"),
        quickActions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "可选：一键快捷回复按钮（如「我已扫码完成」「重新截图」）",
          items: obj({
            label: str("按钮文字，1–60 字", { minLength: 1, maxLength: 60 }),
            reply: str("点击后提交的回复文本，1–500 字", { minLength: 1, maxLength: 500 }),
            tone: str("可选样式", { enum: ["primary", "default", "danger"] }),
          }, ["label", "reply"]),
        },
        externalUrl: obj({
          url: str("外部 HTTP(S) 链接，1–2048 字", { minLength: 1, maxLength: 2048 }),
          label: str("可选：按钮文案，1–80 字", { minLength: 1, maxLength: 80 }),
        }, ["url"], "可选：引导用户打开的外部授权/操作链接"),
        settingsRoute: str("可选：引导用户前往应用内设置页", { enum: [...ASSIST_SETTINGS_ROUTES] }),
        settingsLabel: str("可选：设置跳转按钮文案，1–80 字", { minLength: 1, maxLength: 80 }),
      }, ["question"]));
    out.push(tool("task_wait",
      "已提交的外部作业（构建、发布、导出等）或已发出的澄清请求需要等待结果时挂起当前任务：checkpoint 写作业编号或请求链接、已做的操作与回执、当前状态、检查方式和必要的升级处理（不含凭据）；resumeAt 和 delayMinutes 二选一，结合对方预计回复、工作时间及业务截止时间安排下次，不把等待时长当作任务完成期限。立即结束本轮并释放执行名额，到时在原会话续做，只检查原作业或回复，同一请求不要重发；无回复时按实际情况再次挂起，有部分回复先判断可独立继续的工作。按渠道或接口规范（含对应的对象/通知参数）提交成功并拿到回执或读回已落库，即视为已发出，应直接用本工具休眠等待定时复查，不得仅因回执未返回“对方已收到提醒/已读”等下游送达证明而改调 task_ask_user；仅当发送报错、提交结果不明或已有明确证据表明该渠道无法触达/无法触发真实提醒时才交由用户处理，持续无回复时在后续唤醒中再按 checkpoint 升级。有新疑点可发新一轮澄清并保存新回执。没有外部结果、只是把本任务改到以后做用 task_reschedule。必须单独调用。",
      { checkpoint: str("恢复点，1–8000 字", { minLength: 1, maxLength: 8000 }), resumeAt: beijing("续做时间"), delayMinutes: int("多少分钟后续做，1–10080", { minimum: 1, maximum: 10080 }) },
      ["checkpoint"]));
    if (!ctx.computer) {
      // Browser work uses same-session switch_scene(scene=computer); isolated task_relay_computer is retired.
      out.push(tool("task_complete",
        "交付并结束当前任务：未建计划的简单一步任务可直接凭真实 evidence 交付；已建计划或有补充/恢复的任务须全部步骤 completed 或 cancelled 且对应最新要求（in_progress 不能自动收尾）。可单独调用，或跟在 task_progress / memory_propose 后同拍按序收尾（不可与执行工具混批），正文可直接写在同一回复里。计划重写或有 cancelled 时必填 outlineReview；outline_review_incomplete 带 outlineReviewRetry 时只补缺项。evidence 写实际结果与验证证据；summary 写核心结论/限制（建议 100–150 字，上限 400）。步骤产物不会自动算作最终正文；deliverableRefs 可省略（自动选用尚未作为步骤产物交出的最新较长正文，含本条正文），或填正文 assistant seq（工具回执取 textRef 值）；确实无单独正文时传 []（若已有未交出正文会退回确认一次）。成功后立即结束本轮。",
        { evidence: str("完整提交必填：实际结果与验证证据，1–8000 字。补交缺项时省略", { minLength: 1, maxLength: 8000 }),
          outlineReview: { type: "array", minItems: 1, maxItems: 100, description: "计划重写或有 cancelled 步骤时必填：逐项对照原始任务、工作原则和最新要求，并复核 task_progress/回执中的 changedSteps（可直接用 changedStep 序号或填 requirement 原文）。带 outlineReviewRetry 补交时只填该回执缺项。", items: obj({
            requirement: str("一项用户要求、工作原则或 changedSteps 原文；用 changedStep 引用序号时省略", { minLength: 1, maxLength: 500 }),
            changedStep: int("可选：引用最近回执 changedSteps 中的序号（从 1 开始），首次交付与补交均可用；不可同时填 requirement", { minimum: 1, maximum: 100 }),
            status: str("met 已满足 / not_applicable 条件不适用 / unmet 尚未满足", { enum: ["met", "not_applicable", "unmet"] }),
            evidence: str("实际回执、验证证据或不适用/未完成的原因", { minLength: 1, maxLength: 2000 }),
          }, ["status", "evidence"]) },
          outlineReviewRetry: str("仅补交缺项时复制最近一次 outline_review_incomplete 的同名字段；只传此字段及缺项 outlineReview，不传 evidence、summary 或 deliverableRefs", { minLength: 1, maxLength: 100 }),
          summary: str("交付摘要，1–400 字（务必控制在 150 字以内）；只写核心结论、重要限制或需用户处理事项，勿超 400 字、勿写小标题清单", { minLength: 1, maxLength: 400 }),
          deliverableRefs: { type: "array", maxItems: 20, items: { type: "integer", minimum: 1 }, description: "可选；正文 assistant 消息编号（用回执 textRef 的值）；省略则选用尚未作为步骤产物交出的最新较长正文；仅无单独最终正文时传 []" },
          files: { type: "array", minItems: 1, maxItems: 16, items: str("当前工作区或云端个人目录内的交付文件绝对路径", { minLength: 1, maxLength: 4096 }), description: "可选：最终交付给用户下载的文件列表（如归档、文档、表格、构建包等非纯文本报告产物），系统保存快照并在聊天和任务详情提供下载；接受工作区或云端个人目录/临时目录内普通文件，单个 ≤25MiB、合计 ≤64MiB，勿含凭据" },
          preview: previewSpec("纯前端静态网页/应用产物目录（含入口 HTML 与相对路径资源）：系统快照托管为鉴权沙盒预览并在聊天与任务详情提供「新窗口打开」。未指定外部目标主机/平台时，直接用此字段交付或发布静态网页，勿在执行环境自起常驻服务替代") }));
    }
  }
  if (!ctx.member) {
    out.push(tool("memory_search",
      "检索当前热心市民的长期记忆（按相关度，默认最多 12 条）。写入或改动前先检索；status 过滤：all（默认）、active、draft、conflict、archived、pending（= draft + conflict）。",
      { query: str("检索词；省略按相关度列出", { maxLength: 2000 }),
        status: str("", { enum: ["all", "active", "draft", "conflict", "archived", "pending"] }),
        memoryScene: str("适用场景过滤", { enum: ["chat", "coding", "computer", "any"] }) }));
    out.push(tool("memory_propose",
      "写入一条跨任务仍成立的稳定事实：claim 1–200 字，一条一事；同向近义自动合并，矛盾的进入 conflict，person_org 人事类先进 draft 待用户确认，其余直接生效；带 memoryId 时改写该条。声称“已记住”前必须调用成功；临时进度、验证码、一次性链接和凭据不进记忆。确认、合并、归档、钉选或删除用 memory_manage。",
      { claim: str("稳定主张，1–200 字", { minLength: 1, maxLength: 200 }),
        memoryKind: str("preference 偏好、convention 约定、procedure 流程、environment 环境、person_org 人事、correction 纠错；省略时按主张内容自动推断（改写已有条目时也会重新推断）", { enum: ["preference", "convention", "procedure", "environment", "person_org", "correction"] }),
        scope: str("作用域：global、项目路径或站点 host；省略时任务中为工作目录，否则 global", { maxLength: 500 }),
        memoryScene: str("适用场景；省略时任务中按当前场景，否则 chat", { enum: ["chat", "coding", "computer", "any"] }),
        evidence: str("简短核实依据", { maxLength: 500 }),
        tags: { type: "array", maxItems: 8, items: str("标签，不超过 40 字", { maxLength: 40 }), description: "可选自由标签（项目、技术栈、站点等），也参与检索；也可直接写在 claim 里如 #vue，两条路径等价" },
        memoryId: str("要改写的记忆 ID；省略为新写入", { minLength: 1 }),
        pinned: { type: "boolean", description: "true 钉选：在适用场景和作用域内每轮都注入、不看相关度（与偏好、纠错类同属常驻记忆，共最多 8 条，钉选优先），也不会被自动归档；false 取消钉选；省略不改" } },
      ["claim"]));
    out.push(tool("memory_manage",
      "改变已有记忆的状态，request.command 选一种：confirm 把草稿或冲突确认为生效（可同时改写 claim，与它冲突的其它条归档）；merge 合并 memoryIds（≥2 条，保留 keepId 或最有用的一条，其余归档）；keep 设为生效并钉选（冲突时保留双方）；archive 归档；restore 恢复为生效；feedback 记录使用反馈 signal（signal=correction 时另建一条纠错记忆，claim 写纠正后的主张，省略为“不再沿用原主张”）；pin / unpin 钉选或取消；forget 删除这一条。写入新内容用 memory_propose。",
      { request: request([
        obj({ command: one("confirm"), memoryId, claim: str("确认时改写的主张，1–200 字", { minLength: 1, maxLength: 200 }) }, ["command", "memoryId"]),
        obj({ command: one("merge"), memoryIds: { type: "array", minItems: 2, maxItems: 20, items: str("", { minLength: 1 }), description: "要合并的记忆 ID" }, keepId: str("保留的主 ID", { minLength: 1 }) }, ["command", "memoryIds"]),
        obj({ command: one("feedback"), memoryId, signal: str("", { enum: ["success", "correction", "unused", "helpful", "unhelpful", "edited"] }), claim: str("仅 signal=correction：纠正后的主张，1–200 字", { minLength: 1, maxLength: 200 }) }, ["command", "memoryId", "signal"]),
        obj({ command: { type: "string", enum: ["keep", "archive", "restore", "pin", "unpin", "forget"] }, memoryId }, ["command", "memoryId"]),
      ]) },
      ["request"]));
  }
  return out;
}

export function vaultTools(ctx: ToolContext): Tool[] {
  // Each employee reads its owner's book, limited to the entries that apply to it; a plain session has no employee and no book.
  if (ctx.kind === "normal") return [];
  return [
    tool("vault_list", "列出创建者密码本里适用于当前热心市民的条目 id、类型（login 账号密码 / token API 密钥或令牌 / ssh_key SSH 私钥 / general 万能）、名称和使用条件（不含凭据内容）。取用前先看 condition，选出唯一适用的条目。增删改由本人在「设置 → 密码本」里操作。"),
    tool("vault_get",
      "按 credentialId 取一条凭据供本轮使用：purpose 写清本次用途及为什么符合该条 condition；系统结合当前页面核对条件，不符则拒绝且不取出。凭据内容不进入对话记录，只用于当前授权操作，不写进回复、记忆、计划或交接。ssh_key 类型不返回私钥原文：系统在当前执行位置（服务端或所选客户端）写入本轮临时私钥文件，返回 keyFile 和可直接用于 git 的 GIT_SSH_COMMAND，本轮结束自动删除。",
      { credentialId, purpose: str("本次用途及为什么符合使用条件，1–8000 字", { minLength: 1, maxLength: 8000 }), url: vaultUrl },
      ["credentialId", "purpose"]),
  ];
}

export const BROWSER_TOOL_DEFINITIONS = browserTools as Tool[];
export const BROWSER_TOOLS = new Set(BROWSER_TOOL_DEFINITIONS.map((t) => t.name));
export const CHROME_TOOL_DEFINITIONS = BROWSER_TOOL_DEFINITIONS;
export const CHROME_TOOLS = BROWSER_TOOLS;
export const LEGACY_CHROME_TOOLS = new Set([
  "chrome_tabs", "chrome_navigate", "chrome_tab_control", "chrome_inspect",
  "chrome_screenshot", "chrome_act", "chrome_evaluate", "chrome_run",
  "chrome_connection", "chrome_downloads", "chrome_devtools",
  "chrome_experience_search", "chrome_experience_save", "chrome_experience_feedback",
]);
export const EMPLOYEE_TOOLS = new Set([
  "employee_status", "employee_task_create", "employee_task_manage",
  "task_progress", "task_reschedule", "task_request_approval", "task_ask_user", "task_wait", "task_relay_computer", "task_complete",
  "memory_search", "memory_propose", "memory_manage",
]);
export const VAULT_TOOLS = new Set(["vault_list", "vault_get"]);
/** Calls that suspend, hand off or end the turn: they must be the only call in a batch. */
export const STANDALONE_TOOLS = new Set(["task_request_approval", "task_ask_user", "task_wait", "task_relay_computer", "task_complete"]);

export type Internal = { tool: "chrome" | "employee"; args: Obj; target?: "task" };

/** runAt / delayMinutes → the old nextAt / nextCheckInMinutes; exactly one unless optional. */
function when(a: Obj, path: string, required = true): Obj {
  const both = a.runAt !== undefined && a.delayMinutes !== undefined, none = a.runAt === undefined && a.delayMinutes === undefined;
  if (both || (required && none)) throw new ArgumentError(`参数${path}.runAt 和 参数${path}.delayMinutes ${required ? "必须恰好填一个" : "最多填一个"}`);
  return Object.fromEntries(Object.entries({ nextAt: a.runAt, nextCheckInMinutes: a.delayMinutes }).filter(([, v]) => v !== undefined));
}

/** Map a validated public call onto the existing internal executor arguments. Fixed values cannot be overridden. */
export function toInternal(name: string, a: Obj, ctx: ToolContext): Internal {
  const chrome = (args: Obj): Internal => ({ tool: "chrome", args });
  const employee = (args: Obj, target?: Internal["target"]): Internal => ({ tool: "employee", args, ...(target ? { target } : {}) });
  const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  if (BROWSER_TOOLS.has(name)) {
    return chrome({ operation: name, ...a });
  }
  switch (name) {

    case "employee_status": return employee(defined({ action: "list", id: a.taskId, key: a.dedupeKey, status: a.status === "all" ? undefined : a.status, query: a.memoryQuery }));
    case "employee_task_create":
      return employee(defined({ action: "add", kind: "todo", text: a.instructions, key: a.dedupeKey, parentTaskId: a.parentTaskId, relation: a.relation, branchLabel: a.branchLabel, ...when(a, "", false), profile: a.profile }));
    case "employee_task_manage": {
      const r = a.request, id = a.taskId;
      switch (r.command) {
        case "update": {
          const at = r.runAt !== undefined || r.delayMinutes !== undefined ? when(r, ".request") : {};
          const fields = defined({ text: r.instructions, profile: r.profile, ...at });
          if (!Object.keys(fields).length) throw new ArgumentError("参数.request 的 update 至少要改一项：instructions、profile、runAt 或 delayMinutes");
          return employee({ action: "update", id, ...fields }, "task");
        }
        case "set_instructions": return employee({ action: "update", id, text: r.instructions }, "task");
        case "set_profile": return employee({ action: "update", id, profile: r.profile }, "task");
        case "reschedule": return employee({ action: "update", id, ...when(r, ".request") }, "task");
        case "cancel": return employee({ action: "done", id }, "task");
        case "resume": return employee(defined({ action: "resume", id, text: r.supplement }), "task");
        case "answer": return employee({ action: "answer", id, text: r.answer }, "task");
        default: return employee({ action: "stop", id }, "task");
      }
    }
    case "task_progress": return employee(defined({ action: "progress", text: a.message, plan: a.plan, tellUser: a.tellUser, stepOutput: a.stepOutput }));
    case "task_reschedule":
      if (!ctx.taskId) throw new ArgumentError("task_reschedule 只能在任务会话中使用");
      return employee({ action: "update", id: ctx.taskId, ...when(a, "") });
    case "task_request_approval": return employee({ action: "ask", text: a.request });
    case "task_ask_user": {
      const assist = defined({
        kind: a.kind,
        title: a.title,
        hint: a.hint,
        options: a.options,
        multiSelect: a.multiSelect,
        allowCustom: a.allowCustom,
        fields: a.fields,
        images: a.images,
        browser: a.browser,
        quickActions: a.quickActions,
        externalUrl: a.externalUrl,
        settingsRoute: a.settingsRoute,
        settingsLabel: a.settingsLabel,
      });
      return employee(defined({ action: "help", text: a.question, ...(Object.keys(assist).length ? { assist } : {}) }));
    }
    case "task_wait": {
      if ((a.resumeAt === undefined) === (a.delayMinutes === undefined)) throw new ArgumentError("参数.resumeAt 和 参数.delayMinutes 必须恰好填一个");
      return employee(defined({ action: "defer", text: a.checkpoint, nextAt: a.resumeAt, nextCheckInMinutes: a.delayMinutes }));
    }
    case "task_relay_computer": return employee({ action: "relay", scene: "computer", text: a.handoff });
    case "task_complete": {
      if (a.evidence === undefined && a.outlineReviewRetry === undefined) throw new ArgumentError("参数 缺少必填字段 evidence（仅补交复核缺项时可省略）");
      return employee(defined({ action: "complete", text: a.evidence, summary: a.summary, deliverableRef: a.deliverableRefs, outlineReview: a.outlineReview, outlineReviewRetry: a.outlineReviewRetry, files: a.files, preview: a.preview }));
    }
    case "memory_search": return employee(defined({ action: "memory_search", query: a.query, status: a.status, memoryScene: a.memoryScene }));
    case "memory_propose": return employee(defined({ action: "memory_propose", claim: a.claim, memoryKind: a.memoryKind, scope: a.scope, tags: a.tags, memoryScene: a.memoryScene, evidence: a.evidence, id: a.memoryId, pinned: a.pinned }));
    case "memory_manage": {
      const r = a.request;
      if (r.command === "pin" || r.command === "unpin") return employee({ action: "memory_pin", id: r.memoryId, pinned: r.command === "pin" });
      if (r.command === "forget") return employee({ action: "memory_resolve", resolveAction: "drop", id: r.memoryId });
      if (r.command === "merge") return employee(defined({ action: "memory_resolve", resolveAction: "merge", ids: r.memoryIds, keepId: r.keepId }));
      return employee(defined({ action: "memory_resolve", resolveAction: r.command, id: r.memoryId, claim: r.claim, signal: r.signal }));
    }
    case "vault_list": return employee({ action: "vault_list" });
    case "vault_get": return employee(defined({ action: "vault_get", id: a.credentialId, text: a.purpose, url: a.url }));
  }
  throw new ArgumentError("Unknown tool " + name);
}
