import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { credentialValues } from "../server/core/credentials";
import { Redactor } from "../server/core/util";
import { employeeCall, vaultCall } from "./public-call";

const decision = (allowed: boolean, reason = "匹配当前用途", pageUrl?: string) => ({ role: "assistant" as const, calls: [{ id: "check", name: "check_credential_use", arguments: { allowed, reason, ...(pageUrl ? { pageUrl } : {}) } }] });
function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/light"], coding: ["fixture/light"], computer: ["fixture/light"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  engine.catalog.resolve = async () => ({ selection: "fixture/light" } as any);
  // The vault belongs to an employee, so the checks run in a personal employee's own chat session.
  const owner = engine.employee.for(engine.employee.create({ name: "Owner" }, "owner").id);
  const session = store.newSession({ cwd: ".", scene: "computer", employeeId: owner.employeeId });
  store.append(session.id, { role: "user", text: "按当前任务的授权检查系统，不尝试其他系统账号" });
  engine.browsers.peek = () => engine.chrome as any;
  const tools = new Tools(engine, session, engine.config(session), new AbortController().signal, () => {});
  const get = (id: string, text = "当前任务需要核对授权信息") => tools.execute({ id: "get", ...vaultCall({ action: "get", id, text }) }, { supportsImages: true } as any);
  return { store, engine, session, tools, get, vault: owner.vault };
}

test("natural-language usage conditions need no website field and the verifier never receives credential contents", async () => {
  const { store, engine, get, vault } = fixture();
  const entry = vault.save({ name: "审批账号", condition: "仅用于已授权的审批客户端核对待办", content: "example-private-password" });
  try {
    engine.providers.chat = async (_model, system, messages, tools) => {
      assert(system.includes("不要求网站名") && system.includes("OA和合作伙伴认证"));
      const input = JSON.parse(messages[0].text!);
      assert.deepEqual(input.credential, { name: "审批账号", condition: "仅用于已授权的审批客户端核对待办" });
      assert(!JSON.stringify(messages).includes("example-private-password"));
      assert.equal(tools.length, 1);
      return decision(true);
    };
    const result = await get(entry.id, "用户授权在审批客户端核对待办，符合只读核对条件");
    assert.equal(JSON.parse(result.secret!).content, "example-private-password");
    assert.equal(JSON.parse(result.secret!).scopeSite, "");
    assert(!JSON.stringify(result.value).includes("example-private-password"));
    assert.equal(vault.list()[0].site, undefined);
  } finally { await engine.close(); store.close(); }
});

test("a different actual login system rejects the requested credential before decrypting it", async () => {
  const { store, engine, session, get, vault } = fixture();
  const entry = vault.save({ name: "DataBrain", condition: "仅用于 DataBrain Email Login，不适用于 OA 或合作伙伴登录", content: "do-not-release" });
  engine.chrome.observations.set(session.id + ":tab", { tabTag: "tab", pages: [{ url: "https://partner.example/login?ticket=private", title: "Partner Authentication Center", visibleText: "Tencent Partner Password Login" }] } as any);
  try {
    engine.providers.chat = async (_model, _system, messages) => {
      const input = JSON.parse(messages[0].text!);
      assert.equal(input.pages[0].url, "https://partner.example/login");
      assert(input.pages[0].text.includes("Partner"));
      assert(!JSON.stringify(messages).includes("do-not-release"));
      return decision(false, "当前是合作伙伴认证，不是 DataBrain 邮箱登录");
    };
    await assert.rejects(get(entry.id, "处理 DataBrain 任务，现在需要登录"), /合作伙伴认证/);
    assert.equal(store.object<any>(vault.kind, entry.id).usedAt, undefined);
  } finally { await engine.close(); store.close(); }
});

test("invalid or ambiguous condition checks fail closed instead of trying another account", async () => {
  for (const reply of [{ role: "assistant", text: "seems fine" }, decision(false, "无法判断适用的账号"), { role: "assistant", calls: [{ id: "bad", name: "check_credential_use", arguments: { allowed: "yes", reason: "guess" } }] }]) {
    const { store, engine, get, vault } = fixture();
    try {
      const entry = vault.save({ name: "account", condition: "only authorized operation", content: "not-released" });
      engine.providers.chat = async () => reply as any;
      await assert.rejects(get(entry.id));
      assert.equal(store.object<any>(vault.kind, entry.id).usedAt, undefined);
    } finally { await engine.close(); store.close(); }
  }
});

