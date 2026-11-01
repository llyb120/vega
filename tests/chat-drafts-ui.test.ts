import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { computed, ref } from "vue";

const source = readFileSync("web/src/App.vue", "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(handler: (path: string, method: string, data: any) => any = () => undefined) {
  const calls: any[] = [], readers: any[] = [];
  const context: any = {
    ref, computed, sessionRequest: 0, user: ref({ id: "alice" }), csrfToken: ref("alice-login"),
    contextBudget: ref(null), fireState: ref(null), live: ref(""), thinking: ref(""), activeTools: ref([]), view: ref("chat"),
    canWriteCurrent: ref(true), executionUnavailable: ref(false), uploading: ref(false), error: ref(""), notice: ref(""),
    project: ref("fixture"), executionLocal: ref(false), executionClientId: ref(""),
    sessionStorage: { setItem() {}, removeItem() {} }, closeNavigation() {}, scrollBottom: async () => {},
    bootstrap: async () => {}, refreshCurrent: async () => {},
    api: async (path: string, method = "GET", data?: any) => {
      calls.push({ path, method, data });
      const result = await handler(path, method, data);
      if (result !== undefined) return result;
      if (method === "GET") return { session: { id: path.split("/").at(-1) }, messages: [], running: false };
      return {};
    },
    FileReader: class {
      result = "data:image/png;base64,YQ==";
      onload: any;
      readAsDataURL() { readers.push(this); }
    },
    localBridge: null, stopPresence() {}, employeeRefreshTimer: undefined, closed: false, eventGeneration: 0,
    eventReconnect: undefined, eventsHeartbeat: undefined, eventsSocket: null, eventsReady: false, eventsWasConnected: false,
    clearTimeout, clearInterval, rejectSocketRequests() {}, authenticated: ref(true), password: ref(""), setupToken: ref(""),
    onlineClients: ref([]), localPairing: ref(null), clientListReady: ref(true), config: ref({}), catalogModels: ref([]), activeTaskCount: ref(null), employeeSession: ref(""), employeeError: ref(""),
  };
  context.attempt = async (fn: any) => { try { return await fn(); } catch (e: any) { context.error.value = e.message; } };
  const state = vm.runInNewContext([
    between("const sessions = ref([])", "const contextBudget ="),
    between("async function selectSession(session)", "async function newSession()"),
    between("async function send()", "function messageKey(event)"),
    between("async function upload(event)", "async function scrollBottom()"),
    between("function resetLogin()", "async function logout()"),
    "({current, sessions, composer, draft, attachments, drafts, sending, selectSession, send, upload, resetLogin})",
  ].join("\n"), context);
  return { ...state, calls, readers, context, select: (id: string) => state.selectSession({ id }) };
}
const image = () => ({ mime: "image/png", data: "YQ==" });

test("switching and reselecting sessions restores each text/image draft without stale loads overwriting it", async () => {
  const load = deferred();
  const s = mount((path) => path === "/sessions/b" ? load.promise : undefined);
  await s.select("a");
  s.draft.value = "draft a";
  s.attachments.value.push(image());
  const stale = s.select("b");
  assert.equal(s.draft.value, "");
  s.draft.value = "draft b";
  await s.select("a");
  load.resolve({ session: { id: "b" }, messages: ["stale"] });
  await stale;
  assert.equal(s.current.value.id, "a");
  assert.equal(s.draft.value, "draft a");
  assert.equal(s.attachments.value.length, 1);
  await s.select("a");
  assert.equal(s.draft.value, "draft a");
  await s.select("b");
  assert.equal(s.draft.value, "draft b");
  assert.equal(s.attachments.value.length, 0);
});

