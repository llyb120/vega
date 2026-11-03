import chromeTools from "../../shared/chrome-tools.json";
import type { Tool } from "./provider";
import type { Obj } from "./util";
import { omittable } from "./tool-args";

/**
 * Model-facing tools are narrow, per-purpose schemas. Each one maps onto the existing internal
 * chrome / employee / vault executors, so runtime behaviour (observations, receipts, permissions,
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
const dutyId = str("职责 ID（employee_status 的 duties[].id）", { minLength: 1 });
const memoryId = str("记忆 ID（memory_search 返回的 id）", { minLength: 1 });
const credentialId = str("密码本条目 ID（vault_list 返回的 id）", { minLength: 1 });
const instructions = (what: string) => str(what + "，1–8000 字", { minLength: 1, maxLength: 8000 });
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

export const TASK_COMMANDS = ["set_instructions", "reschedule", "cancel", "resume", "answer", "stop"];
export const DUTY_COMMANDS = ["set_instructions", "set_note", "set_manual", "set_condition", "schedule_next", "enable", "disable", "remove"];
export const MEMORY_COMMANDS = ["confirm", "merge", "keep", "archive", "restore", "feedback", "pin", "unpin", "forget"];

export type ToolContext = {
  /** normal: user session; chat: employee chat; task: employee task (main or computer side). */
  kind: "normal" | "chat" | "task";
  computer?: boolean;
  /** Team employee chat whose current actor cannot manage the employee. */
  member?: boolean;
  /** Task session: visible duty commands for the task's own duty (empty = no duty tool). */
  dutyCommands?: string[];
  vaultRequest?: boolean;
  vaultSend?: boolean;
};

