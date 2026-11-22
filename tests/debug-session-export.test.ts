import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { phaseIndex } from '../web/src/agent-phases.js';
import vm from "node:vm";
import { computed, ref } from "vue";

const source = readFileSync("web/src/EmployeeSessionView.vue", "utf8");
function mount(api: (path: string) => Promise<any>, debug = true, failure = "") {
  const props = { api, debug, sessionId: "session-fixture", revision: 0 };
  const blobs: Blob[] = [], links: any[] = [], revoked: string[] = [], timers: (() => void)[] = [];
  const state = vm.runInNewContext(
    source.slice(source.indexOf("const props ="), source.indexOf("</script>")) +
      "\n({ refresh, loadOlder, exportSession, record, messages, hasMore, raw, busy, error })",
    {
      ref, computed, Blob, phaseIndex,
      CHAT_PAGE_SIZE: 60,
      mergeMessages: (a: any[], b: any[]) => [...a, ...b],
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

test("debug export fetches the entire session, including unloaded and newly added messages", async () => {
  const payload = fixture(), paths: string[] = [];
  const state = mount(async (path) => {
    paths.push(path);
    return path.includes("?limit=") ? { ...payload, messages: payload.messages.slice(-60), hasMore: true } : payload;
  });
  await state.refresh();
  assert.equal(state.messages.value.length, 60);
  assert.equal(state.messages.value[0].seq, 63);
  payload.messages.push({ seq: 123, role: "assistant", text: "导出前新增的消息" } as any);
  state.raw.value = false;
  await state.exportSession();
  assert.deepEqual(paths, ["/debug/sessions/session-fixture?limit=60", "/debug/sessions/session-fixture"]);
  assert.equal(state.messages.value.length, 60, "export does not alter the displayed page");
  assert.equal(state.blobs.length, 1);
  assert.equal(state.blobs[0].type, "application/json;charset=utf-8");
  const json = await state.blobs[0].text(), exported = JSON.parse(json);
  assert(Number.isFinite(Date.parse(exported.exportedAt)));
  delete exported.exportedAt;
  assert.deepEqual(exported, { ...payload, agentPhases: [] }, "preserve all messages, tool arguments/results, thinking, folds, context and blob references");
  assert(json.includes('\n  "session": {') && json.endsWith("\n"));
  assert.equal(state.links[0].download, "vega-session-session-fixture.json");
  assert.equal(state.links[0].href, "blob:debug-export");
  assert.equal(state.links[0].clicked, true);
  assert.equal(state.links[0].removed, true);
  assert.deepEqual(state.revoked, [], "allow the browser to start the download before revoking the URL");
  state.cleanup();
  assert.deepEqual(state.revoked, ["blob:debug-export"]);
});

test('export links stage details to original messages outside the displayed page', async () => {
  const payload = fixture();
  const phase = { seq: 2, name: 'code_agent' };
  Object.assign(payload.messages[1], { calls: [{ id: 'delegate', name: phase.name, arguments: { task: 'run tests' } }] });
  Object.assign(payload.messages[2], { role: 'tool', agentPhase: phase, name: phase.name, callId: 'delegate', cliActivity: { steps: [{ action: '命令', detail: 'npm test', exitCode: 0 }], omitted: 0 }, text: JSON.stringify({ executor: 'codex', result: 'tests passed' }) });
  const state = mount(async path => path.includes('?limit=') ? { ...payload, messages: payload.messages.slice(-60), hasMore: true } : payload);
  await state.refresh(); await state.exportSession();
  const data = JSON.parse(await state.blobs[0].text());
  assert.deepEqual(data.agentPhases[0].messageSeqs, [2, 3]);
  assert.equal(data.agentPhases[0].status, 'returned');
  assert.equal(data.messages[2].cliActivity.steps[0].detail, 'npm test');
});

test('export includes isolated child phase transcripts when present', async () => {
  const payload: any = fixture();
  const phase = { seq: 2, name: 'browser_agent' };
  Object.assign(payload.messages[1], { calls: [{ id: 'b1', name: phase.name, arguments: { task: 'open pricing' } }] });
  Object.assign(payload.messages[2], { role: 'tool', agentPhase: phase, name: phase.name, callId: 'b1', text: JSON.stringify({ status: 'completed', executor: 'model/p/vision', phaseSession: 'phase-1', result: 'ok', evidence: { visitedUrls: [{ url: 'https://example.test' }], tabs: [], screenshots: [], documentPaths: [], errors: [] } }) });
  payload.phaseTranscripts = { 'phase-1': [{ seq: 1, role: 'user', text: 'open pricing' }, { seq: 2, role: 'assistant', text: 'ok' }] };
  const state = mount(async path => path.includes('?limit=') ? { ...payload, messages: payload.messages.slice(-60), hasMore: true } : payload);
  await state.refresh(); await state.exportSession();
  const data = JSON.parse(await state.blobs[0].text());
  assert.equal(data.agentPhases[0].phaseSession, 'phase-1');
  assert.equal(data.phaseTranscripts['phase-1'].length, 2);
});

test("exporting the same session before and after loading older pages returns the same messages", async () => {
  const payload = fixture();
  const state = mount(async (path) => {
    assert.equal(path.split("?")[0], "/debug/sessions/session-fixture", "paging and export both use the admin route");
    if (path.includes("?limit=")) return { ...payload, messages: payload.messages.slice(-60), hasMore: true };
    if (path.includes("?before=")) {
      const before = Number(new URL("http://fixture" + path).searchParams.get("before"));
      const older = payload.messages.filter((message) => message.seq < before);
      return { ...payload, messages: older.slice(-60), hasMore: older.length > 60 };
    }
    return payload;
  });
  await state.refresh();
  await state.exportSession();
  await state.loadOlder();
  await state.loadOlder();
  assert.equal(state.hasMore.value, false);
  assert.equal(state.messages.value.length, payload.messages.length);
  await state.exportSession();
  const before = JSON.parse(await state.blobs[0].text()), after = JSON.parse(await state.blobs[1].text());
  delete before.exportedAt;
  delete after.exportedAt;
  assert.deepEqual(before, after);
  assert.deepEqual(after.messages, payload.messages);
  state.cleanup();
});

test("export is debug-only and disabled until the session is loaded", async () => {
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

test("export refuses an incomplete or mismatched response rather than saving a partial session", async () => {
  for (const response of [
    { ...fixture(), messages: fixture().messages.slice(-60), hasMore: true },
    { ...fixture(), session: { ...fixture().session, id: "another-session" } },
    { ...fixture(), messages: undefined },
  ]) {
    const state = mount(async (path) => path.includes("?limit=") ? fixture() : response);
    await state.refresh();
    await state.exportSession();
    assert.equal(state.blobs.length, 0);
    assert.match(state.error.value, /未能获取完整会话记录/);
    assert.equal(state.busy.value, false);
    state.cleanup();
  }
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