test("a late send response clears only its originating unchanged draft and never redirects another session", async () => {
  const response = deferred();
  const s = mount((_path, method) => method === "POST" ? response.promise : undefined);
  await s.select("a");
  s.draft.value = "send a";
  s.attachments.value.push(image());
  const sending = s.send();
  await s.select("b");
  s.draft.value = "keep b";
  response.resolve({ id: "stage-a" });
  await sending;
  assert.equal(s.current.value.id, "b");
  assert.equal(s.draft.value, "keep b");
  assert.equal(s.calls.filter((c: any) => c.method === "POST")[0].path, "/sessions/a/messages");
  await s.select("a");
  assert.equal(s.draft.value, "");
  assert.equal(s.attachments.value.length, 0);
});

test("send errors and edits made during submission retain recoverable drafts without replay", async () => {
  for (const mode of ["error", "text", "image"]) {
    const response = deferred();
    const s = mount((_path, method) => method === "POST" ? response.promise : undefined);
    await s.select("a");
    s.draft.value = "submitted";
    s.attachments.value.push(image());
    const sending = s.send();
    if (mode === "text") s.draft.value = "new unsent text";
    if (mode === "image") s.attachments.value.splice(0, 1);
    if (mode === "error") response.reject(Error("delivery unconfirmed; do not replay"));
    else response.resolve({});
    await sending;
    assert.equal(s.draft.value, mode === "text" ? "new unsent text" : "submitted");
    assert.equal(s.attachments.value.length, mode === "image" ? 0 : 1);
    assert.equal(s.calls.filter((c: any) => c.method === "POST").length, 1);
    assert.equal(s.sending.value, false);
  }
});

test("new-session creation transfers its draft before submission; failure does not discard it", async () => {
  const s = mount((path, method) => {
    if (path === "/sessions" && method === "POST") return { id: "created" };
    if (method === "POST") throw Error("message rejected");
  });
  s.draft.value = "new chat draft";
  s.attachments.value.push(image());
  await s.send();
  assert.equal(s.current.value.id, "created");
  assert.equal(s.draft.value, "new chat draft");
  assert.equal(s.attachments.value.length, 1);
  await s.select("b");
  await s.select("created");
  assert.equal(s.draft.value, "new chat draft");
});

test("switching during new-session creation cannot send the captured message to the newly selected session", async () => {
  const created = deferred();
  const s = mount((path, method) => path === "/sessions" && method === "POST" ? created.promise : undefined);
  s.draft.value = "new chat only";
  const sending = s.send();
  await s.select("b");
  s.draft.value = "keep b";
  created.resolve({ id: "created" });
  await sending;
  assert.equal(s.current.value.id, "b");
  assert.equal(s.draft.value, "keep b");
  assert.deepEqual(s.calls.filter((c: any) => c.method === "POST").map((c: any) => c.path), ["/sessions", "/sessions/created/messages"]);
});

test("image reads stay with the originating draft; logout clears all drafts and invalidates in-flight operations", async () => {
  const created = deferred();
  const s = mount((path, method) => path === "/sessions" && method === "POST" ? created.promise : undefined);
  await s.select("a");
  const reading = s.upload({ target: { files: [{ type: "image/png", size: 1 }], value: "fixture.png" } });
  await s.select("b");
  s.readers[0].onload();
  await reading;
  assert.equal(s.attachments.value.length, 0);
  await s.select("a");
  assert.equal(s.attachments.value.length, 1);
  const lateRead = s.upload({ target: { files: [{ type: "image/png", size: 1 }], value: "fixture.png" } });
  s.resetLogin();
  s.context.csrfToken.value = "bob-login";
  s.context.user.value = { id: "bob" };
  s.readers[1].onload();
  await lateRead;
  assert.equal(s.drafts.size, 1);
  assert.equal(s.draft.value, "");
  assert.equal(s.attachments.value.length, 0);
  s.draft.value = "bob draft";
  const sending = s.send();
  s.resetLogin();
  s.context.csrfToken.value = "carol-login";
  s.context.user.value = { id: "carol" };
  s.draft.value = "carol draft";
  created.resolve({ id: "bob-created" });
  await sending;
  assert.equal(s.draft.value, "carol draft");
  assert.equal(s.drafts.has("bob-created"), false);
  assert.equal(s.calls.filter((c: any) => c.method === "POST").length, 1);
});
