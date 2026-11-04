import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { longPress, withMention } from "../web/src/long-press.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const touch = (x = 0, y = 0) => ({ touches: [{ clientX: x, clientY: y }] });
const mouse = (button = 0) => ({ clientX: 0, clientY: 0, button });

test("long-press: a held touch fires once (timer or Android's contextmenu, whichever first) and swallows the tap that follows", async () => {
  const fired: number[] = [];
  const press = longPress(() => fired.push(1), 20);
  press.down(touch()); await sleep(40);
  press.menu();
  assert.equal(fired.length, 1, "contextmenu after the timer does not fire again");
  let prevented = false;
  press.end({ cancelable: true, preventDefault() { prevented = true; } });
  assert(prevented, "touchend after a long-press cancels the synthesized click");
  press.down(mouse()); await sleep(40);
  assert.equal(fired.length, 1, "the mouse events a browser synthesizes after a touch are ignored");
  assert.equal(press.consumed(), true);
  // contextmenu alone (some Android browsers) is the long-press too.
  press.down(touch()); press.menu(); assert.equal(fired.length, 2);
});

test("long-press: a tap, a scroll or a right button does not fire; a mouse hold does", async () => {
  const fired: number[] = [];
  const press = longPress(() => fired.push(1), 20);
  press.down(touch()); press.end({ cancelable: true, preventDefault() { throw Error("a tap keeps its click"); } }); await sleep(40);
  press.down(touch()); press.move(touch(0, 30)); await sleep(40);
  assert.equal(fired.length, 0);
  assert.equal(press.consumed(), false, "a tap still opens the chat");
  await sleep(1000);
  press.down(mouse(2)); await sleep(40);
  assert.equal(fired.length, 0);
  press.down(mouse()); await sleep(40);
  assert.equal(fired.length, 1);
});

test("long-press inserts the composer's @mention at the caret or the end; avatars in messages, typing row and member list", () => {
  assert.deepEqual(withMention("", "小A"), { text: "@小A ", caret: 4 });
  assert.deepEqual(withMention("你好", "小A"), { text: "你好 @小A ", caret: 7 });
  assert.deepEqual(withMention("请  看下", "小A", 2), { text: "请 @小A  看下", caret: 6 });
  const group = readFileSync("web/src/GroupChat.vue", "utf8"), message = readFileSync("web/src/ChatMessage.vue", "utf8"), wrap = readFileSync("web/src/PressMention.vue", "utf8");
  assert(group.includes('@mention="mentionMember"') && group.includes("input.value?.mention(name)"));
  assert.equal((group.match(/<PressMention :name="e\.name"/g) || []).length, 2, "typing row and member list avatars");
  assert.equal((message.match(/<PressMention /g) || []).length, 2, "both kinds of message avatar");
  assert(wrap.includes("@touchstart.passive") && wrap.includes('@touchend="press.end"') && wrap.includes('@contextmenu="menu"') && !wrap.includes("@pointer"), "touch events and contextmenu, no pointer events");
  assert(wrap.includes("event.stopPropagation()") && wrap.includes("-webkit-touch-callout: none") && wrap.includes("pointer-events: none"));
  assert(readFileSync("web/src/MentionTextarea.vue", "utf8").includes("mention: mentionMember"));
});
