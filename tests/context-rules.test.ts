import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogContextModels, modelContext, parseContextTokens, serializeContextRules, validateContextRules } from "../shared/context-rules";
import { modelEntries, resolveModel, validateConfig, type Config } from "../server/core/config";
import { Catalog } from "../server/core/catalog";
import { Engine } from "../server/core/engine";

const rules = [{ keyword: " HAIKU ", context: 100000 }, { keyword: "claude", context: 150000 }];

test("context rules parse decimal k units and reject invalid shapes or budgets", () => {
  for (const [text, expected] of [["100k", 100000], [" 100K ", 100000], ["100000", 100000], ["1024", 1024]] as const) assert.equal(parseContextTokens(text), expected);
  for (const text of ["", "0", "-1", "1.5", "1e5", "100kb", "Infinity", "9007199254740992", "9007199254741k"]) assert.equal(parseContextTokens(text), null, text);
  assert.deepEqual(serializeContextRules([{ keyword: " haiku ", context: "100k" }]), [{ keyword: "haiku", context: 100000 }]);
  assert.deepEqual(validateContextRules(undefined), []);
  for (const value of [null, {}, "bad", [null], [{}], [{ keyword: " ", context: 100000 }], [{ keyword: "haiku", context: "100k" }], [{ keyword: "haiku", context: 1023 }], [{ keyword: "haiku", context: 1.5 }], [{ keyword: "haiku", context: Number.MAX_SAFE_INTEGER + 1 }], [{ keyword: "haiku", context: 100000, unknown: true }]]) {
    assert.throws(() => validateContextRules(value));
    assert.throws(() => validateConfig({ model: "", provider: { unused: { contextRules: value } } }));
  }
});

test("context rules use first case-insensitive ID/name match without changing manual or catalog values", () => {
  const original = { alias: { name: "Claude Haiku", limit: { context: 400000, output: 32000 } } };
  const before = structuredClone(original), models = catalogContextModels(original), provider = { contextRules: rules };
  assert.deepEqual(modelContext(provider, "alias", models.alias), { context: 100000, source: "rule", keyword: "HAIKU" });
  assert.equal(modelContext(provider, "vendor/HAIKU-new", { contextSource: "catalog", contextWindow: 400000 }).context, 100000);
  assert.equal(modelContext({ contextRules: [...rules].reverse() }, "alias", models.alias).context, 150000);
  assert.equal(modelContext({}, "alias", models.alias).context, 400000);
  assert.equal(modelContext(provider, "alias", { ...original.alias, limit: { context: 64000 } }).context, 64000);
  assert.equal(modelContext(provider, "haiku", { contextWindow: 64000 }).context, 64000);
  assert.deepEqual(Object.keys(modelEntries(catalogContextModels({ empty: {} }))), ["empty"]);
  assert.deepEqual(original, before);
  assert.equal(models.alias.limit.context, 400000);
});

test("catalog listing and execution agree on rules, variants, provider scope and persisted discovery", async () => {
  const automatic = { "vendor/HAIKU-new": { limit: { context: 400000, output: 32000 }, variants: { high: {} } }, alias: { name: "Claude Haiku", limit: { context: 300000 } } };
  const before = structuredClone(automatic);
  const catalog = new Catalog({} as any, {} as any);
  catalog.models = async () => ({ at: 0, models: automatic });
  const config: Config = { model: "p/vendor/HAIKU-new", provider: {
    p: { preset: "openai-compatible", options: { baseURL: "https://example.test/v1" }, contextRules: rules, models: { "haiku-manual": { limit: { context: 64000, output: 2048 } } } },
    other: { preset: "openai-compatible", options: { baseURL: "https://example.test/v1" } },
  } };
  const raw = JSON.stringify(config);
  const resolved = await catalog.resolve(config, "p/vendor/HAIKU-new/variant/high");
  assert.equal(resolved.contextWindow, 100000);
  assert.equal(resolved.maxOutputTokens, 32000);
  assert.equal((await catalog.resolve(config, "p/haiku-manual")).contextWindow, 64000);
  assert.equal((await catalog.resolve(config, "other/vendor/HAIKU-new")).contextWindow, 400000);
  const listed = await catalog.list(config);
  assert.equal(listed.find((m) => m.id === "p/vendor/HAIKU-new")?.context, 100000);
  assert.equal(listed.find((m) => m.id === "p/alias")?.context, 100000);
  assert.equal(JSON.stringify(config), raw);
  const persisted = structuredClone(config);
  persisted.provider.p.models = { ...catalogContextModels(automatic), ...persisted.provider.p.models };
  assert.equal((await catalog.resolve(persisted, "p/alias")).contextWindow, 100000);
  delete persisted.provider.p.contextRules;
  assert.equal((await catalog.resolve(persisted, "p/alias")).contextWindow, 300000);
  assert.equal(resolveModel({ model: "p/alias", provider: { p: { api: "openai-completions", options: { baseURL: "https://example.test/v1" }, contextRules: rules, models: catalogContextModels(automatic) } } }).contextWindow, 100000);
  assert.deepEqual(automatic, before);
});

test("local provider windows follow rules while explicit model limits remain authoritative", async () => {
  const catalog = new Catalog({ get: async () => ({}) } as any, { load: async () => ({ api: "openai-completions", options: { baseURL: "https://example.test/v1" }, models: { haiku: { limit: { context: 200000 } } } }) } as any);
  catalog.models = async () => ({ at: 0, models: {} });
  const config: Config = { model: "p/haiku", provider: { p: { preset: "local-codex", contextRules: rules } } };
  assert.equal((await catalog.resolve(config)).contextWindow, 100000);
  config.provider.p.models = { haiku: { limit: { context: 64000 } } };
  assert.equal((await catalog.resolve(config)).contextWindow, 64000);
});

test("saving rejects invalid rules on unused providers before changing stored config", async () => {
  let written = false, resolved = false;
  const engine = {
    config: async () => ({ provider: {}, scenes: {} }),
    catalog: { resolve: async () => { resolved = true; } },
    store: { put: async () => { written = true; } },
    relay: { restart: async () => {} }, emit() {},
  };
  await assert.rejects(Engine.prototype.saveConfig.call(engine as any, { model: "", provider: { unused: { contextRules: [{ keyword: "haiku", context: 0 }] } } }), /上下文规则/);
  assert.equal(written, false);
  assert.equal(resolved, false);
});
