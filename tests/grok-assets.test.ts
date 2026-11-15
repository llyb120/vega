import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import vm from "node:vm";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

const resources = "local/resources/grok";

// Only public renderer assets are imported, never the original application's user data.
test("renderer assets match the original Grok Bot 1.1.0 release byte for byte", () => {
  const lines = readFileSync("tests/grok-renderer-1.1.0.sha256", "utf8").trim().split("\n");
  assert.equal(lines.length, 696);
  for (const line of lines) {
    const [expected, path] = line.split("  ");
    assert.equal(createHash("sha256").update(readFileSync(join(resources, path))).digest("hex"), expected, path);
  }
  const html = readFileSync(join(resources, "index.html"), "utf8");
  assert.match(html, /index-DcdocK0f\.js/);
  assert.match(html, /index-BkOHlEB9\.css/);
  assert.match(html, /grok_bridge\.js/);
  assert.equal(createHash("sha256").update(html.replace(/    <script src="\.\/grok_bridge\.js"><\/script>\r?\n/, "")).digest("hex"), "0d66097febf3429db9862465a5a2f368b94ed1f56f98d7de1d95f788dcf3a74b");
});

test("embedded desktop JavaScript parses as browser modules", () => {
  execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", `
    import { readdirSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { SourceTextModule } from 'node:vm';
    const directory = 'local/resources/grok/assets';
    for (const name of readdirSync(directory).filter(name => name.endsWith('.js'))) {
      new SourceTextModule(readFileSync(join(directory, name), 'utf8'), { identifier: name });
    }
  `], { stdio: "pipe" });
});

test("desktop always keeps the new interface instead of redirecting to legacy", () => {
  const html = readFileSync(join(resources, "index.html"), "utf8");
  assert.doesNotMatch(html, /legacy=1|vega-boot-recovery/);
});

function bridge(dark = true, nativeHost = false, respond?: (url: string, body: any, signal: AbortSignal) => any) {
  const requests: { url: string; body: any }[] = [], replies: any[] = [], events: any[] = [], native: string[] = [];
  const listeners: Record<string, (event: any) => void> = {}, documentListeners: Record<string, (event: any) => void> = {};
  let port: any;
  const storage: Record<string, any> = {};
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  let ok = true;
  const window: any = {
    location: { pathname: "/assistant/test/" }, devicePixelRatio: 2, vegaPanelDpiScale: 2,
    addEventListener: (type: string, listener: (event: any) => void) => { listeners[type] = listener; },
    matchMedia: () => ({ matches: dark, addEventListener() {} }),
    ...(nativeHost ? { chrome: { webview: { postMessage: (message: string) => native.push(message) } } } : {}),
  };
  const document = { getElementById: () => null, addEventListener: (type: string, listener: (event: any) => void) => { documentListeners[type] = listener; } };
  window.document = document;
  vm.runInNewContext(readFileSync(join(resources, "grok_bridge.js"), "utf8"), {
    window, document,
    getComputedStyle: (element: any) => ({ getPropertyValue: (property: string) => property === "--sand-app-region" ? element.region : "none" }),
    localStorage: storage, console: { log() {}, error() {} },
    setTimeout: (fn: () => void, ms: number) => { if (!ms) fn(); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    AbortController, TextDecoder,
    MessageChannel: class {
      port1 = { postMessage() {}, start() {}, close() {}, addEventListener() {} };
      port2 = port = { postMessage: (reply: any) => { (reply.kind === "event" ? events : replies).push(reply); } };
    },
    fetch: async (url: string, options: any) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (respond) return respond(url, JSON.parse(options.body), options.signal);
      return { ok, json: async () => url.endsWith("threads")
        ? { employees: [{ id: "e1", name: "测试牛马", thread: "employee:e1", unread: 2, lastText: "最新进展", lastAt: 1200, lastMessageId: "entry-12", botAvatar: { shape: "round", color: "purple" } }] }
        : { messages: [{ seq: 12, role: "assistant", text: "新版消息", at: 1000 }] } };
    },
  });
  return {
    desktop: window.desktop, requests, events,
    native, window, listeners, documentListeners,
    fail: () => { ok = false; },
    request: async (method: string, args: any = {}) => {
      await port.onmessage({ data: { kind: "request", requestId: "test", method, args } });
      return replies.pop().outcome;
    },
  };
}

test("new renderer bridge boots synchronously and preserves persistence scope", async () => {
  const { desktop } = bridge();
  assert.equal(typeof desktop.main.subscribe({ "theme-changed"() {} }), "function");
  assert.equal(desktop.boot.theme.preference, "system");
  assert.equal(desktop.boot.theme.resolved, "dark");
  assert.equal(desktop.boot.experiments.featureGates.sand_xvf_typeface, true);
  assert.equal((await desktop.main.getExperimentsSnapshot()).featureGates.sand_chat_prose_15px, true);
  assert.equal((await desktop.main.getThemeState()).resolved, "dark");
  assert.equal((await desktop.main.getLanguageState()).resolved, "zh-CN");
  assert.equal((await desktop.main.getUpdateStatus()).state.type, "disabled");
  assert.equal(JSON.stringify(await desktop.main.getLocalPitmanState()), '{"isRecorderReady":false,"session":null}');
  assert.equal(desktop.boot.experiments.featureGates.grok_bot_files_stage, true);
  assert.equal(desktop.boot.experiments.featureGates.sand_grok_main_agent, true);
  await desktop.main.writeClientPersistence({ key: "kept/a", value: "yes" });
  await desktop.main.writeClientPersistence({ key: "private/a", value: "no" });
  const values = await desktop.main.readManyClientPersistence({ include: [""], exclude: ["private/"] });
  assert.equal(JSON.stringify(values), '{"kept/a":"yes"}');
});

test("new renderer roster and transcript use the native API and message schema", async () => {
  const b = bridge();
  const roster = await b.request("getServerAgentRoster");
  assert.equal(roster.value.agents[0].harness, "temporal");
  assert.equal(roster.value.agents[0].lastMessagePreview, "最新进展");
  assert.equal(roster.value.agents[0].lastEntry.text, "最新进展");
  assert.equal(roster.value.agents[0].hasUnread, true);
  assert.equal(roster.value.agents[0].lastActivityAt, 1200);
  assert.equal(roster.value.agents[0].lastMessageId, "entry-12");
  assert.equal(roster.value.agents[0].avatarShape, "pebble");
  assert.equal(roster.value.agents[0].avatarColor, "violet");
  assert.equal((await b.request("getMainAgent")).value.agentId, "e1");
  const tail = await b.request("openAgentTail", { id: "e1" });
  assert.deepEqual(JSON.parse(JSON.stringify(tail.value.entries[0])), {
    id: "entry-12", seq: 12, timestampMs: 1000, kind: "send-message", streaming: false, message: { type: "text", content: "新版消息" }, tasks: [],
  });
  assert(b.requests.some((request) => request.url === "/assistant/test/api/messages" && request.body.thread === "employee:e1"));
  assert(b.requests.some((request) => request.url.endsWith("/read")), "opening a chat marks the same Vega history read");
  assert(!b.requests.some((r) => r.url.includes("//")), "API path must not redirect POST requests");
  assert.equal((await b.request("sendPrompt", { agentId: "e1", prompt: "fixture only", clientNonce: "fixture-send-nonce" })).value.accepted, true);
  assert.equal(b.requests.at(-1)?.body.clientMessageId, "fixture-send-nonce");
  b.fail();
  assert.equal((await b.request("sendPrompt", { agentId: "e1", prompt: "fixture only", clientNonce: "fixture-send-nonce" })).status, "failed");
  assert.equal((await b.request("deleteAgents", { ids: ["e1"] })).failure.code, "capability-unavailable");
  await assert.rejects(b.desktop.main.publishGrokBotAgent({ agentId: "e1" }), /暂未接入/);
  assert.equal((await b.request("sendPrompt", { agentId: "e1", prompt: "fixture", attachmentPaths: ["file"] })).status, "failed");
});

test("native-only avatar ids survive creation and profile edits", async () => {
  const employee = { id: "e1", name: "Native", botAvatar: { shape: "wedge", color: "violet" } };
  const b = bridge(true, false, (url, body) => ({ ok: true, json: async () => {
    if (url.endsWith("threads")) return { employees: [employee] };
    if (body.avatar) {
      const [, shape, color] = body.avatar.split(":");
      employee.botAvatar = { shape, color };
    }
    return { id: "e1" };
  } }));
  const created = await b.request("createAgent", { name: "Native", clientNonce: "native-avatar-fixture", avatarShape: "wedge", avatarColor: "violet" });
  assert.equal(created.value.agent.avatarShape, "wedge");
  assert.equal(created.value.agent.avatarColor, "violet");
  await b.request("updateAgent", { id: "e1", profile: { avatarColor: "yellow" } });
  assert.equal(b.requests.find((r) => r.url.endsWith("update"))?.body.avatar, "bot:wedge:yellow");
});

test("live replies use the renderer's reply schema, acknowledge echoes and retain loaded history", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const b = bridge(true, false, (url, body) => {
    if (url.endsWith("stream")) return { ok: true, body: stream };
    return { ok: true, json: async () => url.endsWith("threads") ? { employees: [] } : url.endsWith("messages")
      ? body.before
        ? { messages: [{ seq: 1, role: "user", text: "older", clientMessageId: "fixture-older-nonce" }], nextBeforeSeq: null }
        : { messages: [{ seq: 2, role: "assistant", text: "reply" }], nextBeforeSeq: 2 }
      : {} };
  });
  await b.request("openAgentTail", { id: "e1" });
  const older = await b.request("getAgentTranscriptTail", { id: "e1", beforeSeq: 2 });
  assert.equal(older.value.ordered.replicaKey, "transcript:e1");
  const push = (event: any) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  const snapshot = () => b.events.filter((e) => e.family === "transcript").at(-1).payload.entries;
  push({ type: "text_delta", data: "live" });
  await new Promise(setImmediate);
  assert.equal(snapshot().at(-1).kind, "send-message");
  assert.equal(snapshot().at(-1).streaming, true);
  assert.equal(snapshot().at(-1).message.content, "live");
  const liveEvent = b.events.filter((e) => e.family === "transcript").at(-1).payload;
  assert.equal(liveEvent.ordered.epoch, older.value.ordered.epoch);
  assert(liveEvent.ordered.sequence > older.value.ordered.sequence);
  assert(liveEvent.coverage.fromSequence > 1, "a live tail must not exhaust the older-page cursor");
  push({ type: "history-changed" });
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(snapshot(), (e: any) => e.seq), [1, 2]);
  assert.equal(snapshot()[0].clientNonce, "fixture-older-nonce");
  assert.equal(snapshot()[1].streaming, false);
  assert(!b.requests.some((r) => r.url.endsWith("send")), "reconnect and refresh never replay a write");
  b.listeners.pagehide({});
  controller.close();
});

test("main bot uses the original pinned tile and pin changes survive reads", async () => {
  const { desktop } = bridge();
  assert.equal(JSON.stringify(await desktop.main.getHostPinnedAgents()), '["e1"]');
  assert.equal(JSON.stringify(await desktop.main.getServerPinnedAgents()), '["e1"]');
  assert.equal(JSON.stringify(await desktop.main.setHostPinnedAgents({ pinnedAgentIds: ["e2", "e2"] })), '["e2"]');
  assert.equal(JSON.stringify(await desktop.main.getHostPinnedAgents()), '["e2"]');
  await desktop.main.setHostPinnedAgents({ pinnedAgentIds: [] });
  assert.equal(JSON.stringify(await desktop.main.getServerPinnedAgents()), '[]');
  await assert.rejects(desktop.main.setHostPinnedAgents({ pinnedAgentIds: [null] }));
});

test("desktop theme changes persist, notify the renderer and can return to system", async () => {
  const { desktop } = bridge(false);
  const events: string[] = [];
  const unsubscribe = desktop.main.subscribe({ "theme-changed": (state: any) => events.push(state.resolved) });
  assert.equal(desktop.boot.theme.resolved, "light");
  await desktop.main.setThemePreference({ preference: "dark" });
  assert.equal((await desktop.main.getThemeState()).resolved, "dark");
  await desktop.main.setThemePreference({ preference: "system" });
  assert.deepEqual(events, ["dark", "light"]);
  unsubscribe();
  await desktop.main.setThemePreference({ preference: "light" });
  assert.deepEqual(events, ["dark", "light"]);
  await assert.rejects(desktop.main.setThemePreference({ preference: "invalid" }));
});

test("appearance controls use persistent local preferences instead of frozen placeholders", async () => {
  const { desktop, window } = bridge();
  const languageEvents: string[] = [];
  desktop.main.subscribe({ "language-changed": (value: any) => languageEvents.push(value.resolved) });
  await desktop.main.setLanguagePreference({ preference: "en" });
  assert.equal((await desktop.main.getLanguageState()).resolved, "en");
  window.navigator = { language: "zh-CN" };
  await desktop.main.setLanguagePreference({ preference: "system" });
  assert.deepEqual(languageEvents, ["en", "zh-CN"]);
  await assert.rejects(desktop.main.setLanguagePreference({ preference: "invalid" }));
  await desktop.main.setBotColorInChatEnabled({ enabled: false });
  assert.equal(await desktop.main.getBotColorInChatEnabled(), false);
  await assert.rejects(desktop.main.setBotColorInChatEnabled({ enabled: "false" }));
  const controls: any = { dataset: {} };
  window.document.getElementById = () => controls;
  await desktop.main.setTitleBarOverlayTone({ isOverlayTone: true });
  assert.equal(controls.dataset.overlayTone, "true");
  await assert.rejects(desktop.main.setTitleBarOverlayTone({ isOverlayTone: "true" }));
});

test("desktop zoom and window commands use the host instead of fixed placeholders", async () => {
  const { desktop, native, window, listeners } = bridge();
  const windowEvents: any[] = [];
  desktop.main.subscribe({ "window-state": (state: any) => windowEvents.push(state) });
  listeners["vega-window-state"]({ detail: { isMaximized: true } });
  assert.equal((await desktop.main.getWindowState()).isMaximized, true);
  assert.equal(windowEvents[0].isMaximized, true);
  assert.equal(desktop.local.getZoomFactor(), 1);
  window.devicePixelRatio = 2.5;
  assert.equal(desktop.local.getZoomFactor(), 1.25);
  window.chrome = { webview: { postMessage: (message: string) => native.push(message) } };
  await desktop.main.minimizeWindow();
  await desktop.main.toggleMaximizeWindow();
  await desktop.main.closeWindow();
  assert.deepEqual(native, ["vega-window:minimize", "vega-window:toggle-maximize", "vega-window:close"]);
});

test("frameless header resolves WebView2's unsupported drag regions and keeps edges resizable", () => {
  const { native, window, documentListeners } = bridge(true, true);
  window.innerWidth = 1080;
  window.innerHeight = 780;
  native.length = 0;
  const target = { closest: () => null, parentElement: null, region: "drag", matches: (selector: string) => selector.includes(".sand-1a4o4su") };
  const event = { button: 0, clientX: 600, clientY: 30, detail: 1, target, preventDefault() {} };
  documentListeners.mousedown(event);
  documentListeners.mousedown({ ...event, detail: 2 });
  target.region = "no-drag";
  documentListeners.mousedown(event);
  documentListeners.mousedown({ ...event, clientX: 1079, clientY: 779 });
  assert.deepEqual(native, ["vega-window:drag", "vega-window:toggle-maximize", "vega-window:resize-bottomright"]);
});

test("history and live transcripts use one mapper for the real message shapes", async () => {
  const blob = "blob-0123456789abcdef0123456789abcdef";
  const rich = {
    seq: 7, role: "assistant", at: 70, error: true,
    text: "看这段代码\n\n```js\nconst n = 1;\n```",
    quote: { seq: 3, role: "user", text: "原话" },
    tasks: [{ id: "task1", title: "核对发布", status: "approval", partialDelivery: true }],
    files: [{ name: "说明.txt", mime: "text/plain", size: 2048, blobId: blob }],
    calls: [{ name: "bash", arguments: { token: "should-not-appear" } }],
    images: [{ mime: "image/png", blobId: blob }],
    mystery: { raw: true },
  };
  const waiting = { seq: 8, role: "assistant", text: "需要你处理：补充端口", at: 80, tasks: [{ id: "task2", title: "补充端口", status: "waiting" }] };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const b = bridge(true, false, (url, body) => {
    if (url.endsWith("stream")) return { ok: true, body: stream };
    if (url.endsWith("file")) return { ok: true, json: async () => ({ data: "AQID" }) };
    if (url.endsWith("threads")) return { ok: true, json: async () => ({ employees: [{ id: "e1", name: "测试牛马", thread: "employee:e1" }] }) };
    if (url.endsWith("messages")) return { ok: true, json: async () => ({ messages: [rich, waiting], nextBeforeSeq: null }) };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const tail = await b.request("openAgentTail", { id: "e1" });
  const text = tail.value.entries[0];
  const widget = tail.value.entries[1];
  const form = tail.value.entries[3];
  assert.equal(text.message.content.includes("```js"), true);
  assert.equal(text.message.content.includes("> 引用我：原话"), true);
  assert.equal(text.message.content.includes("核对发布（待你确认）"), true);
  assert.equal(text.message.content.includes("说明.txt"), true);
  assert.equal(text.message.content.includes("工具调用：bash"), true);
  assert.equal(text.message.content.includes("**出错**"), true);
  assert.equal(text.message.content.includes("mystery"), true);
  assert.equal(text.replyTo, "entry-3");
  assert.equal(JSON.stringify(tail.value).includes("should-not-appear"), false);
  assert.equal(JSON.stringify(tail.value).includes("\"raw\":true"), false);
  assert.equal(widget.message.widget.options[0].label, "接受部分交付");
  assert.equal(widget.message.widget.options[1].value, "reject");
  assert.equal(form.message.formRequest.fields[0].id, "answer");
  for (let i = 0; i < 8 && text.message.images?.[0]?.url !== "data:image/png;base64,AQID"; i++) await new Promise(setImmediate);
  assert.equal(text.message.images[0].url, "data:image/png;base64,AQID");
  const push = (event: any) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  push({ type: "text_delta", data: "第一段" });
  push({ type: "text_delta", data: "第二段" });
  push({ type: "thinking_delta", data: "hidden" });
  push({ type: "message", message: { seq: 9, role: "assistant", text: "最终答复", at: 90 } });
  await new Promise(setImmediate);
  const snapshot = () => b.events.filter((e) => e.family === "transcript").at(-1).payload.entries;
  const live = snapshot().filter((entry: any) => entry.streaming);
  assert.equal(live.length, 0);
  assert.equal(snapshot().filter((entry: any) => entry.message?.content === "第一段第二段").length, 0);
  assert.equal(snapshot().find((entry: any) => entry.id === "entry-9").message.content, "最终答复");
  const again = await b.request("getAgentTranscriptTail", { id: "e1" });
  assert.equal(again.value.entries[0].message.content, text.message.content);
  assert.equal(again.value.entries[1].message.type, "widget");
  const approved = await b.request("respondToWidget", { agentId: "e1", entryId: "entry-7:task:task1", value: "approve" });
  assert.equal(approved.status, "ok");
  const approveRequest = b.requests.filter((request) => request.url.endsWith("control")).at(-1);
  assert.ok(approveRequest);
  assert.equal(approveRequest.body.approved, true);
  const answered = await b.request("submitUserForm", { agentId: "e1", entryId: "entry-8:task:task2", values: { answer: "8080" } });
  assert.equal(answered.status, "ok");
  const answerRequest = b.requests.filter((request) => request.url.endsWith("control")).at(-1);
  assert.ok(answerRequest);
  assert.equal(answerRequest.body.text, "8080");
  const before = b.requests.filter((request) => request.url.endsWith("control")).length;
  assert.equal((await b.request("dismissUserForm", { agentId: "e1", entryId: "entry-8:task:task2" })).status, "ok");
  assert.equal(b.requests.filter((request) => request.url.endsWith("control")).length, before);
  assert.equal((await b.request("sendPrompt", { agentId: "e1", prompt: "接着说", clientNonce: "fixture-quote-nonce01", replyToId: "entry-7" })).value.accepted, true);
  const quoteRequest = b.requests.at(-1);
  assert.ok(quoteRequest);
  assert.equal(quoteRequest.body.quoteSeq, 7);
  assert.equal((await b.request("sendPrompt", { agentId: "e1", prompt: "看图", clientNonce: "fixture-image-nonce01", attachments: [{ mime: "image/png", data: "AQID" }] })).value.accepted, true);
  const imageRequest = b.requests.at(-1);
  assert.ok(imageRequest);
  assert.equal(imageRequest.body.images[0].mime, "image/png");
  assert.equal((await b.request("sendPrompt", { agentId: "e1", prompt: "路径", clientNonce: "fixture-path-nonce001", attachmentPaths: ["C:/secret"] })).status, "failed");
  b.listeners.pagehide({});
  controller.close();
});

test("settings markup follows the signed-in role and escapes stored text", async () => {
  const operator = { role: "operator", admin: false, bots: [{ id: "e1", name: "测试", instruction: "</textarea><script>", cwd: "", idleMinutes: 10, takeoverSeconds: 15, editable: true }] };
  const page = bridge(true, false, (url, body) => ({ ok: body.save !== "scenes", status: 403, json: async () => body.save === "scenes" ? { statusMessage: "Administrator permission required" } : url.endsWith("settings") ? operator : { employees: [] } }));
  const html = await page.desktop.main.openVegaSettings();
  assert.equal(html.includes("普通用户"), true);
  assert.equal(html.includes("&lt;/textarea&gt;&lt;script&gt;"), true);
  assert.equal(html.includes("保存工作原则"), true);
  assert.equal(html.includes("只有管理员可以修改"), true);
  assert.equal(html.includes("保存场景"), false);
  assert.equal(html.includes("已停用的工作职责"), true);
  await assert.rejects(page.desktop.main.saveVegaSceneSettings({ scenes: {} }), /Administrator/);
  const admin = bridge(true, false, (url) => ({ ok: true, json: async () => url.endsWith("settings") ? {
    role: "admin", admin: true, bots: [], scheduler: { globalSlots: 4, perEmployeeSlots: 2 },
    scenes: { lightweight: [{ model: "demo/fast", allowSpawn: true }], coding: [], computer: [{ model: "demo/fast", allowSpawn: false }] },
    providers: [{ id: "demo", name: "示例" }], models: [{ id: "demo/fast", name: "Fast", supportsImages: true }],
  } : { employees: [] } }));
  const adminHtml = await admin.desktop.main.openVegaSettings();
  assert.equal(adminHtml.includes("管理员"), true);
  assert.equal(adminHtml.includes("保存场景"), true);
  assert.equal(adminHtml.includes("demo/fast"), true);
  assert.equal(adminHtml.includes("示例"), true);
  assert.equal(adminHtml.includes("value=\"4\""), true);
});

test("all embedded stylesheets parse without truncated rules or displaced prefixes", () => {
  const directory = join(resources, "assets");
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".css"))) {
    const css = readFileSync(join(directory, name), "utf8");
    assert.match(css.trimStart(), /^[.@:#*a-z]/, name);
    assert.doesNotMatch(css, /\u0000|\uFFFD/, name);
    assert.doesNotThrow(() => postcss.parse(css, { from: name }), name);
  }
});

for (const name of readdirSync(join(resources, "assets")).filter((name) => name.endsWith(".woff2"))) {
 test(`${name} has a valid WOFF2 directory and complete compressed payload`, () => {
  const font = readFileSync(join(resources, "assets", name));
  assert.equal(font.toString("ascii", 0, 4), "wOF2");
  assert.equal(font.length, font.readUInt32BE(8));
  let offset = 48, decodedLength = 0;
  const uint128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = font[offset++];
      value = value * 128 + (byte & 127);
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid WOFF2 table length");
  };
  for (let i = 0; i < font.readUInt16BE(12); i++) {
    const flags = font[offset++], tag = flags & 63, version = flags >> 6;
    if (tag === 63) offset += 4;
    const original = uint128();
    decodedLength += ((tag === 10 || tag === 11) ? version === 0 : version !== 0) ? uint128() : original;
  }
  const end = offset + font.readUInt32BE(20);
  assert.equal(brotliDecompressSync(font.subarray(offset, end)).length, decodedLength);
  assert(font.subarray(end).every((byte) => byte === 0), "WOFF2 alignment padding must be zero");
 });
}
