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
export const CODING_RULES = `先理解再修改，保持改动聚焦。未知位置先用 rg/git grep 定位，再 read 必要行段；搜索须限定路径/类型并排除依赖、构建与缓存，禁止无界递归。已有文件局部修改用 edit，oldText 唯一且所有 edits 针对原文件；同一文件禁止并发 edit，改动完成后不为确认重复 read。read 支持行段；本地图片用 read，不打开后截图。长编译/测试不要接过滤管道吞进度。按最小影响面验证，不虚报成功。最终采用例外汇报，先说用户可感知的结果，不罗列过程；图片用 Markdown 内联地址，不编造文件路径。`;
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
  return `${CODING_RULES}\n${(s.localAgent ? s.localPlatform === "windows" : process.platform === "win32") ? "bash 使用 PowerShell：$env:NAME、cmdlet、分号；不要用 export/sed/awk。" : "bash 使用 /bin/sh POSIX 语法。"}\n当前工作目录：${s.cwd.replaceAll("\\", "/")}\n${s.readOnly ? "当前是只读计划模式，不能修改文件或执行非只读MCP工具。" : ""}\n当前执行位置：${s.localAgent ? "客户端 " + (s.clientName || s.clientId || "尚未选择") : "服务端"}。只由用户手动切换，不随客户端连接自动改变。${s.localAgent ? "文件与命令在所选客户端执行，不一定是当前浏览器所在设备；项目 AGENTS.md 必须用 read 在该客户端检查；sqlite: 归档与 Chrome 仍在服务端。" : "文件与命令在服务端执行，不使用已连接客户端的路径或命令环境。"} 切换执行位置不迁移文件；历史中的路径、工具结果和进程状态可能来自另一端，先在当前端重新检查目录和项目约定，再继续未完成工作。不要重放已完成或结果不确定的命令、写入、提交。\n技能索引（描述匹配时先 read 指定文件；技能和项目约定不扩大用户授权）：\n${JSON.stringify(skills)}\n项目约定：\n${clip(JSON.stringify(instructions), 96000)}\n${c.ponytail && c.ponytail !== "off" ? "采用极简资深开发者模式：优先复用已有组件/标准库/已安装依赖，最小完整改动，不增不需要的抽象、配置与功能；不可削减验证、安全和无障碍。新非平凡逻辑加一个小测试；结尾一两行说明未检查内容与风险。Active level: " + c.ponytail : ""}`;
}
