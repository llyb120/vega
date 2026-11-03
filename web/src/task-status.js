// 任务状态的统一文案与色调，供任务列表、详情、工作面板共用。
export const TASK_LABELS = {
  queued: "排队中",
  running: "执行中",
  recovering: "自动恢复中",
  deferred: "等待外部结果",
  waiting: "待补充信息",
  approval: "待你确认",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
  cancelled: "已取消",
  sealed: "已封存",
  pending: "待执行",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "受阻",
};
const TONES = {
  running: "info", recovering: "info", in_progress: "info",
  waiting: "warn", approval: "warn", blocked: "warn",
  done: "ok", completed: "ok",
  failed: "danger",
};
export const taskTone = (status) => TONES[status] || "neutral";
export const taskLabel = (status) => TASK_LABELS[status] || status || "";
/** Actively being worked on right now: the statuses the shared mapping shows in the "info" tone. */
export const isInProgress = (status) => taskTone(status) === "info";
export const isEnded = (status) => ["done", "failed", "cancelled", "stopped", "sealed"].includes(status);
export const needsAttention = (status) => ["waiting", "approval"].includes(status);
export function planProgress(plan) {
  if (!plan?.length) return null;
  const done = plan.filter((step) => step.status === "completed").length;
  return { done, total: plan.length, percent: Math.round((done / plan.length) * 100) };
}
const pad = (n) => String(n).padStart(2, "0");
/** 紧凑的北京时间：今天只显示时刻，今年显示月日，否则显示完整日期。 */
export function shortTime(at, now = Date.now()) {
  if (!at) return "";
  const offset = 8 * 3600000, d = new Date(at + offset), n = new Date(now + offset);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate()) return hm;
  if (d.getUTCFullYear() === n.getUTCFullYear()) return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hm}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
