import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { validateMcpServer } from "../shared/mcp-config";
import { catalogContextModels, modelContext, serializeContextRules } from "../shared/context-rules";
import { maskedConfig, mergeSecrets } from "../server/core/config";
import { Vault } from "../server/core/vault";
import { Store } from "../server/core/store";

const settings = readFileSync("web/src/SettingsView.vue", "utf8");
const capabilities = readFileSync("web/src/EmployeeCapabilities.vue", "utf8");
const providers = readFileSync("web/src/ProviderSettings.vue", "utf8");
const vaultSettings = readFileSync("web/src/VaultSettings.vue", "utf8");
function vaultFunction(name: string, scope: any) {
  const source = vaultSettings.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
  assert(source, name);
  return runInNewContext(`(${source})`, scope);
}
function settingsFunction(name: string, scope: any) {
  const source = (["provider", "discover", "limitValue", "moveContextRule", "contextPreview"].includes(name) ? providers : ["saveMcp", "addMcp"].includes(name) ? capabilities : settings).match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
  assert(source, name);
  return runInNewContext(`(${source})`, scope);
}

test("model discovery uses the draft key or retains the unchanged saved key in either config format", async () => {
  for (const stored of [
    {},
    { apiKey: "saved-legacy-key" },
    { options: { apiKey: "saved-options-key" } },
    { apiKey: "legacy-key", options: { apiKey: "preferred-options-key" } },
  ]) {
    const original = structuredClone(stored);
    const masked = maskedConfig({ model: "", provider: { p: stored } }).provider.p;
    const requests: string[] = [];
    const scope: any = {
      draft: { value: masked }, id: { value: "p" }, name: { value: "Provider" },
      preset: { value: "openai-compatible" }, apiType: { value: "openai-completions" },
      baseURL: { value: "https://provider.example/v1" }, source: { value: undefined },
      apiKey: { value: masked.options?.apiKey || masked.apiKey || "" },
      modelMap: { value: {} }, contextRules: { value: [] }, options: { value: "{}" }, headers: { value: "{}" },
      catalogContextModels, serializeContextRules,
      copy: structuredClone, run: async (fn: any) => fn(), emit() {},
      props: { api: async (path: string, method: string, body: any) => {
        assert.equal(path, "/providers/discover", "discovery must not save the provider");
        assert.equal(method, "POST");
        assert.equal(body.id, "p");
        const raw = structuredClone(body.provider);
        mergeSecrets(raw, stored);
        requests.push(raw.options?.apiKey || raw.apiKey || "");
        return { models: { fixture: { name: "Fixture" } } };
      } },
    };
    scope.provider = settingsFunction("provider", scope);
    const discover = settingsFunction("discover", scope);
    const unchanged = scope.apiKey.value;
    await discover();
    assert.equal(requests.at(-1), stored.options?.apiKey || stored.apiKey || "");
    assert.equal(scope.apiKey.value, unchanged, "saved secrets must remain masked in the editor");
    const saved = { provider: { p: scope.provider() } };
    mergeSecrets(saved, { provider: { p: stored } });
    assert.equal(saved.provider.p.options?.apiKey || saved.provider.p.apiKey || "", requests.at(-1));
    for (const key of ["unsaved-current-key", ""]) {
      scope.apiKey.value = key;
      await discover();
      assert.equal(requests.at(-1), key, "an edited or cleared key must not fall back to the saved key");
    }
    assert.deepEqual(stored, original, "discovery must leave the persisted config unchanged");
  }
});

