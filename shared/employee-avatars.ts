export const ZODIAC_AVATARS = [
  { id: "aries", name: "白羊座" }, { id: "taurus", name: "金牛座" },
  { id: "gemini", name: "双子座" }, { id: "cancer", name: "巨蟹座" },
  { id: "leo", name: "狮子座" }, { id: "virgo", name: "处女座" },
  { id: "libra", name: "天秤座" }, { id: "scorpio", name: "天蝎座" },
  { id: "sagittarius", name: "射手座" }, { id: "capricorn", name: "摩羯座" },
  { id: "aquarius", name: "水瓶座" }, { id: "pisces", name: "双鱼座" },
] as const;

export function isAvatarPreset(value: unknown): value is string {
  return typeof value === "string" && (value === "" || ZODIAC_AVATARS.some(avatar => value === "zodiac:" + avatar.id));
}

export function employeeAvatarURL(employeeId?: string, avatar?: string) {
  if (!avatar) return "";
  if (isAvatarPreset(avatar)) return "/avatars/zodiac/" + avatar.slice(7) + ".webp";
  if (employeeId && /^blob-[a-f\d]{32}$/.test(avatar)) return `/api/employees/${encodeURIComponent(employeeId)}/avatar?v=${avatar}`;
  return "";
}
