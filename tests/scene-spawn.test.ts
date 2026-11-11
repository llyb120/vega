import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import {
  sceneAllowSpawn,
  sceneModels,
  sceneModelRows,
  validateConfig,
  resolveModel,
  variantLabel,
  isDeepseekFlash,
  type Config,
} from "../server/core/config";

const provider = {
  p: {
    api: "openai-completions" as const,
    baseURL: "https://fixture.test/v1",
    models: {
      flash: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } },
      light: { modalities: { input: ["text"] }, limit: { context: 128000, output: 8192 } },
      vision: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } },
    },
  },
};

function config(scenes: Config["scenes"]): Config {
  return { model: "p/light", scenes, provider } as Config;
}

test("legacy string scene arrays still resolve, and allowSpawn defaults to false", () => {
  const c = config({ lightweight: ["p/light"], coding: ["p/flash"], computer: ["p/vision"] });
  assert.deepEqual(sceneModels(c, "coding"), ["p/flash"]);
  assert.equal(sceneAllowSpawn(c, "coding", "p/flash"), false);
  assert.deepEqual(sceneModelRows(c, "coding"), [{ model: "p/flash", allowSpawn: false }]);
  const upgraded = config({
    lightweight: [{ model: "p/light", allowSpawn: true }],
    coding: [{ model: "p/flash" }],
    computer: ["p/vision"],
  });
  assert.equal(sceneAllowSpawn(upgraded, "lightweight", "p/light"), true);
  assert.equal(sceneAllowSpawn(upgraded, "coding", "p/flash"), false);
  validateConfig(c);
  validateConfig(upgraded);
});

test("computer cannot enable 分身, even if a row asks for it", () => {
  const c = config({
    lightweight: ["p/light"],
    coding: ["p/flash"],
    computer: [{ model: "p/vision", allowSpawn: true } as any],
  });
  assert.equal(sceneAllowSpawn(c, "computer", "p/vision"), false);
  assert.throws(() => validateConfig(c), /Computer scene cannot enable/);
});

test("DeepSeek Flash gets an Epic niu-m variant; other DeepSeek models do not", async () => {
  assert.equal(variantLabel("niu-m"), "Epic");
  assert.equal(isDeepseekFlash("deepseek-flash"), true);
  const store = await Store.open(":memory:");
  const catalog = new Catalog(store, new Subscriptions(store, ""));
  try {
    const c = {
      model: "p/deepseek-flash",
      provider: {
        p: {
          api: "openai-completions",
          baseURL: "https://fixture.test/v1",
          models: {
            "deepseek-flash": { modalities: { input: ["text"] }, limit: { context: 128000, output: 8192 } },
            "deepseek-chat": { modalities: { input: ["text"] }, limit: { context: 128000, output: 8192 } },
          },
        },
      },
    } as Config;
    const listed = await catalog.list(c);
    const flash = listed.find((m: any) => m.id === "p/deepseek-flash");
    const chat = listed.find((m: any) => m.id === "p/deepseek-chat");
    assert(flash?.variants?.includes("niu-m"), `Epic variant missing: ${JSON.stringify(listed)}`);
    assert(!chat?.variants?.includes("niu-m"), "Epic is only for DeepSeek Flash");
    const epic = resolveModel(c, "p/deepseek-flash/variant/niu-m");
    assert.equal(epic.options.reasoningEffort, "max");
  } finally {
    await store.close();
  }
});

test("spawn_agent is omitted when the session did not freeze allowSpawn, and included when it did; computer stays off", async () => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  const c = config({
    lightweight: [{ model: "p/light", allowSpawn: true }],
    coding: [{ model: "p/flash", allowSpawn: true }],
    computer: ["p/vision"],
  });
  await store.put("config", c);
  try {
    const model = resolveModel(c, "p/flash");
    const off = await store.newSession({ title: "off", scene: "coding", model: "p/flash", allowSpawnFrozen: false });
    const on = await store.newSession({ title: "on", scene: "coding", model: "p/flash", allowSpawnFrozen: true });
    const computer = await store.newSession({ title: "pc", scene: "computer", model: "p/vision", allowSpawnFrozen: false, taskId: "t1" });
    const offTools = await Tools.create(engine, off, c, new AbortController().signal, () => {});
    const onTools = await Tools.create(engine, on, c, new AbortController().signal, () => {});
    const computerTools = await Tools.create(engine, computer, c, new AbortController().signal, () => {});
    assert.equal((await offTools.definitions(model)).some((t) => t.name === "spawn_agent"), false);
    assert.equal((await onTools.definitions(model)).some((t) => t.name === "spawn_agent"), true);
    assert.equal((await computerTools.definitions(model)).some((t) => t.name === "spawn_agent"), false);
    const mid = await store.newSession({ title: "mid", scene: "coding", model: "p/flash", allowSpawnFrozen: true, sceneEnumFrozen: ["lightweight", "coding", "computer"] });
    const midTools = await Tools.create(engine, mid, c, new AbortController().signal, () => {});
    mid.scene = "computer";
    mid.sceneStack = [{ scene: "coding" }];
    const before = (await midTools.definitions(model)).find((t) => t.name === "switch_scene")!.parameters.properties.scene.enum;
    mid.scene = "lightweight";
    const after = (await midTools.definitions(model)).find((t) => t.name === "switch_scene")!.parameters.properties.scene.enum;
    assert.deepEqual(before, ["lightweight", "coding", "computer"]);
    assert.deepEqual(after, before, "switch_scene.enum must not change mid-session");
  } finally {
    await engine.close();
    await store.close();
  }
});
