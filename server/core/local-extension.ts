import type { Auth } from "./auth";
import type { Engine } from "./engine";
import { assert, filterAsync } from "./util";

/** The device credential a native client already holds (client-socket.ts authorize). */
export type ExtensionGrant = { userId: string; clientId: string };
export type ExtensionDeps = { auth: Auth; engine: Engine };
export type ExtensionInstall = { employee: string; employeeId: string; session: string };

/** 让牛马把这台电脑的 Chrome 装/更新成 Vega 扩展；路径由客户端解压后报上来。 */
export function browserExtensionPrompt(path: string, client?: { name?: string }): string {
  return [
    "【本机客户端请求】用户在本地客户端「连接授权 → 授权 → 浏览器扩展」点了「更新浏览器扩展」：把 Vega Chrome 扩展装进这台电脑（" + (client?.name || "本机客户端") + "）的 Chrome。",
    "沟通会话里没有 appuse：请建一个任务，在它的电脑会话（appuse 只在电脑场景可用）里做这件事。",
    "",
    "扩展目录（客户端已解压，选「加载已解压的扩展程序」时直接选它）：" + path,
    "",
    "步骤（用 appuse 操作这台电脑的真实界面）：",
    "1. 切到 Chrome，在地址栏打开 chrome://extensions。",
    "2. 打开右上角「开发者模式」。",
    "3. 列表里已有 Vega Chrome：点它的「重新加载」；没有：点「加载已解压的扩展程序」，在系统文件选择框里用 appuse 的 type 输入上面的目录再确认。",
    "4. 完成后用 chrome_connection 确认扩展已连接（本机回环端口 47753–47762）。",
    "",
    "约束：只能用 appuse 操作桌面和原生对话框；不要用 bash、PowerShell、UIAutomation 或任何脚本安装扩展，不要从商店或网络下载插件，不要改 Chrome 的 Profile、偏好设置或登录态。遇到拿不准的原生对话框或权限提示就停下来问用户，不要猜。",
    "如果发现本机不是这头牛马的文件系统 / 浏览器 Master，不要换成别的机器或云端装：停下来告诉用户去客户端的「本机 → 文件系统 Master」和「授权 → 浏览器 Master」把本机选上。",
  ].join("\n");
}

/**
 * 设备凭据 → 这台电脑 → 第一头「文件系统与浏览器 Master 都在本机」的可用牛马 → 让它用 appuse 装扩展。
 * 安装要用本机桌面（appuse 按文件系统 Master 在本机执行），装进的是本机 Chrome（浏览器 Master）；
 * 两项对不上时不偷偷换机器，直接把要改的那一处告诉用户。
 */
export async function installBrowserExtension(
  deps: ExtensionDeps,
  grant: ExtensionGrant,
  input: { path?: unknown },
): Promise<ExtensionInstall> {
  const owner = await deps.auth.user(grant.userId);
  assert(owner, "客户端凭据对应的账号已不存在，请到客户端重新配对。");
  const path = extensionPath(input.path);
  const mine = await filterAsync(
    await deps.engine.employee.all(),
    async (employee) => !employee.deleting && await employee.manageable(owner),
  );
  assert(
    mine.length,
    "没有可用的牛马：请先在「数字牛马」里新建一个（或等正在删除的牛马处理完），再点一次「更新浏览器扩展」。",
  );
  let employee = mine[0];
  let runtime = await deps.engine.runtimes.get(employee.employeeId, owner.id);
  for (const candidate of mine) {
    const value = await deps.engine.runtimes.get(candidate.employeeId, owner.id);
    if (value.fsMaster === grant.clientId && value.browserMaster === grant.clientId) {
      employee = candidate;
      runtime = value;
      break;
    }
  }
  const name = async () => (await employee.state()).name;
  // 所选客户端不在线时 MasterRuntimes 已经回落成云端，所以这里看到的即生效值。
  assert(
    runtime.fsMaster === grant.clientId,
    `这头牛马「${await name()}」的文件系统 Master 现在是${masterLabel(runtime.fsMaster)}：appuse 要在这台电脑上执行。请在客户端「本机 → 文件系统 Master」把本机选上，再点一次「更新浏览器扩展」。`,
  );
  assert(
    runtime.browserMaster === grant.clientId,
    `这头牛马「${await name()}」的浏览器 Master 现在是${masterLabel(runtime.browserMaster)}：要装的是这台电脑的 Chrome。请在客户端「授权 → 浏览器 Master」把本机选上，再点一次「更新浏览器扩展」。`,
  );
  const session = await employee.chat(owner.id);
  assert(!deps.engine.active.has(session.id), "这个牛马正在执行别的请求，等它结束再点一次「更新浏览器扩展」。");
  const client = deps.engine.localAgents.list(owner.id).find((item) => item.id === grant.clientId);
  await deps.engine.submitChat(session.id, {
    role: "user",
    text: browserExtensionPrompt(path, client),
    actorId: owner.id,
  });
  return { employee: await name(), employeeId: employee.employeeId, session: session.id };
}

const masterLabel = (master: string) => (master === "cloud" ? "云端" : "另一台设备");

/** 只接受客户端报上来的本机绝对路径（Windows 盘符或 POSIX）。 */
function extensionPath(value: unknown) {
  const valid =
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\0") &&
    (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value));
  if (!valid)
    throw Object.assign(
      Error("扩展目录无效：请重新点一次「更新浏览器扩展」让客户端重新解压。"),
      { statusCode: 400 },
    );
  return value;
}
