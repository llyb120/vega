import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";

const source = readFileSync("web/src/EmployeeSessionView.vue", "utf8");
function mount(api: (path: string) => Promise<any>, debug = true, failure = "") {
  const props = { api, debug, sessionId: "session-fixture", revision: 0 };
  const blobs: Blob[] = [], links: any[] = [], revoked: string[] = [], timers: (() => void)[] = [];
  const state = vm.runInNewContext(
    source.slice(source.indexOf("const props ="), source.indexOf("</script>")) +
      "\n({ refresh, exportSession, record, messages, raw, busy, error })",
    {
      ref, Blob,
      CHAT_PAGE_SIZE: 60,
      mergeMessages: (a, b) => [...a, ...b],
      nextTick: async () => {},
      encodeURIComponent,
      defineProps: () => props, defineEmits: () => () => {},
      watch: () => {}, onBeforeUnmount: () => {},
      document: {
        createElement: (tag: string) => {
          assert.equal(tag, "a");
          const link = { href: "", download: "", attached: false, clicked: false, removed: false,
            click() { if (failure === "click") throw Error("download blocked"); this.clicked = true; },
            remove() { this.removed = true; this.attached = false; },
          };
          links.push(link);
          return link;
        },
        body: { append: (link: any) => { link.attached = true; } },
      },
      URL: {
        createObjectURL: (blob: Blob) => {
          if (failure === "blob") throw Error("blob unavailable");
          blobs.push(blob);
          return "blob:debug-export";
        },
        revokeObjectURL: (url: string) => revoked.push(url),
      },
      setTimeout: (callback: () => void) => timers.push(callback),
    },
  );
  return { ...state, props, blobs, links, revoked, cleanup: () => timers.splice(0).forEach((callback) => callback()) };
}

const fixture = () => ({
  session: { scenes: { lightweight: ["provider/model"], coding: ["provider/model"], computer: ["provider/model"] }, id: "session-fixture", title: "调试 / 会话", employeeId: "employee-fixture", taskId: "task-fixture", cwd: "D:/work", model: "provider/model", scene: "computer" },
  messages: [
    ...Array.from({ length: 120 }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", text: "消息 " + i })),
    { seq: 121, role: "assistant", text: "原始输入", displayText: "整理视图", thinking: "思考过程", calls: [{ id: "call-fixture", name: "read", arguments: { path: "D:/work/file" } }], usage: { input: 100, output: 20 } },
    { seq: 122, role: "tool", callId: "call-fixture", name: "read", error: true, text: "原始错误", images: [{ mime: "image/png", blobId: "blob-fixture" }] },
  ],
  folds: [{ id: "fold-fixture", summary: "折叠摘要", start: 1, end: 2 }],
  context: { mode: "acp", tokens: 1234 },
  fire: null, running: true, canWrite: false,
});

test("debug export saves the entire loaded session as readable JSON, regardless of the displayed view", async () => {
  const payload = fixture(), paths: string[] = [];
  const state = mount(async (path) => { paths.push(path); return payload; });
  await state.refresh();
  state.raw.value = false;
  await state.exportSession();
  assert.deepEqual(paths, ["/sessions/session-fixture?limit=60", "/sessions/session-fixture"]);
  assert.equal(state.blobs.length, 1);
  assert.equal(state.blobs[0].type, "application/json;charset=utf-8");
  const json = await state.blobs[0].text(), exported = JSON.parse(json);
  assert(Number.isFinite(Date.parse(exported.exportedAt)));
  delete exported.exportedAt;
  assert.deepEqual(exported, payload, "preserve all messages, tool arguments/results, thinking, folds, context and blob references");
  assert(json.includes('\n  "session": {') && json.endsWith("\n"));
  assert.equal(state.links[0].download, "vega-session-session-fixture.json");
  assert.equal(state.links[0].href, "blob:debug-export");
  assert.equal(state.links[0].clicked, true);
  assert.equal(state.links[0].removed, true);
  assert.deepEqual(state.revoked, [], "allow the browser to start the download before revoking the URL");
  state.cleanup();
  assert.deepEqual(state.revoked, ["blob:debug-export"]);
});

test("export is debug-only and disabled until a complete record is loaded", async () => {
  const state = mount(async () => fixture());
  await state.exportSession();
  assert.equal(state.blobs.length, 0);
  await state.refresh();
  state.busy.value = true;
  await state.exportSession();
  state.busy.value = false;
  state.props.debug = false;
  await state.exportSession();
  assert.equal(state.blobs.length, 0);
  assert.match(source, /<button v-if="debug"[^>]*:disabled="busy \|\| !record"[^>]*aria-label="导出会话（JSON）"[^>]*@click="exportSession"/);
  assert(source.includes("分享前请脱敏；图片仅保留引用"));
});

test("switching to a session that fails to load cannot export the previous session", async () => {
  let fail = false;
  const state = mount(async () => { if (fail) throw Error("not found"); return fixture(); });
  await state.refresh();
  state.props.sessionId = "other-session";
  fail = true;
  await state.refresh();
  await state.exportSession();
  assert.equal(state.record.value, null);
  assert.equal(state.blobs.length, 0);
  assert.equal(state.error.value, "not found");
});

test("empty conversations can still export their metadata", async () => {
  const payload = { ...fixture(), messages: [], folds: [], running: false };
  const state = mount(async () => payload);
  await state.refresh();
  await state.exportSession();
  const exported = JSON.parse(await state.blobs[0].text());
  assert.deepEqual(exported.messages, []);
  assert.deepEqual(exported.session, payload.session);
  state.cleanup();
});

for (const failure of ["blob", "click"]) test(`export errors (${failure}) are reported and temporary resources are cleaned up`, async () => {
  const state = mount(async () => fixture(), true, failure);
  await state.refresh();
  await state.exportSession();
  assert.match(state.error.value, /^导出失败：/);
  assert.equal(state.links[0].removed, true);
  state.cleanup();
  assert.deepEqual(state.revoked, failure === "click" ? ["blob:debug-export"] : []);
});