export function employeeTools(ctx: ToolContext): Tool[] {
  const out: Tool[] = [];
  const task = ctx.kind === "task";
  out.push(tool("employee_status",
    "查看当前牛马总览：现在时间（北京时间）、职责、任务和进行中的待办、最近运行、相关记忆和待确认记忆、可用场景。派单、续做、停止或修改职责前用它核对 taskId 和 dutyId；查记忆细节用 memory_search。"));
  out.push(tool("employee_task_create",
    "给当前牛马派一条新的独立任务，默认立即排队，给 runAt 则到时再做；完成后自动收尾。dedupeKey 填业务唯一标识（如 tapd:需求ID），同 key 的任务已存在（含已收尾的）时不新建，返回原任务。要对查到的每一项各走一遍流程时，每项各建一条并用 dedupeKey 去重。反复、定时或按条件做的事用 employee_duty_create" +
      (task ? "；本任务自己的步骤写进 task_progress，不要拆成新任务。" : "。"),
    { instructions: instructions("任务要做什么、交付标准，保留用户原话和约束"), dedupeKey: str("业务唯一标识，≤200 字", { minLength: 1, maxLength: 200 }), runAt: beijing("开始时间；省略立即排队") },
    ["instructions"]));
  if (!task) {
    const allowed = ctx.kind === "chat" ? (ctx.member ? ["resume", "answer", "stop"] : TASK_COMMANDS) : ["set_instructions", "reschedule", "cancel"];
    out.push(tool("employee_task_manage",
      "管理一条指定任务（taskId），request.command 选一种：" + commands(allowed, [
        ["set_instructions", "改尚未开始的任务内容（职责触发的任务不能改）"],
        ["reschedule", "改执行时间 runAt（职责触发的任务不能改期）"],
        ["cancel", "取消任务并保留记录，不交付（运行中的先 stop）"],
        ["resume", "不带 supplement 时继续已停止、失败或取消的任务（复用原会话和计划）；带 supplement 时给未收尾的任务追加要求，相同内容不会重复记录"],
        ["answer", "回答正在等待信息的任务；审批只能用户在界面点击，不能用 answer 批准"],
        ["stop", "真正停止执行：回执 executionStopped=true 才算已停，false 表示停止请求已发出、正在收尾"],
      ]) + "。",
      { taskId, request: request([
        obj({ command: one("set_instructions"), instructions: instructions("新的任务内容") }, ["command", "instructions"]),
        obj({ command: one("reschedule"), runAt: beijing("新的执行时间") }, ["command", "runAt"]),
        obj({ command: one("resume"), supplement: str("要追加给任务的补充要求，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["command"]),
        obj({ command: one("answer"), answer: str("给等待中任务的回答，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["command", "answer"]),
        obj({ command: { type: "string", enum: ["cancel", "stop"] } }, ["command"]),
      ], allowed) },
      ["taskId", "request"]));
  }
  const dutyAllowed = task ? ctx.dutyCommands || [] : ctx.member ? [] : DUTY_COMMANDS;
  if (!task && !ctx.member)
    out.push(tool("employee_duty_create",
      "新建一条职责（反复执行的工作，归用户所有，只在用户明确要求时创建）：instructions 写每次做什么；trigger 选 {kind:\"manual\"}（不定时，只按交代的任务需要执行，不自动触发）或 {kind:\"condition\",condition}（自然语言触发条件，如“每天 9 点”“每 30 分钟检查”，系统编译成触发规则，无法可靠识别时报错）；note 写用户的细化要求，每次执行都会带上。一次性的事用 employee_task_create。",
      { instructions: instructions("每次触发时要做的事"),
        trigger: { anyOf: [
          obj({ kind: one("manual") }, ["kind"], "不定时，不自动触发"),
          obj({ kind: one("condition"), condition: str("自然语言触发条件，1–2000 字；外部事件无法自动监听，须写明检查频率", { minLength: 1, maxLength: 2000 }) }, ["kind", "condition"], "按条件自动触发"),
        ] },
        note: str("用户对这条职责的细化要求，≤4096 字节") },
      ["instructions", "trigger"]));
  if (dutyAllowed.length)
    out.push(tool("employee_duty_manage",
      (task ? "管理本任务所属的职责（dutyId 只能是本任务的职责），只能：" : "管理一条指定职责（dutyId），只在用户明确要求时调用，每次只改一个方面：") + commands(dutyAllowed, [
        ["set_instructions", "替换职责内容（同步到尚未开始的派生任务）"],
        ["set_note", "替换备注，\"\" 清空"],
        ["set_manual", "改为不定时：清除自动触发规则，只按交代的任务需要执行（不是停用）"],
        ["set_condition", "用自然语言替换触发规则，系统重新编译"],
        ["schedule_next", "给动态职责（没有固定时刻或间隔的职责）安排下一次执行时间 runAt"],
        ["enable", "启用"],
        ["disable", "停用，并取消它还没收尾的任务（含派生的）"],
        ["remove", "删除职责，并取消它还没收尾的任务"],
      ]) + "。",
      { dutyId, request: request([
        obj({ command: one("set_instructions"), instructions: instructions("新的职责内容") }, ["command", "instructions"]),
        obj({ command: one("set_note"), note: str("新的备注，\"\" 清空，≤4096 字节") }, ["command", "note"]),
        obj({ command: one("set_condition"), condition: str("自然语言触发条件，1–2000 字", { minLength: 1, maxLength: 2000 }) }, ["command", "condition"]),
        obj({ command: one("schedule_next"), runAt: beijing("下一次执行时间") }, ["command", "runAt"]),
        obj({ command: { type: "string", enum: ["set_manual", "enable", "disable", "remove"] } }, ["command"]),
      ], dutyAllowed) },
      ["dutyId", "request"]));
  if (task) {
    out.push(tool("task_progress",
      "保存当前任务的进度：message 是一句进度（≤200 字），plan 是完整计划（1–50 步，每步 content + status，总计 ≤8000 字，整体替换旧计划）。首次执行前提交完整计划并写明交付类型，之后状态或要求变化时再提交完整计划；只有真实验证成功的步骤才标 completed，用户放弃的步骤标 cancelled。不新建任务或会话，不结束本轮。",
      { message: str("当前进度，1–200 字", { minLength: 1, maxLength: 200 }),
        plan: { type: "array", minItems: 1, maxItems: 50, description: "完整计划，包括未来步骤", items: obj({
          content: str("步骤描述，1–500 字", { minLength: 1, maxLength: 500 }),
          status: str("", { enum: ["pending", "in_progress", "completed", "failed", "blocked", "cancelled"] }),
        }, ["content", "status"]) } },
      ["message"]));
    out.push(tool("task_request_approval",
      "请用户审批一项需要先确认或尚未授权的不可逆操作（支付、删除、对外发送、提交审批等）：request 写清是什么操作。任务挂起并立即结束本轮；批准后在原会话继续获批事项，驳回则任务取消。常规开发分支的提交和普通推送不需要审批；缺信息用 task_ask_user。必须单独调用。",
      { request: str("要审批的具体操作，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["request"]));
    out.push(tool("task_ask_user",
      "向交代人要只有他能提供的信息，或必须他处理的阻碍（如验证码、访问码、2FA）：question 写清需要什么。任务挂起并立即结束本轮，回答后在原会话继续。能自己查到的不要问，低风险细节自行决定；要批准操作用 task_request_approval。必须单独调用。",
      { question: str("要对方补充或处理的内容，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["question"]));
    out.push(tool("task_wait",
      "已提交的外部作业（构建、发布、导出等）要较久才出结果时挂起当前任务：checkpoint 写作业编号或链接、已做的操作、当前状态、检查方式与超时处理（不含凭据）；resumeAt 和 delayMinutes 二选一。立即结束本轮并释放执行名额，到时在原会话续做，只检查原作业，不要重新提交或循环等待。必须单独调用。",
      { checkpoint: str("恢复点，1–8000 字", { minLength: 1, maxLength: 8000 }), resumeAt: beijing("续做时间"), delayMinutes: int("多少分钟后续做，1–10080", { minimum: 1, maximum: 10080 }) },
      ["checkpoint"]));
    if (!ctx.computer) {
      out.push(tool("task_relay_computer",
        "把需要操作网页或电脑的工作交给本任务唯一的电脑会话：handoff 写清要做的操作、授权与约束、已完成和已尝试的操作、页面/文件/作业位置、交付类型和完成标准，不写凭据。立即结束本轮；电脑会话做完后结果自动交回本会话。写代码用 switch_scene，不要交接。必须单独调用。",
        { handoff: str("交接内容，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["handoff"]));
      out.push(tool("task_complete",
        "交付并结束当前任务：计划须已全部 completed 或 cancelled 且对应最新要求。evidence 写实际结果与验证证据；summary 写给用户的 1–400 字摘要（先结论，再重要变化、限制或需用户处理的事项）；deliverableRefs 填交付正文所在的你自己的回复消息编号（工具回执的 textRef 就是当条回复的编号），可多条按顺序拼接，没有单独正文传 []。成功后立即结束本轮；校验不通过或有新补充时返回原因，按提示处理后再交付。必须单独调用。",
        { evidence: str("实际结果与验证证据，1–8000 字", { minLength: 1, maxLength: 8000 }),
          summary: str("交付摘要，1–400 字", { minLength: 1, maxLength: 400 }),
          deliverableRefs: { type: "array", maxItems: 20, items: { type: "integer", minimum: 1 }, description: "交付正文的消息编号；没有单独正文传 []" } },
        ["evidence", "deliverableRefs"]));
    }
  }
  if (!ctx.member) {
    out.push(tool("memory_search",
      "检索当前牛马的长期记忆（按相关度，默认最多 12 条）。写入或改动前先检索；status 过滤：all（默认）、active、draft、conflict、archived、pending（= draft + conflict）。",
      { query: str("检索词；省略按相关度列出", { maxLength: 2000 }),
        status: str("", { enum: ["all", "active", "draft", "conflict", "archived", "pending"] }),
        memoryScene: str("适用场景过滤", { enum: ["chat", "coding", "computer", "any"] }) }));
    out.push(tool("memory_propose",
      "写入一条跨任务仍成立的稳定事实：claim 1–200 字，一条一事；同向近义自动合并，矛盾的进入 conflict，高风险的可能先进 draft；带 memoryId 时改写该条。声称“已记住”前必须调用成功；临时进度、验证码、一次性链接和凭据不进记忆。确认、合并、归档、钉选或删除用 memory_manage。",
      { claim: str("稳定主张，1–200 字", { minLength: 1, maxLength: 200 }),
        memoryKind: str("preference 偏好、convention 约定、procedure 流程、environment 环境、person_org 人事、correction 纠错", { enum: ["preference", "convention", "procedure", "environment", "person_org", "correction"] }),
        scope: str("作用域：global、项目路径、站点 host 或职责 id；省略时任务中为工作目录，否则 global", { maxLength: 500 }),
        memoryScene: str("适用场景；省略时任务中按当前场景，否则 chat", { enum: ["chat", "coding", "computer", "any"] }),
        evidence: str("简短核实依据", { maxLength: 500 }),
        memoryId: str("要改写的记忆 ID；省略为新写入", { minLength: 1 }) },
      ["claim", "memoryKind"]));
    out.push(tool("memory_manage",
      "改变已有记忆的状态，request.command 选一种：confirm 把草稿或冲突确认为生效（可同时改写 claim，与它冲突的其它条归档）；merge 合并 memoryIds（≥2 条，保留 keepId 或最有用的一条，其余归档）；keep 设为生效并钉选（冲突时保留双方）；archive 归档；restore 恢复为生效；feedback 记录使用反馈 signal；pin / unpin 钉选或取消；forget 删除这一条。写入新内容用 memory_propose。",
      { request: request([
        obj({ command: one("confirm"), memoryId, claim: str("确认时改写的主张，1–200 字", { minLength: 1, maxLength: 200 }) }, ["command", "memoryId"]),
        obj({ command: one("merge"), memoryIds: { type: "array", minItems: 2, maxItems: 20, items: str("", { minLength: 1 }), description: "要合并的记忆 ID" }, keepId: str("保留的主 ID", { minLength: 1 }) }, ["command", "memoryIds"]),
        obj({ command: one("feedback"), memoryId, signal: str("", { enum: ["success", "correction", "unused", "helpful", "unhelpful", "edited"] }) }, ["command", "memoryId", "signal"]),
        obj({ command: { type: "string", enum: ["keep", "archive", "restore", "pin", "unpin", "forget"] }, memoryId }, ["command", "memoryId"]),
      ]) },
      ["request"]));
  }
  return out;
}

export function vaultTools(ctx: ToolContext): Tool[] {
  if (ctx.member) return [];
  const out: Tool[] = [
    tool("vault_list", "列出全局密码本条目的 id、名称和使用条件（不含凭据内容" + (ctx.kind === "task" ? "；包括本任务收到的临时条目" : "") + "）。取用前先看 condition，选出唯一适用的条目。增删改只有用户能在「设置 → 密码本」操作。"),
    tool("vault_get",
      "按 credentialId 取一条凭据供本轮使用：purpose 写清本次用途及为什么符合该条 condition；系统结合当前页面核对条件，不符则拒绝且不取出。凭据内容不进入对话记录，只用于当前授权操作，不写进回复、记忆、计划或交接。",
      { credentialId, purpose: str("本次用途及为什么符合使用条件，1–8000 字", { minLength: 1, maxLength: 8000 }), url: vaultUrl },
      ["credentialId", "purpose"]),
  ];
  if (ctx.vaultRequest)
    out.push(tool("vault_request",
      "执行团队成员交代的任务、密码本缺少所需凭据时，请交代人的本地密码本加密支援：requirement 写需要哪个系统的哪类凭据。任务挂起并立即结束本轮；收到后存为本任务的临时条目，用 vault_list / vault_get 取用。必须单独调用。",
      { requirement: str("需要的凭据，1–8000 字", { minLength: 1, maxLength: 8000 }) }, ["requirement"]));
  if (ctx.vaultSend)
    out.push(tool("vault_send",
      "凭据支援任务专用：把允许共享、非临时且符合使用条件的条目加密发回请求方，不在回复里写明文。立即结束本轮。自己要用凭据用 vault_get。必须单独调用。",
      { credentialId, url: vaultUrl }, ["credentialId"]));
  return out;
}

export const CHROME_TOOL_DEFINITIONS = chromeTools as Tool[];
export const CHROME_TOOLS = new Set(CHROME_TOOL_DEFINITIONS.map((t) => t.name));
export const EMPLOYEE_TOOLS = new Set([
  "employee_status", "employee_task_create", "employee_task_manage", "employee_duty_create", "employee_duty_manage",
  "task_progress", "task_request_approval", "task_ask_user", "task_wait", "task_relay_computer", "task_complete",
  "memory_search", "memory_propose", "memory_manage",
]);
export const VAULT_TOOLS = new Set(["vault_list", "vault_get", "vault_request", "vault_send"]);
/** Calls that suspend, hand off or end the turn: they must be the only call in a batch. */
export const STANDALONE_TOOLS = new Set(["task_request_approval", "task_ask_user", "task_wait", "task_relay_computer", "task_complete", "vault_request", "vault_send"]);

export type Internal = { tool: "chrome" | "employee" | "vault"; args: Obj; target?: "task" | "duty" };

/** Map a validated public call onto the existing internal executor arguments. Fixed values cannot be overridden. */
export function toInternal(name: string, a: Obj, ctx: ToolContext): Internal {
  const chrome = (args: Obj): Internal => ({ tool: "chrome", args });
  const employee = (args: Obj, target?: Internal["target"]): Internal => ({ tool: "employee", args, ...(target ? { target } : {}) });
  const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (name) {
    case "chrome_tabs": return chrome(defined({ operation: "tabs", query: a.query, incognito: a.incognito }));
    case "chrome_navigate":
      return a.target.kind === "existing_tab"
        ? chrome({ operation: "goto", tabTag: a.target.tabTag, url: a.url })
        : chrome(defined({ operation: "open", url: a.url, incognito: a.target.incognito }));
    case "chrome_tab_control":
      return chrome({ operation: ({ select: "select_tab", close: "close_tab" } as Obj)[a.command] || a.command, tabTag: a.tabTag });
    case "chrome_inspect":
      return chrome(defined({ operation: "inspect", tabTag: a.tabTag, query: a.query, scope: a.scope, visual: a.visual, maxItems: a.maxItems, maxTextChars: a.maxTextChars }));
    case "chrome_screenshot": {
      const c = a.capture;
      return chrome(defined({
        operation: "screenshot", tabTag: a.tabTag, maxEdge: c.maxEdge,
        ...(c.kind === "page" ? { fullPage: true, tileOffset: c.tileOffset } : {}),
        ...(c.kind === "element" ? { ref: c.ref, frame: c.frame } : {}),
        ...(c.kind === "region" ? { region: c.region } : {}),
        ...(c.kind === "scroll_area" ? { expandScroll: true, ref: c.ref } : {}),
      }));
    }
    case "chrome_act":
      return chrome(defined({ operation: "act", tabTag: a.tabTag, imageId: a.imageId, visual: a.visual, settleMs: a.settleMs, actions: a.actions.map(chromeAction) }));
    case "chrome_evaluate":
      return chrome(defined({ operation: "evaluate", tabTag: a.tabTag, expression: a.expression, frame: a.frame, visual: a.visual, ...(a.observe === false ? { feedback: "none" } : {}) }));
    case "chrome_run":
      return chrome({ operation: "run", tabTag: a.tabTag, plan: defined({ task: a.task, steps: a.steps, authorization: a.authorization, expectedText: a.expectedText, inputs: a.inputs, maxActions: a.maxActions }) });
    case "chrome_connection": return chrome({ operation: a.command === "cancel_operation" ? "stop" : "status" });
    case "chrome_downloads": return chrome(defined({ operation: "downloads", downloadId: a.downloadId, since: a.since }));
    case "chrome_devtools":
      return chrome({ operation: "devtools", tabTag: a.tabTag, devtools: defined({ kind: a.kind, query: a.query, level: a.level, limit: a.limit, requestId: a.requestId, clear: a.clear }) });
    case "chrome_experience_search":
      return chrome({ operation: "experience_search", experience: defined({ scope: a.scope, task: a.task, prefix: a.prefix }) });
    case "chrome_experience_save":
      return chrome({ operation: "experience_save", tabTag: a.tabTag, snapshotId: a.snapshotId, experience: defined({ scope: a.scope, task: a.task, conditions: a.conditions, steps: a.steps, checks: a.checks, pitfalls: a.pitfalls, alternatives: a.alternatives, evidence: a.evidence, redacted: a.redacted, outcome: "success" }) });
    case "chrome_experience_feedback":
      return chrome({ operation: "experience_feedback", tabTag: a.tabTag, snapshotId: a.snapshotId, experience: { scope: a.scope, task: a.task, id: a.routeId, outcome: a.outcome, reason: a.reason, redacted: a.redacted } });

    case "employee_status": return employee({ action: "list" });
    case "employee_task_create": return employee(defined({ action: "add", kind: "todo", text: a.instructions, key: a.dedupeKey, nextAt: a.runAt }));
    case "employee_task_manage": {
      const r = a.request, id = a.taskId;
      switch (r.command) {
        case "set_instructions": return employee({ action: "update", id, text: r.instructions }, "task");
        case "reschedule": return employee({ action: "update", id, nextAt: r.runAt }, "task");
        case "cancel": return employee({ action: "done", id }, "task");
        case "resume": return employee(defined({ action: "resume", id, text: r.supplement }), "task");
        case "answer": return employee({ action: "answer", id, text: r.answer }, "task");
        default: return employee({ action: "stop", id }, "task");
      }
    }
    case "employee_duty_create":
      return employee(defined({ action: "add", kind: "duty", text: a.instructions, note: a.note, ...(a.trigger.kind === "manual" ? { manual: true } : { condition: a.trigger.condition }) }));
    case "employee_duty_manage": {
      const r = a.request, id = a.dutyId;
      const fields: Obj = {
        set_instructions: { text: r.instructions }, set_note: { note: r.note }, set_manual: { manual: true },
        set_condition: { condition: r.condition }, schedule_next: { nextAt: r.runAt }, enable: { enabled: true }, disable: { enabled: false },
      };
      return employee(r.command === "remove" ? { action: "done", id } : { action: "update", id, ...fields[r.command] }, "duty");
    }
    case "task_progress": return employee(defined({ action: "progress", text: a.message, plan: a.plan }));
    case "task_request_approval": return employee({ action: "ask", text: a.request });
    case "task_ask_user": return employee({ action: "help", text: a.question });
    case "task_wait": {
      if ((a.resumeAt === undefined) === (a.delayMinutes === undefined)) throw new ArgumentError("参数.resumeAt 和 参数.delayMinutes 必须恰好填一个");
      return employee(defined({ action: "defer", text: a.checkpoint, nextAt: a.resumeAt, nextCheckInMinutes: a.delayMinutes }));
    }
    case "task_relay_computer": return employee({ action: "relay", scene: "computer", text: a.handoff });
    case "task_complete": return employee(defined({ action: "complete", text: a.evidence, summary: a.summary, deliverableRef: a.deliverableRefs }));
    case "memory_search": return employee(defined({ action: "memory_search", query: a.query, status: a.status, memoryScene: a.memoryScene }));
    case "memory_propose": return employee(defined({ action: "memory_propose", claim: a.claim, memoryKind: a.memoryKind, scope: a.scope, memoryScene: a.memoryScene, evidence: a.evidence, id: a.memoryId }));
    case "memory_manage": {
      const r = a.request;
      if (r.command === "pin" || r.command === "unpin") return employee({ action: "memory_pin", id: r.memoryId, pinned: r.command === "pin" });
      if (r.command === "forget") return employee({ action: "memory_resolve", resolveAction: "drop", id: r.memoryId });
      if (r.command === "merge") return employee(defined({ action: "memory_resolve", resolveAction: "merge", ids: r.memoryIds, keepId: r.keepId }));
      return employee(defined({ action: "memory_resolve", resolveAction: r.command, id: r.memoryId, claim: r.claim, signal: r.signal }));
    }
    case "vault_list": return ctx.kind === "normal" ? { tool: "vault", args: { action: "list" } } : employee({ action: "vault_list" });
    case "vault_get":
      return ctx.kind === "normal"
        ? { tool: "vault", args: defined({ action: "get", id: a.credentialId, text: a.purpose, url: a.url }) }
        : employee(defined({ action: "vault_get", id: a.credentialId, text: a.purpose, url: a.url }));
    case "vault_request": return employee({ action: "vault_request", text: a.requirement });
    case "vault_send": return employee(defined({ action: "vault_send", id: a.credentialId, url: a.url }));
  }
  throw new ArgumentError("Unknown tool " + name);
}

function chromeAction(v: Obj): Obj {
  const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
  switch (v.action) {
    case "click": return defined({ action: "click", ref: v.ref, frame: v.frame, button: v.button, click_count: v.clickCount });
    case "fill": return defined({ action: "fill", ref: v.ref, text: v.value, frame: v.frame });
    case "type": return { action: "type", text: v.text };
    case "press": return { action: "press", key: v.key };
    case "scroll": return defined({ action: "scroll", delta: v.deltaY, delta_x: v.deltaX, ref: v.ref, frame: v.frame });
    case "wait": return { action: "wait", ms: v.milliseconds };
    case "upload": return defined({ action: "upload", selector: v.selector, files: v.files, frame: v.frame });
    case "click_at": return defined({ action: "click_at", x: v.x, y: v.y, button: v.button, click_count: v.clickCount });
    case "move": return { action: "move", x: v.x, y: v.y };
    case "drag": return defined({ action: "drag", x: v.fromX, y: v.fromY, to_x: v.toX, to_y: v.toY, duration_ms: v.durationMs });
    default: return defined({ action: "scroll_at", x: v.x, y: v.y, delta: v.deltaY, delta_x: v.deltaX });
  }
}
