import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { chatHistory } from "../server/core/chat-page";

const stores: Store[] = [];
after(async () => { for (const store of stores) await store.close(); });
async function fixture(count: number) {
  const store = await Store.open(":memory:");
  stores.push(store);
  const session = await store.newSession({ cwd: "/tmp" });
  for (let i = 1; i <= count; i++) await store.append(session.id, { role: i % 2 ? "user" : "assistant", text: "m" + i } as any);
  return { store, id: session.id };
}
test("incremental chat sync exposes the server tail so stale caches can detect deleted history", async () => {
  const { store, id } = await fixture(5);
  assert.equal((await chatHistory(store, id, q({ after: "5" })) as any).lastSeq, 5);
  await store.run("DELETE FROM messages WHERE session=? AND seq>?", id, 2);
  const rolledBack = await chatHistory(store, id, q({ after: "5" })) as any;
  assert.equal(rolledBack.lastSeq, 2);
  assert.deepEqual(rolledBack.messages, []);
});

const q = (params: Record<string, string> = {}) => new URLSearchParams(params);

test("chat history without paging parameters returns the full history unchanged", async () => {
  const { store, id } = await fixture(250);
  const result = await chatHistory(store, id, q());
  assert.equal(result.messages.length, 250);
  assert.equal((result as any).hasMore, undefined);
  assert.deepEqual(result.messages, await store.messages(id));
});

test("chat history pages backwards from the newest messages without gaps or overlap", async () => {
  const { store, id } = await fixture(1000);
  const first = await chatHistory(store, id, q({ limit: "60" })) as any;
  assert.deepEqual(first.messages.map((m: any) => m.seq), Array.from({ length: 60 }, (_, i) => 941 + i));
  assert.equal(first.hasMore, true);
  const seen = [...first.messages];
  let page = first;
  while (page.hasMore) {
    page = await chatHistory(store, id, q({ before: String(page.messages[0].seq), limit: "60" }));
    assert(page.messages.length > 0 && page.messages.length <= 60);
    seen.unshift(...page.messages);
  }
  assert.deepEqual(seen.map((m: any) => m.seq), Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.equal(seen[0].text, "m1");
  assert.deepEqual(await chatHistory(store, id, q({ before: "1", limit: "10" })), { messages: [], hasMore: false });
});

test("chat history appends only messages newer than a known sequence", async () => {
  const { store, id } = await fixture(30);
  const newer = await chatHistory(store, id, q({ after: "27" })) as any;
  assert.deepEqual(newer.messages.map((m: any) => m.seq), [28, 29, 30]);
  assert.equal(newer.hasMore, true);
  assert.deepEqual((await chatHistory(store, id, q({ after: "30" })) as any).messages, []);
  assert.equal((await chatHistory(store, id, q({ after: "0" })) as any).messages.length, 30);
});

test("chat history rejects malformed paging parameters", async () => {
  const { store, id } = await fixture(5);
  for (const params of <Record<string, string>[]>[{ limit: "0" }, { limit: "501" }, { limit: "abc" }, { before: "-1" }, { before: "1.5" }, { after: "2", limit: "3" }, { after: "2", before: "4" }])
    await assert.rejects(async () => await chatHistory(store, id, q(params)), (error: any) => error.statusCode === 400, JSON.stringify(params));
});
