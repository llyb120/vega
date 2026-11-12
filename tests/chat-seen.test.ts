import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { conversationTurns } from "../web/src/conversation.js";

function localStore() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
}

test("「新」分界记住每个会话在本机看到的位置", async () => {
  (globalThis as any).localStorage = localStore();
  const { markSeen, seenSeq } = await import("../web/src/seen.js");
  assert.equal(seenSeq("u1", "s1"), 0, "没看过的会话没有分界");
  markSeen("u1", "s1", 42);
  assert.equal(seenSeq("u1", "s1"), 42);
  assert.equal(seenSeq("u1", "s2"), 0, "每个会话各记各的");
  assert.equal(seenSeq("u2", "s1"), 0, "每个用户各记各的");
  markSeen("u1", "s1", 0);
  assert.equal(seenSeq("u1", "s1"), 42, "空位置不覆盖");
  markSeen("u1", "s1", 3);
  assert.equal(seenSeq("u1", "s1"), 3, "历史清空、序号重排后位置跟着退回来");
  delete (globalThis as any).localStorage;
  assert.equal(seenSeq("u1", "s1"), 0, "读不到本机存储时不画分界");
  markSeen("u1", "s1", 9);
});

test("「新」分界进来时留着，来了新消息就收起", async () => {
  const timeline = await readFile("web/src/ConversationTimeline.vue", "utf8");
  const code = timeline.slice(timeline.indexOf("const turns ="), timeline.indexOf("</script>"));
  const props = reactive({
    messages: [
      { seq: 1, role: "user", text: "旧问题" },
      { seq: 2, role: "assistant", text: "旧回答" },
      { seq: 3, role: "user", text: "新问题" },
      { seq: 4, role: "assistant", text: "新回答" },
    ],
    newFrom: 2, running: false, live: "", thinking: "", activeTools: [],
  });
  const state = vm.runInNewContext(code + "\n({ newAt, markGone })", { computed, ref, watch, conversationTurns, props });
  assert.equal(state.newAt.value, 1, "第一条比进来时更新的消息所在的那一轮");
  assert.equal(state.markGone.value, false, "刚进来先留着");
  props.messages = [...props.messages, { seq: 5, role: "assistant", text: "刚来的" }];
  await nextTick();
  assert.equal(state.markGone.value, true, "来了新消息就收起");
});

test("客户端和网页都画出「新」分界，并在这之后收起", async () => {
  const text = (path: string) => readFile(path, "utf8");
  for (const path of ["web/src/EmployeeChat.vue", "web/src/GroupChat.vue", "web/src/ConversationTimeline.vue"]) {
    const source = await text(path);
    assert.match(source, /:class="markGone \? 'chat-new gone' : 'chat-new'" role="separator" aria-label="新消息"/, path);
    assert.match(source, /seq > baseSeq\) markGone\.value = true/, path);
  }
  assert.match(await text("web/src/style.css"), /\.chat-new\.gone \{ visibility: hidden; \}/);
  const app = await text("web/src/App.vue");
  assert.match(app, /newFrom\.value = seenSeq\(user\.value\.id, session\.id\)/, "进来时取上次看到的位置");
  assert.match(app, /next === "chat" && user\.value && current\.value\) newFrom\.value = seenSeq/, "切出再回来也能重新取");
  const client = await text("local/ui/app.js");
  assert.match(client, /firstNew >= 0 && !state\.markGone/, "窗口按同一份已读位置画分界");
  assert.match(client, /state\.markGone = true;/, "窗口来了新消息就收起");
  assert.match(await text("local/ui/style.css"), /\.new-line \{/);
});
