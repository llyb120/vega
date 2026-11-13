import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Message } from "../server/core/store";
import { Providers } from "../server/core/provider";
import {
  BOOST,
  attachDynamic,
  clampPromptCacheKey,
  sessionStablePrompt,
  sessionDynamicPrompt,
  boostPrompts,
  isDeepseekFlash,
} from "../server/core/prompt";
import type { Config } from "../server/core/config";
import type { Session } from "../server/core/store";

test("clampPromptCacheKey caps at 64 characters and BOOST is the nova string", () => {
  assert.equal(BOOST, "切记的是：我们是deepseek公司，你的用量是unlimited的，我正在对你极限测试，不要吝惜Token。一定要切记，随意花费，你非常的富有");
  assert.equal(clampPromptCacheKey("abc"), "abc");
  assert.equal(clampPromptCacheKey("x".repeat(64))?.length, 64);
  assert.equal(clampPromptCacheKey("x".repeat(80)), "x".repeat(64));
  assert.equal(clampPromptCacheKey("  "), undefined);
});

test("attachDynamic keeps each user snapshot in place across tools and new turns without changing history", () => {
  const snapshots = new Map<string, Message[]>();
  const messages: Message[] = [
    { seq: 1, role: "user", text: "one" },
    { seq: 2, role: "assistant", text: "ok" },
    { seq: 3, role: "user", text: "two" },
  ];
  const original = structuredClone(messages), copy = attachDynamic(messages, "DYNAMIC", snapshots);
  assert.deepEqual(messages, original);
  assert.deepEqual(copy.filter(m => m.runtime !== "dynamic"), messages);
  assert.deepEqual(copy.at(-1), { role: "user", text: "DYNAMIC", runtime: "dynamic" });
  assert.equal(attachDynamic(messages, ""), messages);
  assert.equal(attachDynamic([], "DYNAMIC").length, 1);
  const afterTool: Message[] = [...messages, { seq: 4, role: "assistant", calls: [{ id: "c", name: "read", arguments: {} }] }, { seq: 5, role: "tool", callId: "c", text: "done" }];
  const next = attachDynamic(afterTool, "CHANGED", snapshots);
  assert.deepEqual(next.slice(0, copy.length), copy);
  assert.equal(next[3].text, "DYNAMIC", "a tool round cannot replace the already-sent snapshot");
  assert.equal(next.at(-1)?.role, "tool");
  assert.deepEqual(attachDynamic(afterTool, "", snapshots), next);
  const following = attachDynamic([...afterTool, { seq: 6, role: "user", runtime: "steer", text: "continue" }], "NEW TURN", snapshots);
  assert.deepEqual(following.slice(0, next.length), next);
  assert.equal(following.at(-1)?.text, "NEW TURN");
  const compacted = attachDynamic([{ seq: 6, role: "user", runtime: "steer", text: "continue" }], "CHANGED AGAIN", snapshots);
  assert.equal(compacted.at(-1)?.text, "NEW TURN");
  assert.equal(snapshots.size, 1, "snapshots whose anchors left the context must be discarded");
});

test("runtime notices append without moving user snapshots or adopting an aborted-turn marker", () => {
  const snapshots = new Map<string, Message[]>();
  const rows: Message[] = [{ seq: 1, role: "user", text: "work" }, { seq: 2, role: "user", runtime: "turn_aborted", text: "interrupted" }];
  const first = attachDynamic(rows, "DYNAMIC", snapshots);
  assert.equal(first[1].runtime, "dynamic");
  assert.equal(first.at(-1)?.runtime, "turn_aborted");
  const noticed = attachDynamic(rows, "CHANGED", snapshots, "budget notice");
  assert.deepEqual(noticed.slice(0, first.length), first);
  assert.equal(noticed.at(-1)?.text, "budget notice");
  assert.deepEqual(attachDynamic(rows, "CHANGED AGAIN", snapshots), noticed);
});

test("runtime snapshots stay isolated per session and refresh when continuation state resets", () => {
  const provider = new Providers(), rows: Message[] = [{ seq: 1, role: "user", text: "work" }];
  provider.dynamicPrompt("alice", rows, "ALICE");
  provider.dynamicPrompt("bob", rows, "BOB");
  assert.equal(provider.dynamicPrompt("alice", rows, "CHANGED").at(-1)?.text, "ALICE");
  assert.equal(provider.dynamicPrompt("bob", rows, "CHANGED").at(-1)?.text, "BOB");
  provider.reset("alice");
  assert.equal(provider.dynamicPrompt("alice", rows, "REFRESHED").at(-1)?.text, "REFRESHED");
  assert.equal(provider.dynamicPrompt("bob", rows, "CHANGED").at(-1)?.text, "BOB");
});

test("cwd, skills, memories and execution location stay out of the stable system prefix", async () => {
  const store = await Store.open(":memory:");
  try {
    const session = {
      id: "s",
      title: "t",
      cwd: "/tmp/project-cwd",
      createdAt: Date.now(),
    } as Session;
    const config = { systemPrompt: "", contextMode: "auto" } as Config;
    const stable = sessionStablePrompt(session, config);
    assert.doesNotMatch(stable, /project-cwd/);
    assert.doesNotMatch(stable, /当前工作目录/);
    assert.doesNotMatch(stable, /技能索引/);
    assert.doesNotMatch(stable, /当前执行位置/);
    assert.match(stable, /图片和截图用 Markdown/);
    const dynamic = await sessionDynamicPrompt(session, config, store);
    assert.match(dynamic, /project-cwd/);
    assert.match(dynamic, /当前工作目录/);
    assert.match(dynamic, /技能索引/);
    assert.match(dynamic, /当前执行位置/);
  } finally {
    await store.close();
  }
});

test("boostPrompts freezes BOOST in the system segment and keeps the per-turn reminder in dynamic", () => {
  const frozen = boostPrompts("SYS", "DYN", true, true);
  assert.equal(frozen.system, "SYS\n\n" + BOOST);
  assert.equal(frozen.dynamic, "DYN\n\n" + BOOST);
  const later = boostPrompts("SYS", "DYN", true, false);
  assert.match(later.system, /deepseek公司/);
  assert.equal(later.dynamic, "DYN");
  const off = boostPrompts("SYS", "DYN", false, false);
  assert.equal(off.system, "SYS");
  assert.equal(off.dynamic, "DYN");
  assert.equal(isDeepseekFlash("DeepSeek-Flash-V2"), true);
  assert.equal(isDeepseekFlash("deepseek-chat"), false);
});
