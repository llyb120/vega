import { test } from "node:test";
import assert from "node:assert/strict";
import { clientModelChoices, clientSettings } from "../server/core/client-settings";
import type { Config } from "../server/core/config";

const config = {
  model: "retired",
  provider: {
    demo: {
      apiKey: "secret-key",
      models: {
        chat: { name: "Chat", supportsImages: false },
        vision: { name: "Vision", supportsImages: true, variants: { "niu-m": { name: "Epic" } } },
      },
    },
  },
  scenes: {
    lightweight: ["demo/chat"],
    coding: [{ model: "demo/chat", allowSpawn: true }],
    computer: ["demo/vision"],
  },
  scheduler: { globalSlots: 4, perEmployeeSlots: 2 },
} as Config;

function engineFor(role = "admin") {
  const saved: Config[] = [];
  const controlled: any[] = [];
  let instruction = "stay";
  let name = "Bot";
  const employee = {
    employeeId: "e1",
    accessible: async (user: { id: string }) => user.id === "owner",
    manageable: async (user: { id: string; role: string }) => user.id === "owner" && user.role !== "viewer",
    profile: async () => ({ id: "e1", name, instruction }),
    control: async (body: any, owner: any) => { controlled.push([body, owner]); name = body.name ?? name; instruction = body.instruction ?? instruction; return { ok: true }; },
  };
  let failImages = false;
  const engine = {
    employee: { all: async () => [employee] },
    config: async () => structuredClone(config),
    saveConfig: async (next: Config) => {
      saved.push(structuredClone(next));
      if (failImages) throw new Error("Computer scene must support images");
      return next;
    },
  };
  const user = { id: "owner", role, username: "owner" };
  return { engine, user, saved, controlled, setFailImages: (value: boolean) => { failImages = value; } };
}

test("model choices expose ids and image support without provider secrets", () => {
  const choices = clientModelChoices(config);
  assert.deepEqual(choices.map((row) => row.id), ["demo/chat", "demo/vision", "demo/vision/variant/niu-m"]);
  assert.equal(choices.find((row) => row.id === "demo/vision/variant/niu-m")?.name.includes("Epic"), true);
  assert.equal(JSON.stringify(choices).includes("secret-key"), false);
});

test("settings load follows role, and an owner save echoes the work principle", async () => {
  const viewer = engineFor("viewer");
  const loaded = await clientSettings(viewer.engine, viewer.user, { action: "load" });
  assert.equal(loaded.viewer, true);
  assert.equal(loaded.employees[0].canManage, false);
  assert.equal("scenes" in loaded, false);
  await assert.rejects(clientSettings(viewer.engine, viewer.user, { action: "employee", employeeId: "e1", instruction: "no" }), (error: any) => error.statusCode === 403);
  assert.equal(viewer.controlled.length, 0);

  const owner = engineFor("user");
  const saved = await clientSettings(owner.engine, owner.user, { action: "employee", employeeId: "e1", name: "Renamed", instruction: "careful" });
  assert.equal(owner.controlled[0][0].action, "settings");
  assert.equal(owner.controlled[0][1].token, "");
  assert.deepEqual(saved.employee, { id: "e1", name: "Renamed", instruction: "careful", canManage: true });
  await assert.rejects(clientSettings(owner.engine, owner.user, { action: "employee", employeeId: "e1", public: true }), (error: any) => error.statusCode === 400);
  await assert.rejects(clientSettings(owner.engine, owner.user, { action: "employee", employeeId: "e1", duties: [] }), (error: any) => error.statusCode === 400);
  await assert.rejects(clientSettings(owner.engine, { id: "other", role: "admin", username: "other" }, { action: "employee", employeeId: "e1", instruction: "no" }), (error: any) => error.statusCode === 403);
  assert.equal(owner.controlled.length, 1);
  await assert.rejects(clientSettings(owner.engine, owner.user, { action: "workspace", scenes: {}, scheduler: {} }), (error: any) => error.statusCode === 403);
  assert.equal(owner.saved.length, 0);
});

test("admin workspace save keeps provider secrets, drops computer clones, and reports model errors", async () => {
  const admin = engineFor("admin");
  const loaded = await clientSettings(admin.engine, admin.user, { action: "load" });
  assert.equal(loaded.admin, true);
  assert.equal(loaded.scheduler.globalSlots, 4);
  assert.equal(JSON.stringify(loaded).includes("secret-key"), false);
  const scenes = {
    lightweight: ["demo/chat"],
    coding: [{ model: "demo/vision", allowSpawn: true }],
    computer: [{ model: "demo/vision", allowSpawn: true }],
  };
  const saved = await clientSettings(admin.engine, admin.user, { action: "workspace", scenes, scheduler: { globalSlots: 5, perEmployeeSlots: 1 } });
  assert.deepEqual(admin.saved[0].scenes?.computer, ["demo/vision"]);
  assert.deepEqual(admin.saved[0].scenes?.coding, [{ model: "demo/vision", allowSpawn: true }]);
  assert.equal(admin.saved[0].provider.demo.apiKey, "secret-key");
  assert.equal("model" in admin.saved[0], false);
  assert.equal(saved.scheduler.perEmployeeSlots, 1);
  assert.equal("provider" in saved, false);
  await assert.rejects(clientSettings(admin.engine, admin.user, { action: "workspace", scenes: { ...scenes, lightweight: [] }, scheduler: { globalSlots: 5, perEmployeeSlots: 1 } }), (error: any) => error.statusCode === 400 && /沟通与任务起步/.test(error.message));
  assert.equal(admin.saved.length, 1);
  await assert.rejects(clientSettings(admin.engine, admin.user, { action: "workspace", scenes, scheduler: { globalSlots: 0, perEmployeeSlots: 1 } }), (error: any) => error.statusCode === 400);
  admin.setFailImages(true);
  await assert.rejects(clientSettings(admin.engine, admin.user, { action: "workspace", scenes, scheduler: { globalSlots: 5, perEmployeeSlots: 1 } }), (error: any) => error.statusCode === 400 && /支持图片/.test(error.message));
});