test("provider rules serialize, reorder and preserve manual overrides without rewriting catalog limits", async () => {
  const scope: any = {
    draft: { value: { keep: true } }, id: { value: "p" }, name: { value: "Provider" },
    preset: { value: "openai-compatible" }, apiType: { value: "openai-completions" },
    baseURL: { value: "https://provider.example/v1" }, source: { value: undefined }, apiKey: { value: "__stored_secret__" },
    options: { value: "{}" }, headers: { value: "{}" }, copy: structuredClone,
    contextRules: { value: [{ keyword: " haiku ", context: "100k" }, { keyword: "claude", context: "200K" }] },
    modelMap: { value: catalogContextModels({ alias: { name: "Claude Haiku", limit: { context: 400000, output: 32000 } } }) },
    modelContext, serializeContextRules,
  };
  const provider = settingsFunction("provider", scope), preview = settingsFunction("contextPreview", scope);
  let row = provider();
  assert.deepEqual(row.contextRules, [{ keyword: "haiku", context: 100000 }, { keyword: "claude", context: 200000 }]);
  assert.equal(row.models.alias.limit.context, 400000);
  assert.equal(row.models.alias.contextSource, "catalog");
  assert.match(preview("alias", row.models.alias), /100,000 tokens（规则：haiku）/);
  settingsFunction("moveContextRule", scope)(1, -1);
  assert.equal(scope.contextRules.value[0].keyword, "claude");
  assert.match(preview("alias", row.models.alias), /200,000 tokens（规则：claude）/);
  settingsFunction("limitValue", scope)("alias", "context", "64000");
  row = provider();
  assert.equal(row.models.alias.contextSource, undefined);
  assert.equal(row.models.alias.limit.output, 32000);
  assert.match(preview("alias", row.models.alias), /64,000 tokens（手动设置）/);
  scope.modelMap.value.alias.contextSource = "catalog";
  assert.match(preview("alias", scope.modelMap.value.alias), /200,000 tokens（规则：claude）/);
  assert.equal(provider().models.alias.limit.context, 64000, "allowing rules keeps the old window as fallback");
  scope.contextRules.value = [];
  assert.equal(Object.hasOwn(provider(), "contextRules"), false);
  scope.contextRules.value = [{ keyword: "haiku", context: "0" }];
  assert.throws(provider, /上下文规则/);
});

test("each MCP JSON keeps its complete config and stored secrets", async () => {
  const original = { model: "", provider: {}, mcp: { remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } }, local: { command: "node", args: ["service.mjs"], env: { TOKEN: "secret" }, cwd: "C:\\project", enabled: false } } };
  const masked = maskedConfig(original);
  let saved: any;
  const scope = { canEdit: { value: true }, base: "/employees/fixture", disposed: false, props: { api: async (path: string, method: string, next: any) => { assert.equal(path, "/employees/fixture/mcp"); assert.equal(method, "PUT"); saved = next; return {}; } }, mcp: { value: Object.fromEntries(Object.entries(masked.mcp!).map(([key, config]) => [key, JSON.stringify(config)])) }, refreshSkills: async () => ({ mcp: Object.entries(saved.mcp).map(([name, config]) => ({ name, config })) }), run: async (fn: any) => fn(), validateMcpServer, emit: () => {} };
  await settingsFunction("saveMcp", scope)();
  mergeSecrets(saved, original);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.mcp)), original.mcp);
  scope.mcp.value.remote = "{invalid";
  saved = undefined;
  await assert.rejects(settingsFunction("saveMcp", scope)(), /remote.*JSON/);
  assert.equal(saved, undefined, "invalid JSON must not partially save other services");
  scope.mcp.value.remote = "[]";
  await assert.rejects(settingsFunction("saveMcp", scope)(), /JSON 对象/);
  const duplicate = { value: "local" }, events: any[] = [];
  settingsFunction("addMcp", { canEdit: { value: true }, mcpName: duplicate, mcp: scope.mcp, emit: (...args: any[]) => events.push(args) })();
  assert.match(events[0][1], /已存在/);
  assert.equal(JSON.parse(scope.mcp.value.local).command, "node");
});

test("the vault belongs to every account's settings; MCP and skill editors stay with the employee", () => {
  assert.match(settings, /<PageHeader :title="admin \? '系统设置' : '设置'"/);
  assert.match(capabilities, /v-model="mcp\[key\]"[^>]*:aria-label="key \+ ' JSON配置'"/);
  assert(!settings.includes("saveMcp") && !settings.includes("/skills/upload"));
  assert(capabilities.includes('v-if="canEdit"') && capabilities.includes("v-else") && capabilities.includes("尚未配置 MCP"));
  assert.match(settings, /props\.admin \? ADMIN_SECTIONS : PERSONAL_SECTIONS/);
  assert.match(settings, /<VaultSettings :api="api" :user-id="userId" :employees="employees \|\| \[\]"/);
  assert.match(vaultSettings, /const base = "\/me\/vault"/);
  assert.match(vaultSettings, /@click="edit\(item\)"/);
  assert.match(vaultSettings, /@click="reset"/);
  assert.match(vaultSettings, /v-model="form.content" :required="!form.id"/);
  assert.match(vaultSettings, /form.id \? '保存修改' : '新增并加密保存'/);
  assert.match(vaultSettings, /value="all".*所有牛马/s);
  assert.match(vaultSettings, /value="specific".*指定牛马/s);
  const employeeSettings = readFileSync("web/src/EmployeeSettings.vue", "utf8");
  const app = readFileSync("web/src/App.vue", "utf8");
  assert(!/EmployeeVault|\['vault', '密码本'\]/.test(app), "the employee no longer has a vault tab");
  assert.match(app, /<SettingsView v-else-if="view === 'settings'"/);
  assert.match(app, /:employees="myEmployees"/);
  assert(!employeeSettings.includes("vaultIds") && !employeeSettings.includes("vaultEntries"));
  assert(!app.includes("vaultIds") && !app.includes("vaultEntries"));
});

