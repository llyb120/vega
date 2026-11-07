import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Context } from "../server/core/context";

const bulky = (label: string) => JSON.stringify({ label, detail: "x".repeat(4000) });
const PLAN = [
  { content: "在服务端浏览器打开百度首页", status: "completed" },
  { content: "回到编码修复页面脚本", status: "in_progress" },
];

async function session() {
  const store = await Store.open(":memory:");
  const { id } = await store.newSession({ scene: "lightweight" });
  const add = (m: any) => store.append(id, m);
  return { store, id, add };
}
const viewText = async (context: Context) => (await context.promptView()).map(m => m.text || "").join("\n");

test("leaving computer folds browser process but keeps task goal, plan, artifacts and errors; originals stay retrievable", async () => {
  const { store, id, add } = await session();
  try {
    await add({ role: "user", text: "任务：打开百度首页核实标题并截图，然后修复页面脚本；不得登录或搜索" });
    await add({ role: "assistant", calls: [{ id: "p1", name: "task_progress", arguments: { message: "进入电脑场景", plan: PLAN } }] });
    await add({ role: "tool", callId: "p1", name: "task_progress", text: '{"ok":true}' });
    await add({ role: "assistant", calls: [{ id: "c1", name: "chrome_navigate", arguments: { url: "https://www.baidu.com/" } }] });
    await add({ role: "tool", callId: "c1", name: "chrome_navigate", text: bulky("navigate"), images: [{ mime: "image/webp", url: "/api/files/shot-1.webp", path: "/data/files/shot-1.webp" }] });
    await add({ role: "assistant", calls: [{ id: "c2", name: "chrome_act", arguments: { tabTag: "t1", actions: [{ type: "click", ref: "e9" }] } }] });
    await add({ role: "tool", callId: "c2", name: "chrome_act", error: true, text: '{"status":"not_executed","reason":"ref e9 stale"}' + "y".repeat(3000) });
    await add({ role: "assistant", text: "百度已打开，标题为「百度一下，你就知道」，截图已保存" });
    await add({ role: "user", text: "现在回到代码修复" });
    await add({ role: "assistant", calls: [{ id: "s1", name: "switch_scene", arguments: { scene: "coding", message: "修复页面脚本" } }] });

    const context = await Context.open(store, id, "auto");
    const before = (await store.messages(id)).map(m => ({ seq: m.seq, text: m.text }));
    const result = await context.sceneFold("computer", "coding");
    assert.equal(result.status, "applied");
    assert.equal((result as any).topic, "folded-browser-for-coding");

    const view = await viewText(context);
    assert.match(view, /任务：打开百度首页核实标题并截图，然后修复页面脚本；不得登录或搜索/, "task goal and restrictions stay verbatim");
    assert.match(view, /现在回到代码修复/, "latest user instruction stays");
    const progress = (await context.promptView()).find(m => m.calls?.some(c => c.name === "task_progress"));
    assert.deepEqual(progress?.calls?.[0].arguments.plan, PLAN, "plan-only progress is not browser process and stays unfolded");
    assert.match(view, /\/api\/files\/shot-1\.webp/, "artifact reference survives the fold");
    assert.match(view, /chrome_act failed: .*ref e9 stale/, "relevant error survives");
    assert.match(view, /do not repeat them/);
    assert.doesNotMatch(view, /x{1000}/, "bulky browser result is folded out of the prompt");

    const block = (result as any).block;
    const restored = await context.decompress(block);
    assert(restored, "fold can be decompressed");
    assert.doesNotMatch(await viewText(context), /acp-block id="[^"]*" [^>]*topic="folded-browser-for-coding"/);
    assert.match(await viewText(context), /x{1000}/, "original browser result is back after decompress");
    assert.deepEqual((await store.messages(id)).map(m => ({ seq: m.seq, text: m.text })), before, "canonical history is untouched");
  } finally { await store.close(); }
});

test("entering computer folds coding process and leaves browser work alone; recall returns the originals", async () => {
  const { store, id, add } = await session();
  try {
    await add({ role: "user", text: "任务：修复构建后在浏览器验证首页" });
    await add({ role: "assistant", calls: [{ id: "b1", name: "bash", arguments: { command: "npm run build" } }] });
    await add({ role: "tool", callId: "b1", name: "bash", text: bulky("build log") });
    await add({ role: "assistant", calls: [{ id: "e1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] } }] });
    await add({ role: "tool", callId: "e1", name: "edit", text: bulky("edit result") });
    await add({ role: "assistant", text: "构建通过，修改已保存在 src/app.ts" });
    await add({ role: "user", text: "去浏览器验证" });
    await add({ role: "assistant", calls: [{ id: "s1", name: "switch_scene", arguments: { scene: "computer", message: "浏览器验证首页" } }] });

    const context = await Context.open(store, id, "auto");
    const result = await context.sceneFold("coding", "computer");
    assert.equal(result.status, "applied");
    assert.equal((result as any).topic, "folded-coding-for-computer");
    const view = await viewText(context);
    assert.match(view, /任务：修复构建后在浏览器验证首页/);
    assert.match(view, /called bash .*npm run build/);
    assert.doesNotMatch(view, /x{1000}/, "build log no longer occupies the browser prompt");

    const recalled = await context.recall({ query: "build log" });
    assert(JSON.stringify(recalled).includes("x".repeat(200)), "recall returns the original coding output");
  } finally { await store.close(); }
});

test("folding is driven by history content, not by tool definitions: no browser history means nothing to fold leaving computer", async () => {
  const { store, id, add } = await session();
  try {
    await add({ role: "user", text: "任务：整理日志" });
    await add({ role: "assistant", calls: [{ id: "r1", name: "read", arguments: { path: "log.txt" } }] });
    await add({ role: "tool", callId: "r1", name: "read", text: bulky("log") });
    await add({ role: "assistant", text: "日志已读" });
    await add({ role: "user", text: "继续" });
    await add({ role: "assistant", calls: [{ id: "s1", name: "switch_scene", arguments: { scene: "lightweight", message: "整理" } }] });
    const context = await Context.open(store, id, "auto");
    assert.equal((await context.sceneFold("coding", "lightweight")).status, "noop");
    assert.match(await viewText(context), /x{1000}/, "coding history stays visible when no browser process exists");
  } finally { await store.close(); }
});

test("a plan batched together with browser calls is summarized in the fold instead of being clipped away", async () => {
  const { store, id, add } = await session();
  try {
    await add({ role: "user", text: "任务：打开百度并记录进度" });
    await add({ role: "assistant", calls: [
      { id: "p1", name: "task_progress", arguments: { message: "百度已打开", plan: PLAN } },
      { id: "c1", name: "chrome_inspect", arguments: { tabTag: "t1" } },
    ] });
    await add({ role: "tool", callId: "p1", name: "task_progress", text: '{"ok":true}' });
    await add({ role: "tool", callId: "c1", name: "chrome_inspect", text: bulky("inspect") });
    await add({ role: "assistant", text: "已核实" });
    await add({ role: "user", text: "回到编码" });
    await add({ role: "assistant", calls: [{ id: "s1", name: "switch_scene", arguments: { scene: "coding", message: "编码" } }] });
    const context = await Context.open(store, id, "auto");
    assert.equal((await context.sceneFold("computer", "coding")).status, "applied");
    assert.match(await viewText(context), /task_progress 百度已打开 \| plan: \[completed\] 在服务端浏览器打开百度首页; \[in_progress\] 回到编码修复页面脚本/);
  } finally { await store.close(); }
});
