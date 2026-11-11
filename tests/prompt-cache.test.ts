import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Message } from "../server/core/store";
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

test("attachDynamic appends to the last user message and does not mutate the canonical history", () => {
  const messages: Message[] = [
    { role: "user", text: "one" },
    { role: "assistant", text: "ok" },
    { role: "user", text: "two" },
  ];
  const copy = attachDynamic(messages, "DYNAMIC");
  assert.equal(messages[2].text, "two");
  assert.equal(copy[2].text, "two\n\nDYNAMIC");
  assert.equal(copy[0].text, "one");
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
