/**
 * 事件驱动的工作接入，以及用户明确点名的定时。
 *
 * 定时只存在于用户说清了时刻或周期的时候（含每隔几分钟、每 N 分钟/小时、每天、每周）。
 * 到点只做那一件已经记下的事。这里不配置职责或章程，也不扫描仓库、issue，更不在空闲时找活。
 * 要约束「做不做、做到哪」，用这位热心市民已有的工作原则。
 */
import { createHash } from "node:crypto";
import { beijingDateTime, beijingParts, beijingTimestamp } from "../../shared/time";

/** 「几」没有写明具体数字时，按一个很短的明确周期：3 分钟。这是用户要求的重复，不是找活的轮询。 */
export const FEW_MINUTES = 3;
const MINUTE = 60_000;
const ENDED = new Set(["done", "failed", "stopped", "cancelled", "sealed"]);
const WEEKDAY = "日一二三四五六";
const ASKED = /检查|查看|汇总|提醒|看|跑|执行|同步|汇报|巡检|确认|盯|跟进|整理|统计|通知|复查|核对|更新|收一下|记一下|发一下|发送|发给|拉取|抓取|部署|备份|清理|重启|叫我|告诉我/;

export type WorkKind = "issue" | "ci" | "thread" | "schedule" | "mention" | "assignment" | "message";
export type WorkItem = { kind: WorkKind; id: string };
export type WorkEventKind = "mention" | "assignment" | "message" | "ci" | "comment" | "schedule";
export type Hold = "missing-files" | "merge-conflict" | "outbound" | "scope";
export type Repeat =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; weekday: number; time: string };
export type ExplicitSchedule = {
  dueAt: number;
  repeat?: Repeat;
  /** 用户的原话。 */
  request: string;
  /** 上一拍还在执行时到点了：先记下，等这一步结束再继续同一条，不并行。 */
  queuedFire?: { at: number; eventId: string };
};
export type WakeEvent = {
  id: string;
  kind: WorkEventKind;
  at: number;
  text: string;
  item: string;
  userInitiated?: boolean;
};
export type WorkEvent = {
  id: string;
  at: number;
  kind: WorkEventKind;
  item: WorkItem;
  text: string;
  evidence?: string;
  userInitiated?: boolean;
  /** 点名请这位热心市民做事。 */
  directed?: boolean;
  schedule?: ExplicitSchedule;
  hold?: Hold;
};

export function workKey(item: WorkItem) {
  return `${item.kind}:${item.id}`;
}

export function wakeFrom(event: WorkEvent): WakeEvent {
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    text: [...event.text].slice(0, 200).join(""),
    item: workKey(event.item),
    userInitiated: !!event.userInitiated,
  };
}

export function scheduleIdentity(action: string) {
  const norm = action.toLowerCase().replace(/\s+/g, "").replace(/请|帮我|记得|一下/g, "");
  return createHash("sha256").update(norm || action).digest("hex").slice(0, 16);
}

function beijingWeekday(at: number) {
  return new Date(at + 8 * 60 * 60 * 1000).getUTCDay();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 严格晚于 after 的下一次钟点；weekday 用北京时间的周日=0。 */
export function nextClock(after: number, hour: number, minute: number, weekday?: number) {
  const p = beijingParts(after);
  for (let days = 0; days < 14; days++) {
    const at = beijingTimestamp(p.year, p.month, p.day + days, hour, minute);
    if (at <= after) continue;
    if (weekday === undefined || beijingWeekday(at) === weekday) return at;
  }
  return after + 14 * 24 * 60 * MINUTE;
}

export function nextDue(repeat: Repeat, after: number) {
  if (repeat.kind === "interval") return after + repeat.everyMinutes * MINUTE;
  const [hour, minute] = repeat.time.split(":").map(Number);
  return repeat.kind === "daily" ? nextClock(after, hour, minute) : nextClock(after, hour, minute, repeat.weekday);
}

function clock(part: string | undefined, hourText: string | undefined, minuteText: string | undefined) {
  let hour = hourText === undefined ? undefined : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return;
  if (hour === undefined) {
    if (part === "早上" || part === "上午") hour = 9;
    else if (part === "中午") hour = 12;
    else if (part === "下午") hour = 15;
    else if (part === "晚上") hour = 18;
    else if (part === "凌晨") hour = 0;
    else return;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
  if ((part === "下午" || part === "晚上") && hour < 12) hour += 12;
  if (part === "凌晨" && hour === 12) hour = 0;
  return { hour, minute, time: `${pad(hour)}:${pad(minute)}` };
}

function minutesOf(raw: string | undefined) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10080) return;
  return n;
}

