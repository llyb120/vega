import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

const source = readFileSync("local/grok_ui/vega-bridge.js", "utf8");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function bridge(respond: (op: string, body: any) => any = () => ({})) {
  const calls: any[] = [], storage = new Map<string, string>(), events: any[] = [];
  class Reader {
    result: string | null = null;
    onload?: () => void;
    readAsDataURL(blob: Blob) { blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,` + Buffer.from(bytes).toString("base64"); this.onload?.(); }); }
  }
  const context: any = {
    URL, Blob, Uint8Array, FileReader: Reader, crypto: webcrypto, atob, console,
    location: new URL("http://127.0.0.1:47673/assistant/fixture/"), navigator: { language: "en" },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    matchMedia: () => ({ matches: false }), setInterval() {}, setTimeout,
    addEventListener() {}, document: { visibilityState: "visible", addEventListener() {} },
    fetch: async (url: URL, init: any) => {
      const op = url.pathname.split("/").at(-1), body = JSON.parse(init.body);
      calls.push([op, body]);
      const value = op === "host" ? { paired: true, account: "fixture", version: "test" } : await respond(op!, body);
      return { ok: true, json: async () => value };
    },
  };
  context.window = context;
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, "window.fixture = { coordinator, poll, entriesOf, boot, ports, resizeEdge };})();"), context);
  context.fixture.ports.add({ postMessage: (value: any) => events.push(plain(value)) });
  return { ...context.fixture, desktop: context.desktop, windowChanged: context.__vegaWindowChanged, calls, events, storage };
}

test("the embedded renderer assets remain byte-identical to the installed Grok build", () => {
  const manifest = JSON.parse(readFileSync("local/grok_ui/source-manifest.json", "utf8"));
  assert.equal(manifest.product, "Grok Bot");
  assert(manifest.files.length > 600);
  for (const entry of manifest.files) {
    if (entry.file === "index.html") continue; // Only the preload scripts and CSP are adapted.
    const bytes = readFileSync("local/grok_ui/" + entry.file);
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.file);
  }
  const index = readFileSync("local/grok_ui/index.html", "utf8");
  assert(index.indexOf("vega-bridge.js") < index.indexOf('type="module"'));
  assert.match(index, /connect-src 'self';/);
  assert.match(index, /id="root"/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/, "the adapter does not repaint or replace Grok's components");
});

test("WebView2 forwards all resize edges and disables them while maximized", () => {
  const b = bridge();
  for (const [x, y, edge] of [[0, 0, 13], [999, 0, 14], [0, 799, 16], [999, 799, 17], [0, 400, 10], [999, 400, 11], [500, 0, 12], [500, 799, 15], [500, 400, 0]])
    assert.equal(b.resizeEdge(x, y, 1000, 800), edge);
  b.windowChanged({ isFullscreen: false, isMaximized: true });
  assert.equal(b.resizeEdge(0, 0, 1000, 800), 0);
});

test("tail pagination keeps the server cursor even when the last rows are tools; read state is forwarded", async () => {
  const b = bridge(op => op === "messages" ? { messages: [{ seq: 9, role: "assistant", text: "tail" }, { seq: 10, role: "tool", text: "tool" }], hasMore: true } : {});
  const page = await b.coordinator("openAgentTail", { agentId: "employee:e1" });
  assert.equal(page.nextBeforeSeq, 9);
  await b.desktop.main.setViewingAgent({ agentId: "employee:e1" });
  await b.poll();
  assert(b.calls.some(([op, body]: any[]) => op === "read" && body.thread === "employee:e1"));
  assert(b.calls.some(([op, body]: any[]) => op === "messages" && body.after === 10));
  await b.coordinator("getAgentTranscriptTail", { agentId: "employee:e1", beforeSeq: 9 });
  assert.equal(b.calls.at(-1)[1].before, 9);
});

test("history rollback clears the original transcript replica instead of waiting on a stale cursor", async () => {
  const b = bridge((op, body) => op === "messages" ? body.after ? { messages: [], lastSeq: 0 } : { messages: [{ seq: 10, role: "assistant", text: "old" }] } : {});
  await b.boot;
  await b.coordinator("openAgentTail", { agentId: "employee:e1" });
  await b.desktop.main.setViewingAgent({ agentId: "employee:e1" });
  await b.poll(); await b.poll();
  assert.equal(b.events.filter((e: any) => e.family === "transcript" && e.payload.type === "cleared").length, 1);
});

test("sending a nonce is single-flight, and an uncertain failure is not automatically replayed", async () => {
  let sends = 0;
  const b = bridge(op => { if (op === "send") { sends++; throw Error("connection lost after dispatch"); } return {}; });
  const args = { agentId: "employee:e1", prompt: "once", clientNonce: "a".repeat(32) };
  await assert.rejects(b.coordinator("sendPrompt", args), /connection lost/);
  await assert.rejects(b.coordinator("sendPrompt", args), /connection lost/);
  assert.equal(sends, 1);
  assert.equal(b.calls.find(([op]: any[]) => op === "send")[1].clientMessageId, args.clientNonce);
});

test("new bots return the original creation contract, never a simulated success for unavailable features", async () => {
  const b = bridge(op => op === "create" ? { id: "e2" } : op === "threads" ? { employees: [{ thread: "employee:e2", name: "New Bot" }] } : {});
  const value = await b.coordinator("createAgent", { name: "New Bot" });
  assert.equal(value.agent.id, "employee:e2");
  assert.deepEqual(plain(value.transcript), []);
  await assert.rejects(b.coordinator("notImplemented"), /尚未接入/);
  await assert.rejects(b.desktop.main.openExternal({ url: "file:///private" }), /Only HTTP/);
});

test("the original attachment staging contract forwards file/image bytes and renders artifact references", async () => {
  const b = bridge(op => op === "file" ? { data: Buffer.from("artifact").toString("base64"), mime: "text/plain" } : {});
  const file = await b.desktop.local.stageAttachmentFile("C:\\tmp\\notes.txt", new Blob(["hello"], { type: "text/plain" }));
  assert.equal(file.ok, true);
  const paths = await b.desktop.main.commitStagedAttachments({ paths: [file.path] });
  await b.coordinator("sendPrompt", { agentId: "employee:e1", prompt: "", attachmentPaths: paths, clientNonce: "b".repeat(32) });
  assert.deepEqual(b.calls.find(([op]: any[]) => op === "send")[1].files, [{ name: "notes.txt", mime: "text/plain", data: "aGVsbG8=" }]);
  const id = "blob-" + "a".repeat(32);
  const entries = b.entriesOf([{ seq: 1, role: "assistant", text: "continue", stepOutput: { text: "full artifact", files: [{ blobId: id, name: "app.zip", size: 7 }] } }], "employee:e1");
  assert.equal(entries[0].kind, "user-attachment");
  assert.equal(entries[0].file_name, "app.zip");
  assert.equal(entries[1].content, "continue\n\nfull artifact");
  const bytes = await b.desktop.main.readAttachmentBytes({ path: entries[0].file_path });
  assert.equal(Buffer.from(bytes.bytes).toString(), "artifact");
  await assert.rejects(b.desktop.main.readAttachmentBytes({ path: "C:/private.txt" }), /Unknown attachment/);
  const oversized = await b.desktop.local.stageAttachmentFile("huge", new Blob([new Uint8Array((25 << 20) + 1)]));
  assert.equal(oversized.ok, false);
  await b.desktop.main.discardStagedAttachment({ path: file.path });
  await assert.rejects(b.desktop.main.commitStagedAttachments({ paths: [file.path] }), /已失效/);
});

test("history renders the message shapes the server actually stores, and a finished stream is not shown twice", () => {
  const b = bridge();
  const entries = b.entriesOf([
    { seq: 2, role: "user", displayText: "visible", text: "hidden", quote: { role: "assistant", text: "earlier" } },
    { seq: 3, role: "assistant", notice: true, text: "joined", error: true },
    { seq: 4, role: "assistant", text: "use the tool", calls: [{ id: "c1", name: "bash", arguments: { cmd: "ls", apiKey: "sek" } }] },
    { seq: 5, role: "tool", callId: "c1", name: "bash", text: "ok" },
    { seq: 6, role: "mystery", text: "odd payload" },
    { seq: 7, role: "assistant", delivery: true, text: "please confirm", tasks: [{ id: "t1", title: "ship", status: "approval" }] },
    { seq: 8, role: "assistant", delivery: true, text: "need detail", tasks: [{ id: "t2", title: "ask", status: "waiting" }] },
    { seq: 9, role: "assistant", delivery: true, text: "finished", tasks: [{ id: "t3", title: "old", status: "done" }] },
    { seq: 10, role: "system", newSession: true, text: "新会话开始" },
  ], "employee:e1", { at: 50, text: "hello", thinking: "hmm", progress: "reading", tools: [{ id: "c2", name: "read", status: "running" }] });
  for (const entry of entries) assert.equal(["message", "notice", "send-message", "user-attachment"].includes(entry.kind), true, entry.kind);
  assert.equal(entries.find((entry: any) => entry.seq === 2).content, "> earlier\n\nvisible");
  assert.equal(entries.find((entry: any) => entry.seq === 3 && entry.kind === "notice").tone, "error");
  const call = entries.find((entry: any) => String(entry.id).endsWith(":call:c1"));
  assert.match(call.content, /bash/);
  assert.match(call.content, /已隐藏/);
  assert.equal(call.content.includes("sek"), false);
  assert.match(entries.find((entry: any) => entry.seq === 5).content, /ok/);
  assert.match(entries.find((entry: any) => entry.seq === 6).text, /未识别/);
  const approval = entries.find((entry: any) => String(entry.id).endsWith(":ask:t1"));
  assert.equal(approval.respondedValue, undefined);
  assert.equal(approval.message.widget.options.map((option: any) => option.value).join(","), "vega:approve,vega:reject");
  const waiting = entries.find((entry: any) => String(entry.id).endsWith(":ask:t2"));
  assert.equal(waiting.message.widget.allowCustom, true);
  assert.equal(waiting.message.widget.options.length > 0, true);
  assert.equal(entries.find((entry: any) => String(entry.id).endsWith(":ask:t3")).respondedValue, "已完成");
  const live = entries.at(-1);
  assert.equal(live.isStreaming, true);
  assert.match(live.content, /hello/);
  assert.match(live.content, /hmm/);
  assert.match(live.content, /read/);
  const stored = b.entriesOf([{ seq: 1, role: "assistant", text: "hello world" }], "employee:e1", { text: "hello", thinking: "", tools: [] });
  assert.equal(stored.some((entry: any) => String(entry.id).endsWith(":live")), false);
  assert.equal(stored[0].content, "hello world");
});

test("polling keeps one live bubble and drops it when the same reply is stored", async () => {
  let step = 0;
  const b = bridge((op, body) => {
    if (op !== "messages") return {};
    if (!body.after) return { messages: [{ seq: 1, role: "assistant", text: "ready", at: 10 }], lastSeq: 1, live: { at: 11, text: "partial", thinking: "", tools: [] } };
    step += 1;
    if (step === 1) return { messages: [], lastSeq: 1, live: { at: 11, text: "partial reply", thinking: "", tools: [] } };
    return { messages: [{ seq: 2, role: "assistant", text: "partial reply", at: 12 }], lastSeq: 2, live: null };
  });
  await b.boot;
  const page = await b.coordinator("openAgentTail", { agentId: "employee:e1" });
  assert.equal(page.entries.some((entry: any) => entry.isStreaming), true);
  await b.desktop.main.setViewingAgent({ agentId: "employee:e1" });
  await b.poll();
  const updates = b.events.filter((event: any) => event.family === "transcript" && String(event.payload.entry?.id || "").endsWith(":live"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.type, "updated");
  await b.poll();
  assert.equal(b.events.filter((event: any) => event.family === "transcript" && event.payload.type === "removed").length, 1);
  assert.equal(b.events.filter((event: any) => event.family === "transcript" && event.payload.type === "appended" && event.payload.entry?.content === "partial reply").length, 1);
});

test("a pending card resolves in place, and widget actions hit the real control route", async () => {
  const b = bridge((op, body) => op === "messages" && !body.after ? { messages: [{ seq: 4, role: "assistant", delivery: true, text: "please confirm", at: 4, tasks: [{ id: "t1", title: "ship", status: "approval" }] }], lastSeq: 4, taskStatus: { t1: "approval" } } : { messages: [], lastSeq: 4, taskStatus: { t1: "running" } });
  await b.boot;
  await b.coordinator("openAgentTail", { agentId: "employee:e1" });
  await b.desktop.main.setViewingAgent({ agentId: "employee:e1" });
  await b.poll();
  const updated = b.events.filter((event: any) => event.family === "transcript" && event.payload.type === "updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].payload.entry.respondedValue, "进行中");
  await b.coordinator("respondToWidget", { agentId: "employee:e1", entryId: "employee:e1:4:ask:task1", value: "vega:reject" });
  await b.coordinator("respondToWidget", { agentId: "employee:e1", entryId: "employee:e1:5:ask:task2", value: "补充一下" });
  await assert.rejects(b.coordinator("respondToWidget", { agentId: "employee:e1", entryId: "employee:e1:5:ask:task2", value: "\u0000custom" }), /输入框/);
  await assert.rejects(b.coordinator("dismissWidget", { agentId: "employee:e1", entryId: "employee:e1:5:ask:task2" }), /尚未接入/);
  const controls = b.calls.filter(([op]: any[]) => op === "control").map(([, body]: any[]) => body);
  assert.deepEqual(controls, [
    { thread: "employee:e1", id: "task1", action: "approve", approved: false },
    { thread: "employee:e1", id: "task2", action: "answer", text: "补充一下" },
  ]);
});

test("the bot profile editor saves the real name and work principle", async () => {
  const b = bridge((op, body) => {
    if (op === "settings") return { employee: { name: body.name, instruction: body.instruction } };
    if (op === "threads") return { employees: [{ thread: "employee:e1", name: body.name || "Renamed", instruction: "careful" }] };
    return {};
  });
  const saved = await b.desktop.main.updateGrokBotAgent({ serverId: "employee:e1", changed: { name: "Renamed", description: "careful" } });
  assert.equal(b.calls.find(([op]: any[]) => op === "settings")[1].employeeId, "e1");
  assert.equal(b.calls.find(([op]: any[]) => op === "settings")[1].instruction, "careful");
  assert.equal(saved.description, "careful");
  await assert.rejects(b.desktop.main.updateGrokBotAgent({ serverId: "employee:e1", changed: { publicDescription: "other" } }), /公开/);
  await assert.rejects(b.desktop.main.updateGrokBotAgent({ serverId: "employee:e1", avatarPngBase64: "xx", changed: { name: "Renamed" } }), /头像/);
});
