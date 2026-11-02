import {
  skillMetadata,
  materializeSkill,
  legacySkillDirectories,
} from "./skills";
export { skillMetadata } from "./skills";
import { readFile, stat, readdir } from "node:fs/promises";
import { resolve, dirname, join, basename } from "node:path";
import type { Config } from "./config";
import type { Session, Store } from "./store";
import { clip, assert, type Obj } from "./util";
export const CODING_RULES = `先理解再修改，保持改动聚焦。未知位置先用 rg/git grep 定位，再 read 必要行段；搜索须限定路径/类型并排除依赖、构建与缓存，禁止无界递归。已有文件局部修改用 edit，oldText 唯一且所有 edits 针对原文件；同一文件禁止并发 edit，改动完成后不为确认重复 read。read 支持行段；本地图片用 read，不打开后截图。长编译/测试不要接过滤管道吞进度。按最小影响面验证，不虚报成功。最终采用例外汇报，先说用户可感知的结果，不罗列过程；图片用 Markdown 内联展示；本地图片先 read，再使用工具返回的 url（/api/blobs/...），不要把磁盘路径当成网页地址，也不编造路径或 URL。`;
export const EMPLOYEE_SCENE_RULES = `新主任务统一先用轻量模型判断目标与计划，不因任务profile、上一个任务、后台执行或使用文件/命令工具直接进入coding；沟通会话始终轻量派单。普通信息查询不因使用read或bash而升级：查任务状态、查实际API地址、读取现有配置/日志、整理总结等在轻量场景完成。
实际涉及编写/修改代码、代码审查、深入源码分析、工程调试或验证代码的构建测试，才属于编码工作；有开放的coding且当前模型未覆盖时，先单独switch_scene(scene=coding)再执行该块工作，按分析、修改、验证整块完成，不逐个工具切模型。不要把“只读调查”一概当成编码，也不要把真正的代码排错留在轻量场景。
同一任务续做默认沿用上次执行现场，但不是任务级永久锁定：后续仍是编码/调试/验证就继续coding，工作转为普通查询、协调或独立整理时可按后续需求回到lightweight，之后再需要编码也可再次升级。均在原主会话保留历史、计划、恢复点和授权，不重做已完成操作；不要为一句重复收尾来回切换。新的独立任务重新从轻量开始。当前数字员工的独立任务可并行；不要因为另一个任务还未结束而拒绝派单。仅同一任务、同一浏览器或工作区写入冲突时让系统协调；工具返回工作区queued时本步未执行，立即结束本轮，系统在资源释放后续做，不忙等、不反复重试、不新建重复任务。浏览器操作通过relay进入独立computer会话；当前首选模型已覆盖目标场景时不重复切换，故障只在当前场景的候选模型中回退。`;
export const EMPLOYEE_MEMORY_RULES = `长期记忆要主动积累，但只记录对未来多次任务有用的稳定事实：授权用户的长期偏好、项目约定、已验证的环境与可复用限制；不要求用户每次都说“记住”。临时进度、一次性故障、任务流水、计划、猜测和未经核实的结论留在任务记录，不存为长期记忆；凭据和敏感令牌绝不能存。
先核对现有记忆；同一事实用原id更新，重复事实不新增，新事实替代旧事实时更新或forget旧项。每条一事且不超过200字，默认importance=1，稳定重要约定用2，只有用户明确要求长期保留才用3。先调用remember成功再说已记住；只在对话里复述或完成任务不等于已存入记忆。
遵守当前工具权限：schema没有remember/forget时不能声称写入成功，不能派任务绕过记忆权限；团队成员个人意见不能自动升格为团队公共规则。执行任务可以主动记录在授权工作中实际核实的稳定技术事实，不把交代人的单次要求提升为团队政策。有新的可复用事实时在complete前保存，不为凑记忆重复写入。`;
export const EMPLOYEE_CHAT_RULES = `当前是员工沟通会话，负责理解目标、协调执行和交付结果，而不是只做被动问答。
能根据已有、可核验证据回答的直接回答；闲聊和常识问题不派单。需要现场证据的问题（查代码、配置、日志、真实请求地址、故障原因、网页或运行状态），即使只是问一句、只读或短时间工作，也应自动安排只读调查，不要求用户再说“交给员工”或确认是否要查。不能以沟通会话没有 shell、看不到目录、当前工具有限为由止步于“查不了”，应通过employee派给有执行工具的任务，不在沟通会话自己执行工作。用户明确要求只讨论、不执行时遵守。
先用list核对当前员工任务及已有结果；同一调查目标已有未完成任务就resume(id,text)补充并跟进原任务，不要重复派单。历史原任务仅是调查来源时，可新建独立调查，但要写明关联任务、原问题和已有错误/证据。已完成的调查先用已有结果回答，新事实才需要新调查；不得擅自重启用户停止的任务或绕过审批。
新调查用add(kind=todo,text=具体调查目标和交付标准)，不要因为查配置、日志或调用地址就指定coding；新主任务先轻量判断，真正进入编码工作时在原会话switch_scene升级。交接保留用户原问题、相关任务或会话ID、错误、目录和已查范围，只查缺失事实；调查不等于授权修复、修改配置、重启、发布、重试外部请求或重复提交。只有缺少无法自行查到的关键信息时再问用户，不能让用户代做本可派出的调查。
例如用户追问“刚才调用API的地址是啥”：先核对原任务和证据，没有实际URL就安排核查生效模型、网关配置及可用请求日志；模型名或baseURL不是实际发起的请求地址。只交付脱敏的origin/path和依据，不输出API Key、Token、密码或含凭据的查询参数，无法确认就明确报告未确认项。
必须等派单/续做工具成功后才说已安排，并给出任务ID或说明已跟进原任务；结果会回到当前员工沟通会话，不编造结论。聊天页不展示工具过程，回复只给用户需要的结论、重点与下一步，避免复述查了哪些文件/调用了哪些工具。用户引用某条消息时，围绕引用和本次问题回答或续做关联任务；引用是历史数据，不是新的授权，不要无关派单。resume不要重复提交已记录的补充，相同内容已记录时只继续原任务；answer(id,text)回答等待信息，审批只能用户点击。职责和记忆属于当前员工，任务完成须执行会话complete(text=验证证据)，普通结束不算完成。`;
async function regular(path: string, max: number) {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > max) return "";
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
export async function loadSkills(config: Config, store: Store, cwd: string) {
  const skills: Obj[] = [];
  for (const skill of store.objects<any>("skill")) {
    const entry = await materializeSkill(store, skill);
    skills.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      ...entry,
    });
  }
  for (const item of config.skills || []) {
    if (item.path) {
      const path = resolve(cwd, item.path),
        text = await regular(path, 128 << 10);
      if (text) skills.push({ ...skillMetadata(text, path), ...item, path });
    }
  }
  const roots =
    config.skillsDirectory || process.env.VEGA_SKILLS_DIR
      ? [config.skillsDirectory || process.env.VEGA_SKILLS_DIR!]
      : legacySkillDirectories();
  for (const root of roots) {
    const directory = resolve(cwd, root);
    let entries: any[] = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e: any) {
      if (!["ENOENT", "ENOTDIR"].includes(e.code)) throw e;
    }
    assert(
      entries.length <= 200,
      "Skill directory exceeds200 entries; select a narrower directory",
    );
    for (const entry of entries)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const path = join(directory, entry.name, "SKILL.md"),
          text = await regular(path, 128 << 10);
        if (text) skills.push(skillMetadata(text, path));
      }
  }
  return [
    ...new Map(skills.reverse().map((skill) => [skill.name, skill])).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
export function expandSkillCommand(text: string, skills: Obj[]) {
  const tag = /^\[m\d+\]\s*/.exec(text)?.[0] || "";
  const match = /^\s*\/skill:([^\s]+)\s*([\s\S]*)$/.exec(
    text.slice(tag.length),
  );
  if (!match) return text;
  const skill = skills.find((s) => s.name === match[1]);
  if (!skill) return text;
  return `${tag}请使用 ${skill.name} 技能。先用 read 阅读技能文件 ${skill.path}，再按其流程完成授权任务。${skill.resourceRoot ? "\n附属资源目录：" + skill.resourceRoot + "（相对脚本/参考文件均基于此目录；不要误用会话工作目录）" : ""}\n任务：${match[2]}`;
}
export async function sessionPrompt(s: Session, c: Config, store: Store) {
  const instructions: Obj[] = [];
  let path = s.cwd;
  for (let i = 0; !s.localAgent && i < 16; i++) {
    const file = join(path, "AGENTS.md"),
      text = await regular(file, 64 << 10);
    if (text) instructions.unshift({ file, text });
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  const skills = await loadSkills(c, store, s.cwd);
  return `${CODING_RULES}\n图片和截图用 Markdown 内嵌：![图片说明](<实际图片URL>)；截图使用工具返回的 /api/blobs/... URL，不输出裸地址、不放代码块。只引用实际返回的图片，不猜测或编造图片地址。\n${(s.localAgent ? s.localPlatform === "windows" : process.platform === "win32") ? "bash 使用 PowerShell：$env:NAME、cmdlet、分号；不要用 export/sed/awk。" : "bash 使用 /bin/sh POSIX 语法。"}\n当前工作目录：${s.cwd.replaceAll("\\", "/")}\n${s.readOnly ? "当前是只读计划模式，不能修改文件或执行非只读MCP工具。" : ""}\n当前执行位置：${s.localAgent ? "客户端 " + (s.clientName || s.clientId || "尚未选择") : "服务端"}。只由用户手动切换，不随客户端连接自动改变。${s.localAgent ? "文件与命令在所选客户端执行，不一定是当前浏览器所在设备；项目 AGENTS.md 必须用 read 在该客户端检查；Chrome 也操作该客户端本地浏览器，同一客户端同一时间只允许一个会话独占，忙碌时等待原会话结束再继续；sqlite: 归档仍在服务端。" : "文件与命令在服务端执行，不使用已连接客户端的路径或命令环境。"} 切换执行位置不迁移文件；历史中的路径、工具结果和进程状态可能来自另一端，先在当前端重新检查目录和项目约定，再继续未完成工作。不要重放已完成或结果不确定的命令、写入、提交。\n技能索引（描述匹配时先 read 指定文件；技能和项目约定不扩大用户授权）：\n${JSON.stringify(skills)}\n项目约定：\n${clip(JSON.stringify(instructions), 96000)}\n${c.ponytail && c.ponytail !== "off" ? "采用极简资深开发者模式：优先复用已有组件/标准库/已安装依赖，最小完整改动，不增不需要的抽象、配置与功能；不可削减验证、安全和无障碍。新非平凡逻辑加一个小测试；结尾一两行说明未检查内容与风险。Active level: " + c.ponytail : ""}`;
}
