import type { Employee } from "./employee";
import type { Store } from "./store";
import type { Config } from "./config";
import { maskedConfig, mergeSecrets } from "./config";
import { check } from "./auth";
import { validateMcpServer } from "../../shared/mcp-config";
import { uploadSkill } from "./skill-upload";
import { skillKind } from "./skills";
import { type Obj } from "./util";

export async function migrateEmployeeCapabilities(store: Store) {
  if (await store.get("employee-capabilities:migrated", false) || await store.get("employee:default-deleted", false)) return;
  await store.transaction(async () => {
        const config = await store.get<Config>("config", { model: "", provider: {} });
        await store.save("employee-capabilities", "default", {
                mcp: config.mcp || {}, skills: config.skills || [], skillsDirectory: config.skillsDirectory,
              });
        for (const skill of await store.objects<Obj>("skill")) {
          await store.save(skillKind("default"), skill.id, { ...skill, employeeId: "default" });
          await store.remove("skill", skill.id);
        }
        delete config.mcp; delete config.skills; delete config.skillsDirectory;
        await store.put("config", config);
        await store.put("employee-capabilities:migrated", true);
      });
}

export async function employeeConfig(store: Store, config: Config, employeeId: string): Promise<Config> {
  const own = await store.object<Obj>("employee-capabilities", employeeId) || {};
  return { ...config, employeeId, mcp: own.mcp || {}, skills: own.skills || [], skillsDirectory: own.skillsDirectory };
}

// This permission deliberately has no administrator override.
export async function canConfigureEmployee(employee: Employee, user: { id: string; role: string }) {
  return !!user.id && (await employee.state()).ownerId === user.id && user.role !== "viewer";
}

export async function employeeCapabilities(employee: Employee, user: { id: string; role: string }, method: string, path: string[], body: Obj = {}) {
  await migrateEmployeeCapabilities(employee.store);
  check(await employee.accessible(user), 404, "Employee not found");
  check(!employee.deleting, 409, "牛马正在删除，请稍候");
  const store = employee.store, id = employee.employeeId, canEdit = await canConfigureEmployee(employee, user);
  const config = await store.object<Obj>("employee-capabilities", id) || {};
  if (method === "GET" && path[0] === "capabilities" && path.length === 1) {
    const masked = canEdit ? maskedConfig({ model: "", provider: {}, mcp: config.mcp || {} }).mcp : undefined;
    return {
      canEdit,
      skills: (await store.objects<Obj>(skillKind(id))).map((skill) => canEdit
        ? { id: skill.id, name: skill.name, description: skill.description, files: skill.assets?.map((asset: Obj) => asset.path) || ["SKILL.md"] }
        : { name: skill.name }),
      mcp: Object.keys(config.mcp || {}).map((name) => canEdit ? { name, config: masked![name] } : { name }),
    };
  }
  check(canEdit, 403, "只有牛马创建者可以查看或修改 skill / MCP 配置详情");
  if (path[0] === "mcp" && path.length === 1 && method === "PUT") {
    const mcp = body.mcp;
    check(mcp && typeof mcp === "object" && !Array.isArray(mcp) && Object.keys(mcp).length <= 50, 400, "MCP配置必须为对象，最多50项");
    const next = structuredClone(mcp);
    mergeSecrets(next, config.mcp || {});
    for (const [name, value] of Object.entries(next)) {
      check(!!name.trim() && name.length <= 100 && !/[\x00-\x1f]/.test(name) && !["__proto__", "constructor", "prototype"].includes(name), 400, "MCP 名称须为 1–100 个字符且不含换行：名称填在「名称」框，配置只写在右侧 JSON 里");
      validateMcpServer(value, name);
    }
    await store.save("employee-capabilities", id, { ...config, mcp: next });
  } else if (path[0] === "skills" && path[1] === "upload" && path.length === 2 && method === "POST") {
    const result = await uploadSkill(store, body, id);
    await employee.emitChanged();
    return result;
  } else if (path[0] === "skills" && path.length === 2 && ["GET", "DELETE"].includes(method)) {
    const name = decodeURIComponent(path[1]);
    const skill = await store.object<Obj>(skillKind(id), name);
    check(skill, 404, "Skill not found");
    if (method === "GET") return { id: skill.id, name: skill.name, description: skill.description, content: skill.content, files: skill.assets?.map((asset: Obj) => asset.path) || ["SKILL.md"] };
    await store.remove(skillKind(id), name);
  } else check(false, 404, "Capability route not found");
  await employee.emitChanged();
  return { ok: true };
}