test("approved website context is derived from the observed page, never from a required vault configuration", async () => {
  const { store, engine, session, get, vault } = fixture();
  const entry = vault.save({ name: "account", condition: "当前业务站的邮箱登录", content: "账号：sample@example.test\n密码：password-example" });
  engine.chrome.observations.set(session.id + ":tab", { tabTag: "tab", pages: [{ url: "https://business.example/login", title: "Email Login", visibleText: "Email Password" }] } as any);
  try {
    engine.providers.chat = async () => decision(true, "已观察的业务站邮箱登录符合条件");
    const result = await get(entry.id, "登录业务站邮箱入口");
    assert.equal(JSON.parse(result.secret!).scopeSite, "https://business.example");
    assert.equal(vault.list()[0].site, undefined);
    assert.equal(store.object<any>(vault.kind, entry.id).scopeSite, undefined, "approval context is not permanent configuration");
  } finally { await engine.close(); store.close(); }
});

test("condition edits during verification invalidate the approval before a secret is read", async () => {
  const { store, engine, get, vault } = fixture();
  const entry = vault.save({ name: "account", condition: "old condition", content: "keep-encrypted" });
  try {
    engine.providers.chat = async () => {
      vault.save({ id: entry.id, name: "account", condition: "new restriction", content: "" });
      return decision(true);
    };
    await assert.rejects(get(entry.id), /条件已变化/);
    assert.equal(store.object<any>(vault.kind, entry.id).usedAt, undefined);
    assert.equal(vault.get(entry.id, "explicit direct test").content, "keep-encrypted");
  } finally { await engine.close(); store.close(); }
});

test("employee task vault reads pass the same semantic check before releasing a secret", async () => {
  const { store, engine } = fixture();
  const employee = engine.employee.for(engine.employee.create({ name: "Worker" }, "owner").id);
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "在授权客户端只读核对待办" });
    employee.update((state) => { state.tasks[0].status = "running"; });
    const session = store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, scene: "computer" });
    employee.busy.set(created.value.id, { session: session.id, computer: true });
    const tools = new Tools(engine, session, engine.config(), new AbortController().signal, () => {});
    const entry = employee.vault.save({ name: "account", condition: "仅用于授权客户端只读核对", content: "private-value" });
    const call = { id: "get", ...employeeCall({ action: "vault_get", id: entry.id, text: "按任务授权核对待办" }) };
    engine.providers.chat = async () => decision(false, "需要确认客户端类型");
    await assert.rejects(tools.execute(call, { supportsImages: true } as any), /客户端类型/);
    assert.equal(store.object<any>(employee.vault.kind, entry.id).usedAt, undefined);
    engine.providers.chat = async () => decision(true);
    assert.equal(JSON.parse((await tools.execute(call, { supportsImages: true } as any)).secret!).content, "private-value");
    employee.busy.clear();
    engine.providers.chat = async () => { throw Error("inactive task must not reach credential verification"); };
    await assert.rejects(tools.execute(call, { supportsImages: true } as any), /Task is no longer running/);
  } finally { employee.busy.clear(); await engine.close(); store.close(); }
});

test("encrypted support retains original usage conditions and task limits, without requiring a website", () => {
  const first = new Store(":memory:"), second = new Store(":memory:"), source = new Vault(first), receiver = new Vault(second);
  try {
    const saved = source.save({ name: "account", condition: "仅用于只读核对审批待办", content: "shared-secret", share: true });
    const pk = receiver.request("task"), sealed = source.sealFor(saved.id, "task", pk);
    const received = receiver.receive("task", "authorized task", sealed.sealed);
    assert.match(receiver.list()[0].condition, /仅用于只读核对审批待办/);
    assert.throws(() => receiver.get(received.id, "operation", "other"), /another task/);
    assert.equal(receiver.get(received.id, "operation", "task").content, "shared-secret");
    const entry = second.object<any>("vault", received.id);
    second.save("vault", received.id, { ...entry, createdAt: Date.now() - 86400001 });
    assert.throws(() => receiver.get(received.id, "operation", "task"), /expired/);
  } finally { first.close(); second.close(); }
});

test("credential components are redacted in audit copies without replacing actual tool inputs", () => {
  for (const content of ['账号：sample@example.test\n密码：password-example', '{"username":"sample@example.test","password":"password-example"}']) {
    const values = credentialValues(content), redactor = new Redactor();
    assert(values.includes("sample@example.test") && values.includes("password-example"));
    values.forEach((value) => redactor.add(value));
    const action = { action: "fill", text: "sample@example.test" };
    assert.equal(redactor.value(action).text, "[credential redacted]");
    assert.equal(action.text, "sample@example.test");
  }
});
