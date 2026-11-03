import { test } from "node:test";
import assert from "node:assert/strict";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Tools } from "../server/core/tools";
import { credentialValues, type CredentialBinding } from "../server/core/credentials";
import { chromeCall, vaultCall } from "./public-call";

const site = "https://databrain.example", other = "https://partner.example";
const credentials: CredentialBinding[] = [{ site, values: credentialValues("账号：sample@example.test\n密码：password-example") }];
function fixture() {
  const store = new Store(":memory:"), bridge = new ChromeBridge(), chrome = new Chrome(store, bridge, "");
  const sent: any[] = [], urls = new Map([[1, site], [2, other]]);
  const observation: any = {
    id: "snapshot", tabTag: "tab", frames: [{ id: "main", context: 1 }, { id: "child", context: 2, parent: "main" }],
    pages: [{ url: site, items: [{ ref: "email", name: "Email", tag: "input", role: "textbox", inView: true, editable: true }], focus: { identity: 1 } }, { url: other, items: [{ ref: "child-email", name: "Partner email", tag: "input", role: "textbox", inView: true, editable: true }], focus: { identity: 1 } }],
    images: [], coverageGaps: [], captured: Date.now(), fullPage: false, screenshot: false,
  };
  chrome.observations.set("owner:tab", observation);
  (bridge as any).request = async () => ({ tabs: [{ tag: "tab", active: true, controllable: true }] });
  (chrome as any).evaluate = async (_tag: string, frame: any, expression: string) => {
    if (expression === "location.href") return urls.get(frame.context);
    if (expression.includes("inputState")) return { editable: true, matches: true, identity: 1 };
    if (expression.startsWith("__novaWebview.verifyValue(")) {
      const [, expected] = JSON.parse("[" + expression.slice("__novaWebview.verifyValue(".length, -1) + "]");
      return { matches: sent.findLast((event) => event.method === "Input.insertText")?.text === expected };
    }
    return {};
  };
  (chrome as any).point = async () => ({ x: 10, y: 10, localX: 10, localY: 10, localRect: {}, editable: true, identity: 1 });
  (chrome as any).frameFocused = async (_observation: any, frame: number) => frame === 0;
  (chrome as any).mouse = async () => sent.push({ method: "mouse" });
  (chrome as any).key = async (_tag: string, key: string) => sent.push({ method: "key", key });
  (chrome as any).cdp = async (_tag: string, method: string, args: any) => { sent.push({ method, ...args }); return {}; };
  (chrome as any).feedback = async () => ({ tabTag: "tab", pages: [], images: [] });
  return { store, chrome, observation, sent, urls };
}

test("redacted placeholders are rejected before any action in a batch, run plan or evaluated script", async () => {
  const { store, chrome, sent } = fixture();
  try {
    for (const text of ["[credential redacted]", "[redacted]", "__stored_secret__", "[withheld from transcript; available only to current turn]"]) {
      const result = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", actions: [{ action: "click", ref: "email" }, { action: "fill", ref: "email", text }] });
      assert.equal(result.status, "not_executed");
      assert.equal(result.inputAttempted, false);
      assert.match(result.reason, /占位符/);
      await assert.rejects(chrome.execute("owner", ".", { operation: "run", tabTag: "tab", plan: { task: "login", steps: [{ action: "click", name: "Email" }, { action: "fill", name: "Email", text }] } }), /占位符/);
      await assert.rejects(chrome.execute("owner", ".", { operation: "evaluate", tabTag: "tab", expression: `document.querySelector('input').value=${JSON.stringify(text)}` }), /占位符/);
    }
    assert.deepEqual(sent, []);
  } finally { store.close(); }
});

test("credential fill checks the live URL, not a stale observation, and refuses a different SSO frame", async () => {
  const { store, chrome, sent, urls } = fixture();
  try {
    urls.set(1, other);
    let result = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", action: { action: "fill", ref: "email", text: "sample@example.test" }, visual: "none" }, undefined, credentials);
    assert.equal(result.status, "not_executed"); assert.equal(result.inputAttempted, false);
    assert.match(result.reason, /当前页面/);
    assert.equal(sent.length, 0);
    urls.set(1, site);
    result = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", action: { action: "fill", ref: "child-email", text: "password-example" }, visual: "none" }, undefined, credentials);
    assert.equal(result.status, "not_executed");
    assert.equal(sent.length, 0);
    result = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", action: { action: "fill", ref: "email", text: "sample@example.test" }, visual: "none" }, undefined, credentials);
    assert.equal(result.status, "executed", result.reason);
    assert.equal(sent.find((event) => event.method === "Input.insertText")?.text, "sample@example.test", "actual input is not replaced with a redacted label");
  } finally { store.close(); }
});