test("MCP JSON validation rejects malformed transports and options", () => {
  for (const value of [null, [], "text", { url: "file:///secret" }, { command: "" }, { command: "node", url: "https://example.com" }, { command: "node", args: "script" }, { url: "https://example.com", headers: [] }, { command: "node", env: { TOKEN: 12 } }, { command: "node", enabled: "yes" }]) assert.throws(() => validateMcpServer(value, "service"));
  assert.doesNotThrow(() => validateMcpServer({ command: "node", args: [], env: {}, enabled: false }, "service"));
});

test("vault keeps the existing name/condition/content form and only saves the chosen scope", async () => {
  const form = { value: {} as any };
  vaultFunction("edit", { form })({ id: "entry", type: "login", name: "account", condition: "仅用于合作伙伴身份验证，不用于业务站邮箱登录", employees: ["e1"] });
  assert.equal(form.value.type, "login");
  assert.equal(form.value.condition, "仅用于合作伙伴身份验证，不用于业务站邮箱登录");
  assert.equal(form.value.content, "");
  assert.equal(form.value.employees.join(","), "e1");
  assert.equal(form.value.scope, "specific", "an entry limited to one employee reopens as 指定牛马");
  let body: any, path = "";
  form.value.scope = "all";
  await vaultFunction("save", { form, base: "/me/vault", selected: () => [], props: { api: async (p: string, _method: string, value: any) => { path = p; body = value; } }, run: async (fn: any) => fn(), reset() {}, load: async () => {}, emit() {}, disposed: false })();
  assert.equal(path, "/me/vault");
  assert.equal(body.employees.length, 0, "所有牛马 is stored as an empty scope, never as a stale list");
  assert.equal(body.condition, form.value.condition);
  assert.equal(body.content, "");
  // 「指定牛马」without a selection must not silently widen the entry to every employee.
  form.value.scope = "specific";
  body = undefined;
  const errors: string[] = [];
  await vaultFunction("save", { form, base: "/me/vault", selected: () => [], props: { api: async () => { throw Error("must not save"); } }, run: async (fn: any) => fn(), reset() {}, load: async () => {}, emit: (type: string, message: string) => { if (type === "error") errors.push(message); }, disposed: false })();
  assert.equal(body, undefined);
  assert.match(errors[0], /至少一个牛马/);
  assert(!vaultSettings.includes('v-model="form.site"'));
});

test("vault adds multiple entries and edits only the chosen one without exposing secrets", async () => {
  const store = await Store.open(":memory:"), vault = new Vault(store);
  try {
    const first = await vault.save({ name: "account", condition: "first task", content: "secret-one" });
    const second = await vault.save({ name: "account", condition: "second task", content: "secret-two" });
    assert.notEqual(first.id, second.id);
    assert.equal((await vault.list()).length, 2);
    assert(!JSON.stringify(await vault.list()).includes("secret-"));
    const form = { value: {} };
    vaultFunction("edit", { form })((await vault.list())[0]);
    assert.equal((form.value as any).content, "");
    await vault.save({ id: first.id, name: "renamed", condition: "updated condition", content: "" });
    assert.equal((await vault.get(first.id, "test")).content, "secret-one");
    assert.equal((await vault.get(second.id, "test")).content, "secret-two");
    await vault.save({ id: second.id, name: "replacement", condition: "second task", content: "new-secret" });
    await vault.remove(first.id);
    assert.equal((await vault.list()).length, 1);
    assert.equal((await vault.get(second.id, "test")).content, "new-secret");
    vaultFunction("reset", { form, blank: () => ({ type: "login", name: "", condition: "", content: "", scope: "all", employees: [] }) })();
    assert.equal((form.value as any).id, undefined);
  } finally { await store.close(); }
});