const PART = "(凌晨|早上|上午|中午|下午|晚上)";
const HM = "(\\d{1,2})\\s*(?:[:：点时])\\s*(\\d{1,2})?";

/** 屏蔽括号、引号、反引号内的举例/说明/引用文本，保持字符偏移不变，避免将业务术语误判为定时指令。 */
function maskEmbeddedExamples(text: string) {
  let out = text;
  const patterns = [
    /（[^（）\n]*）/g,
    /\([^()\n]*\)/g,
    /「[^「」\n]*」/g,
    /『[^『』\n]*』/g,
    /“[^“”\n]*”/g,
    /"[^"\n]*"/g,
    /‘[^‘’\n]*’/g,
    /'[^'\n]*'/g,
    /`[^`\n]*`/g,
  ];
  for (let pass = 0; pass < 3; pass++) {
    let next = out;
    for (const re of patterns) next = next.replace(re, (m) => " ".repeat(m.length));
    if (next === out) break;
    out = next;
  }
  return out;
}

const DESCRIPTIVE_BEFORE = /(?:不要|别再|不用|无需|不必|取消|停止|不再|非|不是|如|例如|比如|譬如|类似|像是|包括|包含|所谓|写着|写明|叫做|称为|关于|查清|查询|了解|统计|说明|规则|额度|上限|周期|频率|支持|是否)\s*[：:是为]?\s*$/;
const METRIC_OR_MODIFIER_AFTER = /^\s*(?:的|内|里|中|间|制|档|配额|额度|上限|下限|限制|限额|限流|次数|条|个|元|美元|美金|积分|tokens?|prompts?|requests?|rpm|tpm|qps|失败|报错|异常|超时|过期|刷新|重置|清零|扣费|计费|结算|发放|变化|变动|波动|涨|跌|触发|产生|生成|出现|发布|上线|截止|前|之前|以前|以内)/i;
const STRUCTURED_BRIEF = /(?:^|\s)[1-9][.、）)]\s*[\s\S]*?(?:^|\s)[2-9][.、）)]/;

function clauseBounds(text: string, index: number, length: number) {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (/[。！？；;\n]/.test(text[i])) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = index + length; i < text.length; i++) {
    if (/[。！？；;\n]/.test(text[i])) { end = i; break; }
  }
  return { start, end };
}

function stripped(text: string, phrase: string) {
  return text.replace(phrase, " ").replace(/^(?:请|帮我|记得|麻烦)+/u, "").replace(/\s+/g, " ").trim();
}

function finish(source: string, masked: string, match: RegExpMatchArray, schedule: ExplicitSchedule) {
  const phrase = match[0];
  const index = match.index ?? -1;
  if (index < 0) return;

  const { start, end } = clauseBounds(masked, index, phrase.length);
  const clauseBefore = masked.slice(start, index);
  const clauseAfter = masked.slice(index + phrase.length, end);
  const beforeAll = masked.slice(0, index).trim();
  const clause = masked.slice(start, end);

  if (DESCRIPTIVE_BEFORE.test(clauseBefore)) return;
  if (/不要每|别再每|不用每|取消每|不再每/.test(clause)) return;
  if (METRIC_OR_MODIFIER_AFTER.test(clauseAfter)) return;
  // 「每 N 分钟/小时 X 次」只有在紧接动作动词时才可能是定时（如「每 5 分钟一次检查」），否则多为频率描述（如「每 5 分钟一次失败」/「每 5 小时 100 次」）。
  if (/^\s*次(?:\s*$|\s*[^检查查看汇总提醒看跑执行同步汇报巡检确认盯跟进整理统计通知复查核对更新发拉抓部备清重叫告])/.test(clauseAfter)) return;

  const totalChars = [...source].length;
  const isShortSingleIntent = totalChars <= 120 && !STRUCTURED_BRIEF.test(source);
  // 长文本/多条目需求说明中，只有句首（首句前缀 ≤ 40 字且未进入条目/冒号正文）出现的时间周期才视为定时指令；
  // 防止把多段需求说明书里夹带的“每 5 小时”“周三”“今天下午 3 点”等业务条件误判为定时任务。
  const atRequestHead = start === 0 && [...beforeAll].length <= 40 && !/[：:]/.test(beforeAll) && !/(?:^|\s)[1-9][.、）)]/.test(beforeAll);
  if (!atRequestHead && !isShortSingleIntent) return;

  const action = stripped(source, phrase);
  if (action) {
    const scope = isShortSingleIntent ? masked : clause;
    if (!ASKED.test(scope)) return;
  }
  const text = action || source.trim();
  return {
    action: text,
    schedule: { ...schedule, request: source },
    item: { kind: "schedule" as const, id: scheduleIdentity(text) },
  };
}

/**
 * 从用户原话里认出一次性时刻或重复周期。认不出就返回空，调用方不得因此去轮询。
 * 「每隔几分钟」是用户要的短周期，固定为 {@link FEW_MINUTES} 分钟，不是系统自己找活。
 */
export function parseExplicitSchedule(text: string, now: number) {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source || [...source].length > 8000) return;
  const masked = maskEmbeddedExamples(source);
  if (/不要每|别再每|不用每|取消每/.test(masked)) return;

  const fewMin = masked.match(/每隔\s*几\s*分钟|每\s*几\s*分钟/);
  if (fewMin) return finish(source, masked, fewMin, { dueAt: now + FEW_MINUTES * MINUTE, repeat: { kind: "interval", everyMinutes: FEW_MINUTES }, request: source });
  const fewHour = masked.match(/每隔\s*几\s*小时|每\s*几\s*小时/);
  if (fewHour) return finish(source, masked, fewHour, { dueAt: now + FEW_MINUTES * 60 * MINUTE, repeat: { kind: "interval", everyMinutes: FEW_MINUTES * 60 }, request: source });

  const everyMin = masked.match(/每隔\s*(\d+)\s*分钟|每\s*(\d+)\s*分钟/);
  if (everyMin) {
    const n = minutesOf(everyMin.slice(1).find(Boolean));
    if (!n) return;
    return finish(source, masked, everyMin, { dueAt: now + n * MINUTE, repeat: { kind: "interval", everyMinutes: n }, request: source });
  }
  const everyHour = masked.match(/每隔\s*(\d+)\s*小时|每\s*(\d+)\s*小时/);
  if (everyHour) {
    const n = minutesOf(String(Number(everyHour.slice(1).find(Boolean)) * 60));
    if (!n) return;
    return finish(source, masked, everyHour, { dueAt: now + n * MINUTE, repeat: { kind: "interval", everyMinutes: n }, request: source });
  }
  const afterMin = masked.match(/(\d+)\s*分钟(?:后|之后)/);
  if (afterMin) {
    const n = minutesOf(afterMin[1]);
    if (!n) return;
    return finish(source, masked, afterMin, { dueAt: now + n * MINUTE, request: source });
  }
  const afterHour = masked.match(/(\d+)\s*小时(?:后|之后)/);
  if (afterHour) {
    const n = minutesOf(String(Number(afterHour[1]) * 60));
    if (!n) return;
    return finish(source, masked, afterHour, { dueAt: now + n * MINUTE, request: source });
  }

  const daily = masked.match(new RegExp(`每天(?:\\s*${PART})?\\s*${HM}`));
  if (daily) {
    const at = clock(daily[1], daily[2], daily[3]);
    if (!at) return;
    const repeat: Repeat = { kind: "daily", time: at.time };
    return finish(source, masked, daily, { dueAt: nextDue(repeat, now), repeat, request: source });
  }
  const weekly = masked.match(new RegExp(`每\\s*(?:周|星期)([一二三四五六日天])(?:\\s*${PART})?(?:\\s*${HM})?`));
  if (weekly) {
    const day = WEEKDAY.indexOf(weekly[1] === "天" ? "日" : weekly[1]);
    const at = clock(weekly[2], weekly[3], weekly[4]) || clock("早上", undefined, undefined);
    if (day < 0 || !at) return;
    const repeat: Repeat = { kind: "weekly", weekday: day, time: at.time };
    return finish(source, masked, weekly, { dueAt: nextDue(repeat, now), repeat, request: source });
  }
  const relative = masked.match(new RegExp(`(今天|明天|后天)(?:\\s*${PART})?(?:\\s*${HM})?`));
  if (relative) {
    const at = clock(relative[2], relative[3], relative[4]);
    if (!at) return;
    const shift = relative[1] === "今天" ? 0 : relative[1] === "明天" ? 1 : 2;
    const p = beijingParts(now);
    const dueAt = beijingTimestamp(p.year, p.month, p.day + shift, at.hour, at.minute);
    if (dueAt <= now) return;
    return finish(source, masked, relative, { dueAt, request: source });
  }
  const weekday = masked.match(new RegExp(`(?:周|星期)([一二三四五六日天])(?:\\s*${PART})?(?:\\s*${HM})?`));
  if (weekday) {
    const day = WEEKDAY.indexOf(weekday[1] === "天" ? "日" : weekday[1]);
    const at = clock(weekday[2], weekday[3], weekday[4]) || clock("早上", undefined, undefined);
    if (day < 0 || !at) return;
    return finish(source, masked, weekday, { dueAt: nextClock(now, at.hour, at.minute, day), request: source });
  }
  const absolute = masked.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (absolute) {
    const dueAt = beijingTimestamp(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), Number(absolute[4]), Number(absolute[5]));
    if (!Number.isFinite(dueAt) || beijingDateTime(dueAt) !== absolute[0] || dueAt <= now) return;
    return finish(source, masked, absolute, { dueAt, request: source });
  }
  return;
}

export function explicitScheduleEvent(text: string, now: number): WorkEvent | undefined {
  const parsed = parseExplicitSchedule(text, now);
  if (!parsed) return;
  return {
    id: `schedule:${parsed.item.id}:${parsed.schedule.dueAt}`,
    at: now,
    kind: "schedule",
    item: parsed.item,
    text: parsed.action,
    userInitiated: true,
    directed: true,
    schedule: parsed.schedule,
  };
}

export type IntakeView = {
  id: string;
  key?: string;
  status: string;
  busy?: boolean;
  seenEvidence?: string[];
  seenEvents?: string[];
};

export type IntakePlan =
  | { action: "ignore"; reason: string }
  | { action: "leave"; taskId: string; reason: string }
  | { action: "attach"; taskId: string; reason: string }
  | { action: "queue-fire"; taskId: string; reason: string }
  | { action: "resume"; taskId: string; status: "queued" | "deferred" | "waiting"; nextCheckAt: number; reason: string }
  | { action: "start"; status: "queued" | "deferred" | "waiting"; nextCheckAt: number; reason: string };

const evidenceOf = (event: WorkEvent) => (event.evidence || "").trim();

function isNewEvidence(task: IntakeView, event: WorkEvent) {
  const evidence = evidenceOf(event);
  return !!evidence && !(task.seenEvidence || []).includes(evidence);
}

function userAskedAgain(event: WorkEvent) {
  return !!event.userInitiated && !!event.directed && event.kind !== "schedule" && event.kind !== "ci" && event.kind !== "comment";
}

function future(event: WorkEvent, now: number) {
  return !!event.schedule && event.schedule.dueAt > now;
}

function holdReason(hold: Hold) {
  if (hold === "missing-files") return "缺少必要文件，先问用户，不凭空补写";
  if (hold === "merge-conflict") return "有合并冲突，先问用户，不自动选一边";
  if (hold === "outbound") return "下一步会对外发送或提交，先问用户";
  return "授权范围会扩大，先问用户";
}

/** 纯决策：同一身份只对应一条任务。运行中的只挂上，不新开、不打断。 */
export function planIntake(tasks: IntakeView[], event: WorkEvent, now: number): IntakePlan {
  if (tasks.some((task) => (task.seenEvents || []).includes(event.id)))
    return { action: "ignore", reason: "这条事件已经处理过" };
  const same = tasks.filter((task) => task.key === workKey(event.item));
  const task = same.find((item) => !ENDED.has(item.status)) || same.at(-1);
  if (!task) {
    if (event.hold) return { action: "start", status: "waiting", nextCheckAt: 0, reason: holdReason(event.hold) };
    if (!(event.schedule || event.directed || event.userInitiated))
      return { action: "ignore", reason: "没有对应的在办事项，不凭空开工" };
    // 重复周期即使已经到点，也先记成延后，由现有调度器在有空位时再启动。这样用户当场的任务可以排在前面。
    if (event.schedule?.repeat || future(event, now))
      return { action: "start", status: "deferred", nextCheckAt: event.schedule!.dueAt, reason: future(event, now) ? "已记下用户要求的定时" : "已记下用户要求的周期，到点再做" };
    return { action: "start", status: "queued", nextCheckAt: 0, reason: "用户明确要求现在做" };
  }
  if (event.hold && !task.busy && task.status !== "running")
    return { action: "resume", taskId: task.id, status: "waiting", nextCheckAt: 0, reason: holdReason(event.hold) };
  if (task.busy || task.status === "running") {
    if (event.kind === "schedule" || event.schedule)
      return { action: "queue-fire", taskId: task.id, reason: "上一拍还在执行，这一拍不另开、不打断" };
    return { action: "attach", taskId: task.id, reason: "挂到正在执行的同一条任务，等这一步结束再吸收" };
  }
  if (task.status === "sealed" || task.status === "stopped" || task.status === "cancelled" || task.status === "approval")
    return { action: "leave", taskId: task.id, reason: "用户已停止、已封存或仍在等审批，不自动重启" };
  const due = event.kind === "schedule" || !!event.schedule;
  const fresh = isNewEvidence(task, event) || userAskedAgain(event);
  if (task.status === "done" && !due && !fresh)
    return { action: "leave", taskId: task.id, reason: "已经做完，没有新的证据" };
  if (task.status === "waiting" && !fresh && !due)
    return { action: "leave", taskId: task.id, reason: "还在等用户，没有新的结果" };
  if (future(event, now))
    return { action: "resume", taskId: task.id, status: "deferred", nextCheckAt: event.schedule!.dueAt, reason: "同一条定时尚未到点" };
  return {
    action: "resume",
    taskId: task.id,
    status: "queued",
    nextCheckAt: 0,
    reason: task.status === "failed" || task.status === "recovering" ? "失败或暂停的同一条任务继续做" : due ? "定时到点，继续同一条" : "有新证据，继续同一条任务",
  };
}

export function scheduleDigest(tasks: { id: string; status: string; text?: string; schedule?: ExplicitSchedule }[]) {
  const open = tasks.filter((task) => task.schedule && !ENDED.has(task.status));
  if (!open.length) return "";
  const rows = open.map((task) => ({
    id: task.id,
    text: task.text,
    dueAt: task.schedule!.dueAt,
    repeat: task.schedule!.repeat || null,
  }));
  return `\n[用户点名的定时] ${JSON.stringify(rows)}\n到点只续做上面同一条任务，做用户点名的那一件。不要新建职责或章程，不要另开相同任务，也不要用定时去扫描仓库、issue 或空闲时找活。\n`;
}
