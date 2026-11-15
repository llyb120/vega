import { modelEntries, sceneModelRows, sceneModelSelection, schedulerLimits, SCENE_KEYS, type Config, type SceneModelRow } from "./config";
import { clone, object, type Obj } from "./util";

type User = { id: string; role: string; username?: string };
type EmployeeLike = {
  employeeId: string;
  accessible(user: User): Promise<boolean>;
  manageable(user: User): Promise<boolean>;
  profile(): Promise<{ id: string; name: string; instruction?: string }>;
  control(body: Obj, owner: { token: string; name: string }): Promise<unknown>;
};
type SettingsEngine = {
  employee: { all(): Promise<EmployeeLike[]> };
  config(): Promise<Config>;
  saveConfig(next: Config): Promise<Config>;
};

const SCENES: { key: (typeof SCENE_KEYS)[number]; label: string; hint: string }[] = [
  { key: "lightweight", label: "沟通与任务起步", hint: "新任务与沟通会话从这里起步；留空则无法运行。" },
  { key: "coding", label: "编码", hint: "实际进入编码工作时使用。除浏览器操作外可以允许分身。" },
  { key: "computer", label: "浏览器操作", hint: "只能选择支持图片的模型，不能开启分身。" },
];

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function supportsImages(model: Obj) {
  if (typeof model.supportsImages === "boolean") return model.supportsImages;
  const input = model.modalities?.input;
  return Array.isArray(input) && input.includes("image");
}

/** Model ids and display names already stored on the server. No keys, headers, or vault. */
export function clientModelChoices(config: Config) {
  const rows: { id: string; name: string; supportsImages: boolean }[] = [];
  for (const [providerId, raw] of Object.entries(config.provider || {})) {
    const provider = object(raw);
    for (const [key, model] of Object.entries(modelEntries(provider.models))) {
      const images = supportsImages(model);
      const name = String(model.name || key);
      rows.push({ id: `${providerId}/${key}`, name, supportsImages: images });
      for (const variant of Object.keys(object(model.variants))) {
        rows.push({
          id: `${providerId}/${key}/variant/${variant}`,
          name: `${name} · ${variant === "niu-m" ? "Epic" : variant}`,
          supportsImages: images,
        });
      }
    }
  }
  return rows;
}

function employeeView(profile: { id: string; name: string; instruction?: string }, canManage: boolean) {
  return { id: profile.id, name: profile.name, instruction: profile.instruction || "", canManage };
}

async function load(engine: SettingsEngine, user: User) {
  const employees = [];
  for (const employee of await engine.employee.all()) {
    if (!(await employee.accessible(user))) continue;
    employees.push(employeeView(await employee.profile(), await employee.manageable(user)));
  }
  const admin = user.role === "admin";
  const body: Obj = { role: user.role, admin, viewer: user.role === "viewer", employees };
  if (!admin) return body;
  const config = await engine.config();
  body.models = clientModelChoices(config);
  body.scenes = SCENES.map((scene) => ({
    ...scene,
    computer: scene.key === "computer",
    rows: sceneModelRows(config, scene.key),
  }));
  const limits = schedulerLimits(config);
  body.scheduler = { globalSlots: limits.global, perEmployeeSlots: limits.perEmployee };
  return body;
}

async function saveEmployee(engine: SettingsEngine, user: User, body: Obj) {
  if (user.role === "viewer") fail(403, "只读账号不能修改牛马设置");
  for (const key of ["public", "duties", "enabled", "workStart", "workEnd", "cwd", "idleMinutes", "takeoverSeconds"])
    if (key in body) fail(400, "客户端不修改这项设置");
  const employeeId = String(body.employeeId || "");
  const employee = (await engine.employee.all()).find((item) => item.employeeId === employeeId);
  if (!employee || !(await employee.manageable(user))) fail(403, "只能修改自己的牛马");
  const patch: Obj = { action: "settings" };
  if ("name" in body) {
    const name = String(body.name ?? "");
    if (!name.trim() || [...name].length > 80) fail(400, "名称需为 1–80 字");
    patch.name = name;
  }
  if ("instruction" in body) {
    const instruction = String(body.instruction ?? "");
    if ([...instruction].length > 8000) fail(400, "工作原则不能超过 8000 字");
    patch.instruction = instruction;
  }
  if (!("name" in patch) && !("instruction" in patch)) fail(400, "没有可保存的设置");
  // Empty token is the host-user path. manageable() already limited this to the owner.
  await employee.control(patch, { token: "", name: user.username || "用户" });
  return { employee: employeeView(await employee.profile(), true) };
}

function sceneLabel(key: string) {
  return SCENES.find((scene) => scene.key === key)?.label || key;
}

async function saveWorkspace(engine: SettingsEngine, user: User, body: Obj) {
  if (user.role !== "admin") fail(403, "只有管理员可以修改场景模型和调度");
  const scenes: Record<string, SceneModelRow[]> = {};
  for (const key of SCENE_KEYS) {
    const raw = body.scenes?.[key];
    if (!Array.isArray(raw)) fail(400, "缺少场景：" + sceneLabel(key));
    const rows: SceneModelRow[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      const selection = sceneModelSelection(row, key);
      if (!selection || seen.has(selection.model)) continue;
      seen.add(selection.model);
      rows.push(key === "computer" || !selection.allowSpawn ? selection.model : { model: selection.model, allowSpawn: true });
    }
    if (!rows.length) fail(400, "请为全部场景配置至少一个模型后再保存：" + sceneLabel(key));
    scenes[key] = rows;
  }
  const scheduler = object(body.scheduler);
  for (const key of ["globalSlots", "perEmployeeSlots"] as const) {
    if (!Number.isInteger(scheduler[key]) || scheduler[key] < 1 || scheduler[key] > 64)
      fail(400, "调度并发必须是 1–64 的整数");
  }
  const next = clone(await engine.config());
  delete (next as Obj).model;
  next.scenes = scenes;
  next.scheduler = { globalSlots: scheduler.globalSlots, perEmployeeSlots: scheduler.perEmployeeSlots };
  let saved: Config;
  try {
    saved = await engine.saveConfig(next);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (message.includes("Computer scene must support images")) fail(400, "浏览器操作场景只能选择支持图片的模型");
    if (message.includes("电脑场景不能开启分身")) fail(400, "浏览器操作场景不能开启分身");
    throw error;
  }
  const limits = schedulerLimits(saved);
  return {
    scenes: SCENES.map((scene) => ({ ...scene, computer: scene.key === "computer", rows: sceneModelRows(saved, scene.key) })),
    scheduler: { globalSlots: limits.global, perEmployeeSlots: limits.perEmployee },
  };
}

/** Native-client settings: employee work principles, and admin scene models plus scheduler. */
export async function clientSettings(engine: SettingsEngine, user: User, body: Obj): Promise<Obj> {
  const action = String(body?.action || "load");
  if (action === "load") return await load(engine, user);
  if (action === "employee") return await saveEmployee(engine, user, body || {});
  if (action === "workspace") return await saveWorkspace(engine, user, body || {});
  fail(404, "未知的设置操作");
}
