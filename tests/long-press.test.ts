import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { longPress, withMention } from "../web/src/long-press.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (x = 0, y = 0, button = 0) => ({ clientX: x, clientY: y, button });

test("long-press fires after the delay and swallows the click that follows; a tap, a drag or a right button do not", async () => {
  const fired: string[] = [];
  const press = longPress((name: string) => fired.push(name), 20);
  press.down(at(), "小A"); await sleep(40);
  assert.deepEqual(fired, ["小A"]);
  assert.equal(press.consumed(), true, "the click after a long-press is not a tap");
  assert.equal(press.consumed(), false);
  press.down(at(), "小B"); press.cancel(); await sleep(40);
  press.down(at(), "小B"); press.move(at(30, 0)); await sleep(40);
  press.down(at(0, 0, 2), "小B"); await sleep(40);
  assert.deepEqual(fired, ["小A"]);
  assert.equal(press.consumed(), false, "a tap still opens the chat");
});

test("long-press inserts the composer's @mention at the caret or the end", () => {
  assert.deepEqual(withMention("", "小A"), { text: "@小A ", caret: 4 });
  assert.deepEqual(withMention("你好", "小A"), { text: "你好 @小A ", caret: 7 });
  assert.deepEqual(withMention("请  看下", "小A", 2), { text: "请 @小A  看下", caret: 6 });
  const group = readFileSync("web/src/GroupChat.vue", "utf8"), message = readFileSync("web/src/ChatMessage.vue", "utf8");
  assert(group.includes('@mention="mentionMember"') && group.includes("input.value?.mention(name)"), "message avatars @ into the composer");
  assert((group.match(/press\.down\(\$event, e\.name\)/g) || []).length === 2, "typing row and member list avatars too");
  assert(message.includes("press.consumed() || emit('author'") && message.includes("$event.preventDefault()"), "no tap and no context menu after a long-press");
  assert(readFileSync("web/src/MentionTextarea.vue", "utf8").includes("mention: mentionMember"));
});
