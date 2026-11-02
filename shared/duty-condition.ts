import { beijingDateTime } from "./time";

type Duty = { condition?: string; text?: string; note?: string; manual?: boolean; times?: string[]; everyMinutes?: number; nextCheckAt?: number; events?: string[] };
export function dutyCondition(duty: Duty) {
  if (duty.condition) return duty.condition;
  if (duty.manual) return "按交代的任务需要，不自动触发";
  if (duty.times?.length) return "每天 " + duty.times.join("、") + "（北京时间）";
  if (duty.everyMinutes) return `每隔 ${duty.everyMinutes} 分钟`;
  if (duty.nextCheckAt) return beijingDateTime(duty.nextCheckAt) + "（北京时间）触发";
  if (duty.events?.length) return "旧事件条件：" + duty.events.join("、");
  return "按交代的任务需要，不自动触发";
}
export function dutyContent(duty: Duty) {
  return [duty.text, duty.note && "补充要求：\n" + duty.note].filter(Boolean).join("\n\n");
}
