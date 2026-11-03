import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { validateMcpServer } from "../shared/mcp-config";
import { maskedConfig, mergeSecrets } from "../server/core/config";
import { Vault } from "../server/core/vault";
import { Store } from "../server/core/store";

const settings = readFileSync("web/src/SettingsView.vue", "utf8");
const capabilities = readFileSync("web/src/EmployeeCapabilities.vue", "utf8");
function settingsFunction(name: string, scope: any) {
  const source = (["saveMcp", "addMcp"].includes(name) ? capabilities : settings).match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
  assert(source, name);
  return runInNewContext(`(${source})`, scope);
}

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

test("MCP and skill editors belong to the employee while the vault remains global", () => {
  assert.match(settings, /<PageHeader title="系统设置"/);
  assert.match(capabilities, /v-model="mcp\[key\]"[^>]*:aria-label="key \+ ' JSON配置'"/);
  assert(!settings.includes("saveMcp") && !settings.includes("/skills/upload"));
  assert(capabilities.includes('v-if="canEdit"') && capabilities.includes("只有创建者可以查看和编辑详情"));
  assert.match(settings, /@click="editVault\(item\)"/);
  assert.match(settings, /@click="newVault"/);
  assert.match(settings, /v-model="vaultForm.content" :required="!vaultForm.id"/);
  assert.match(settings, /vaultForm.id \? '保存修改' : '新增并加密保存'/);
  const employeeSettings = readFileSync("web/src/EmployeeSettings.vue", "utf8");
  const app = readFileSync("web/src/App.vue", "utf8");
  assert(!employeeSettings.includes("vaultIds") && !employeeSettings.includes("vaultEntries"));
  assert(!app.includes("vaultIds") && !app.includes("vaultEntries"));
});

test("MCP JSON validation rejects malformed transports and options", () => {
  for (const value of [null, [], "text", { url: "file:///secret" }, { command: "" }, { command: "node", url: "https://example.com" }, { command: "node", args: "script" }, { url: "https://example.com", headers: [] }, { command: "node", env: { TOKEN: 12 } }, { command: "node", enabled: "yes" }]) assert.throws(() => validateMcpServer(value, "service"));
  assert.doesNotThrow(() => validateMcpServer({ command: "node", args: [], env: {}, enabled: false }, "service"));
});

test("vault keeps the existing name/condition/content form without requiring website configuration", async () => {
  const form = { value: {} as any };
  settingsFunction("editVault", { vaultForm: form })({ id: "entry", name: "account", condition: "仅用于合作伙伴身份验证，不用于业务站邮箱登录" });
  assert.equal(form.value.condition, "仅用于合作伙伴身份验证，不用于业务站邮箱登录");
  assert.equal(form.value.content, "");
  let body: any;
  await settingsFunction("saveVault", { vaultForm: form, props: { api: async (_path: string, _method: string, value: any) => { body = value; } }, run: async (fn: any) => fn(), newVault() {}, loadVault: async () => {}, emit() {} })();
  assert.equal(body.condition, form.value.condition);
  assert.equal(body.content, "");
  assert.equal(body.site, undefined);
  assert(!settings.includes('v-model="vaultForm.site"'));
});

test("vault adds multiple entries and edits only the chosen one without exposing secrets", () => {
  const store = new Store(":memory:"), vault = new Vault(store);
  try {
    const first = vault.save({ name: "account", condition: "first task", content: "secret-one" });
    const second = vault.save({ name: "account", condition: "second task", content: "secret-two" });
    assert.notEqual(first.id, second.id);
    assert.equal(vault.list().length, 2);
    assert(!JSON.stringify(vault.list()).includes("secret-"));
    const form = { value: {} };
    settingsFunction("editVault", { vaultForm: form })(vault.list()[0]);
    assert.equal((form.value as any).content, "");
    vault.save({ id: first.id, name: "renamed", condition: "updated condition", content: "" });
    assert.equal(vault.get(first.id, "test").content, "secret-one");
    assert.equal(vault.get(second.id, "test").content, "secret-two");
    vault.save({ id: second.id, name: "replacement", condition: "second task", content: "new-secret" });
    vault.remove(first.id);
    assert.equal(vault.list().length, 1);
    assert.equal(vault.get(second.id, "test").content, "new-secret");
    settingsFunction("newVault", { vaultForm: form })();
    assert.equal((form.value as any).id, undefined);
  } finally { store.close(); }
});
