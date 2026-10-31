const OFFSET = 8 * 60 * 60 * 1000;
export function beijingParts(at: number) {
  const d = new Date(at + OFFSET);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}
export function beijingDateTime(at: number) {
  const p = beijingParts(at);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
export function beijingTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  return Date.UTC(year, month, day, hour, minute) - OFFSET;
}
export function formatBeijing(at: number) {
  return at
    ? new Date(at).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "";
}