test("typing, evaluated inputs and guided fill all enforce the bound site while ordinary non-secret text remains usable", async () => {
  const { store, chrome, sent, urls } = fixture();
  try {
    urls.set(1, other);
    const typed = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", action: { action: "type", text: "password-example" }, visual: "none" }, undefined, credentials);
    assert.equal(typed.status, "not_executed");
    await assert.rejects(chrome.execute("owner", ".", { operation: "evaluate", tabTag: "tab", expression: "document.querySelector('input').value='password-example'" }, undefined, credentials), /当前页面/);
    const run = await chrome.execute("owner", ".", { operation: "run", tabTag: "tab", visual: "none", plan: { task: "login", steps: [{ action: "fill", name: "Email", text: "sample@example.test" }] } }, undefined, credentials);
    assert.equal(run.altairRun.guided.completedSteps, 0);
    assert.equal(sent.length, 0);
    const plain = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", action: { action: "type", text: "ordinary search query" }, visual: "none" }, undefined, credentials);
    assert.equal(plain.status, "executed", plain.reason);
  } finally { store.close(); }
});

test("credentials read without page context must be rechecked; equal usernames on approved pages do not conflict", async () => {
  const { store, chrome, sent } = fixture();
  try {
    const action = { operation: "act", tabTag: "tab", action: { action: "fill", ref: "email", text: "sample@example.test" }, visual: "none" };
    const withoutUrl = await chrome.execute("owner", ".", action, undefined, [{ ...credentials[0], site: "" }]);
    assert.equal(withoutUrl.status, "not_executed");
    assert.equal(sent.length, 0);
    assert.match(withoutUrl.reason, /无需补网站配置/);
    const allowed = await chrome.execute("owner", ".", action, undefined, [{ ...credentials[0], site: "" }, ...credentials, { site: other, values: ["sample@example.test"] }]);
    assert.equal(allowed.status, "executed", allowed.reason);
  } finally { store.close(); }
});

test("a redirect after focusing the field is checked again before credential text is inserted", async () => {
  const { store, chrome, sent, urls } = fixture();
  try {
    (chrome as any).mouse = async () => { urls.set(1, other); };
    const result = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", action: { action: "fill", ref: "email", text: "password-example" }, visual: "none" }, undefined, credentials);
    assert.equal(result.status, "needs_review");
    assert.match(result.reason, /当前页面/);
    assert(!sent.some((event) => event.method === "Input.insertText"));
  } finally { store.close(); }
});

test("stopping after focus prevents credential insertion and the remaining batch", async () => {
  const { store, chrome, sent } = fixture();
  const control = new AbortController();
  try {
    (chrome as any).mouse = async () => { control.abort(Error("user stop")); };
    const result = await chrome.execute("owner", ".", { operation: "act", tabTag: "tab", actions: [{ action: "fill", ref: "email", text: "password-example" }, { action: "press", key: "Enter" }], visual: "none" }, control.signal, credentials);
    assert.match(result.reason, /user stop/);
    assert.equal(result.completedActions, 0);
    assert(!sent.some((event) => event.method === "Input.insertText" || event.method === "key"));
  } finally { store.close(); }
});

test("successful vault reads pass observed-page credential scope into Chrome for this execution only", async () => {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: {} });
  engine.catalog.resolve = async () => ({ selection: "fixture/model" } as any);
  engine.providers.chat = async () => ({ role: "assistant", calls: [{ id: "check", name: "check_credential_use", arguments: { allowed: true, reason: "当前用途符合邮箱登录条件" } }] });
  const session = store.newSession({ cwd: ".", scene: "computer" });
  let passed: CredentialBinding[] = [];
  (engine as any).chromeFor = async () => ({ execute: async (_owner: any, _cwd: any, _args: any, _signal: any, bindings: CredentialBinding[]) => { passed = bindings; return { images: [] }; } });
  try {
    const entry = engine.vault.save({ name: "account", condition: "email login", content: "账号：sample@example.test\n密码：password-example" });
    const tools = new Tools(engine, session, engine.config(), new AbortController().signal, () => {});
    await tools.execute({ id: "vault", ...vaultCall({ action: "get", id: entry.id, text: "login", url: site }) }, { supportsImages: true } as any);
    await tools.execute({ id: "browser", ...chromeCall({ operation: "inspect", tabTag: "tab" }) }, { supportsImages: true } as any);
    assert.equal(passed[0].site, site);
    assert(passed[0].values.includes("sample@example.test") && passed[0].values.includes("password-example"));
  } finally { await engine.close(); store.close(); }
});
