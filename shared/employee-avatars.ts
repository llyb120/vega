/** Legacy zodiac presets: no longer offered in the picker, but stored values keep rendering. */
export const ZODIAC_AVATARS = [
  { id: "aries", name: "白羊座" }, { id: "taurus", name: "金牛座" },
  { id: "gemini", name: "双子座" }, { id: "cancer", name: "巨蟹座" },
  { id: "leo", name: "狮子座" }, { id: "virgo", name: "处女座" },
  { id: "libra", name: "天秤座" }, { id: "scorpio", name: "天蝎座" },
  { id: "sagittarius", name: "射手座" }, { id: "capricorn", name: "摩羯座" },
  { id: "aquarius", name: "水瓶座" }, { id: "pisces", name: "双鱼座" },
] as const;

/** Bot avatar silhouettes. Geometry lives in web/src/bot-avatar.js; only ids are shared with the server. */
export const BOT_AVATAR_SHAPES = [
  { id: "round", name: "圆团" }, { id: "cloud", name: "云朵" }, { id: "tile", name: "方块" },
  { id: "sparkle", name: "星芒" }, { id: "clover", name: "四叶" }, { id: "chonk", name: "胖墩" },
  { id: "flower", name: "花朵" }, { id: "drop", name: "水滴" }, { id: "bean", name: "豆子" },
  { id: "triangle", name: "三角" }, { id: "gem", name: "宝石" }, { id: "cog", name: "齿轮" },
  { id: "hexagon", name: "六边" }, { id: "apple", name: "苹果" }, { id: "star", name: "星星" },
  { id: "heart", name: "爱心" }, { id: "blob", name: "软糖" }, { id: "ghost", name: "幽灵" },
] as const;

export const BOT_AVATAR_COLORS = [
  { id: "black", name: "黑色", hex: "#1d1d21" }, { id: "brown", name: "棕色", hex: "#94603d" },
  { id: "red", name: "红色", hex: "#f2374a" }, { id: "orange", name: "橙色", hex: "#ff6b25" },
  { id: "amber", name: "琥珀", hex: "#ffa424" }, { id: "green", name: "绿色", hex: "#1cc46f" },
  { id: "teal", name: "青色", hex: "#0fb4a3" }, { id: "blue", name: "蓝色", hex: "#3878fb" },
  { id: "purple", name: "紫色", hex: "#9b4ff0" }, { id: "pink", name: "粉色", hex: "#f2389d" },
  { id: "gray", name: "灰色", hex: "#7c7c84" }, { id: "sky", name: "天蓝", hex: "#30b4f0" },
] as const;

export type BotAvatar = { shape: string; color: string; hex: string };

/** `bot:<shape>:<color>` → parts, or undefined for anything else. */
export function parseBotAvatar(value: unknown): BotAvatar | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^bot:([a-z]+):([a-z]+)$/.exec(value);
  if (!match || !BOT_AVATAR_SHAPES.some(shape => shape.id === match[1])) return undefined;
  const color = BOT_AVATAR_COLORS.find(color => color.id === match[2]);
  return color && { shape: match[1], color: color.id, hex: color.hex };
}

export function botAvatarPreset(shape: string, color: string) {
  return `bot:${shape}:${color}`;
}

/** Stable bot used when an employee has no avatar, so every employee gets a face (and typing animation). */
export function defaultBotAvatar(seed = ""): BotAvatar {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const shape = BOT_AVATAR_SHAPES[hash % BOT_AVATAR_SHAPES.length].id;
  const color = BOT_AVATAR_COLORS[(hash >>> 8) % BOT_AVATAR_COLORS.length];
  return { shape, color: color.id, hex: color.hex };
}

export function isAvatarPreset(value: unknown): value is string {
  return typeof value === "string" && (value === "" || ZODIAC_AVATARS.some(avatar => value === "zodiac:" + avatar.id) || !!parseBotAvatar(value));
}

/** Image URL for raster avatars; empty for the default and bot avatars, which render as inline SVG. */
export function employeeAvatarURL(employeeId?: string, avatar?: string) {
  if (!avatar) return "";
  if (avatar.startsWith("zodiac:") && isAvatarPreset(avatar)) return "/avatars/zodiac/" + avatar.slice(7) + ".webp";
  if (employeeId && /^blob-[a-f\d]{32}$/.test(avatar)) return `/api/employees/${encodeURIComponent(employeeId)}/avatar?v=${avatar}`;
  return "";
}

/** A user's uploaded avatar (blob id from /bootstrap or a group view); "" shows the initial instead. */
export function userAvatarURL(userId?: string, avatar?: string) {
  return userId && avatar && /^blob-[a-f\d]{32}$/.test(avatar) ? `/api/avatars/users/${encodeURIComponent(userId)}?v=${avatar}` : "";
}
