import { createChatCache, clearChatCache, pruneChatCache } from "../web/src/chat-cache.js";

// Run in a browser on a local test origin; no real accounts, messages or network requests are used.
export async function runChatCacheChecks() {
  const suffix = [...crypto.getRandomValues(new Uint8Array(8))].join("-");
  const user = "cache-check-" + suffix, other = user + "-other";
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const rows = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, role: "user", text: "message-" + (i + 1) }));
  let checks = 0;
  try {
    const a = createChatCache(user, "a"), b = createChatCache(user, "b"), foreign = createChatCache(other, "a");
    await a.put("chat-a", rows, true);
    await b.put("chat-b", [rows[0]], true);
    await foreign.put("private-chat", [{ ...rows[0], text: "other account" }], true);
    const latest = await a.read(undefined, 60);
    check(latest?.session === "chat-a" && latest.messages[0].seq === 41 && latest.messages.length === 60, "latest page round trip"); checks++;
    const older = await a.read(41, 60);
    check(older?.messages.length === 40 && older.messages[0].seq === 1, "older cached page"); checks++;
    await a.put("chat-a", [{ ...rows[99], text: "updated" }, { seq: 101, role: "assistant", text: "new" }]);
    const delta = await a.read();
    check(delta.messages.at(-2).text === "updated" && delta.messages.at(-1).seq === 101, "incremental upsert without duplicates"); checks++;
    check((await foreign.read()).messages[0].text === "other account" && (await b.read()).messages.length === 1, "account and bot isolation"); checks++;
    await a.put("rebuilt-chat", [{ seq: 1, role: "user", text: "rebuilt" }], true);
    check((await a.read()).messages.length === 1 && (await a.read()).session === "rebuilt-chat", "replacement discards old messages"); checks++;
    await a.put("rebuilt-chat", [{ seq: 2, role: "user", text: () => "cannot clone" }]);
    check((await a.read()).messages.length === 1, "storage errors are harmless and transactions roll back"); checks++;
    const late = a.put("rebuilt-chat", [{ seq: 3, role: "user", text: "late" }]);
    const clear = clearChatCache(user, "a");
    await Promise.all([late, clear]);
    await a.put("rebuilt-chat", rows);
    check(!a.valid() && !(await createChatCache(user, "a").read()), "late writes cannot resurrect deleted bots"); checks++;
    const fresh = createChatCache(user, "a");
    await fresh.put("fresh", [rows[0]]);
    await pruneChatCache(user, ["a"]);
    check(!b.valid() && !(await createChatCache(user, "b").read()) && !!(await fresh.read()), "authoritative list prunes only deleted bots"); checks++;
    check(!!(await foreign.read()), "pruning leaves other accounts untouched"); checks++;
    await clearChatCache(user);
    await fresh.put("fresh", rows);
    check(!fresh.valid() && !(await createChatCache(user, "a").read()) && !!(await foreign.read()), "logout clears account cache and blocks late writers"); checks++;
    return { ok: true, checks };
  } finally {
    await clearChatCache(user);
    await clearChatCache(other);
  }
}
