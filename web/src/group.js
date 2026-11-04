// Group chat helpers (pure; tested in tests/group-ui.test.ts).

/**
 * The tiles of a group's composite avatar, WeChat style: up to 9 members, the 群主 first, then the other users, then
 * the employees; 1 tile fills the square, 2–4 use a 2×2 grid, 5–9 a 3×3 grid.
 */
export function groupTiles(group, max = 9) {
  const users = [...(group?.users || [])].sort((a, b) => (b.id === group?.creatorId) - (a.id === group?.creatorId));
  const tiles = [...users.map((u) => ({ kind: "user", ...u })), ...(group?.employees || []).map((e) => ({ kind: "employee", ...e }))].slice(0, max);
  return { tiles, cols: tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : 3 };
}

/** Everyone the writer can @ in a group, with a hint for the picker (the writer excluded). */
export function groupMembers(group, viewerId) {
  if (!group) return [];
  return [
    ...(group.employees || []).map((e) => ({ id: e.id, name: e.name, kind: "employee", hint: e.mine ? "我的牛马" : `${e.ownerName || "其他用户"}的牛马` })),
    ...(group.users || []).filter((u) => u.id !== viewerId).map((u) => ({ id: u.id, name: u.name, kind: "user", hint: u.id === group.creatorId ? "群主 · 用户" : "用户" })),
  ];
}

/** Mention rendering for a group: the reader's own employees link to their chat, everyone else is highlighted only. */
export function groupMentionPeople(group) {
  if (!group) return [];
  return [...(group.employees || []).map((e) => ({ id: e.id, name: e.name, link: !!e.mine })), ...(group.users || []).map((u) => ({ id: u.id, name: u.name, link: false }))];
}
