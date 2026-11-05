import type { Employee } from "./employee";
import { assert } from "./util";

/** Names compare case- and width-insensitively ("ABC" = "abc" = "ＡＢＣ"). */
export const nameKey = (name: string) => name.trim().normalize("NFKC").toLowerCase();

/**
 * An employee name must be unique among its owner's employees, so the owner (and `@名称` in a group, where only
 * names show) can always tell them apart. Group chats additionally check names against every member (groups.ts).
 * Call inside the write transaction.
 */
export async function assertNameFree(root: Employee, name: string, who: { id: string; ownerId: string }) {
  const key = nameKey(name);
  for (const other of await root.all()) {
    if (other.employeeId === who.id) continue;
    const p = await other.profile();
    assert(!(nameKey(p.name) === key && p.ownerId === who.ownerId), `牛马名称「${name.trim()}」已被你的另一个牛马（${p.id}）使用，请换一个名称`);
  }
}

export type Mention = { index: number; length: number; id: string; name: string };
/**
 * `@名称` in a message: the longest known name right after "@" (names may contain spaces, Chinese text has no word
 * breaks). An "@" right after a letter or digit (an email address) is not a mention.
 */
export function parseMentions<T extends { id: string; name: string }>(text: string, people: T[]) {
  const byLength = [...people].filter((p) => nameKey(p.name)).sort((a, b) => b.name.length - a.name.length);
  const found: (Mention & { person: T })[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    if (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1])) continue;
    const key = text.slice(i + 1).normalize("NFKC").toLowerCase();
    const hit = byLength.find((p) => key.startsWith(nameKey(p.name)));
    if (hit) found.push({ index: i, length: 1 + hit.name.trim().length, id: hit.id, name: hit.name, person: hit });
  }
  return found;
}
