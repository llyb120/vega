import type { Message } from "./store";
import { assert } from "./util";
export function builtinCommand(text: string) {
  const raw = text.replace(/^\[m\d+\]\s*/, ""),
    match = /^\s*\/(plan|easy|setup)(?:\s+|$)([\s\S]*)$/i.exec(raw);
  if (!match) return;
  const command = match[1].toLowerCase(),
    goal = match[2].trim();
  assert(goal, `/${command} requires a goal`);
  return { command, goal };
}
export function expandBuiltin(message: Message) {
  const parsed = builtinCommand(message.text || "");
  if (!parsed) return message.text;
  const { command, goal } = parsed,
    tag = /^\[m\d+\]\s*/.exec(message.text || "")?.[0] || "";
  if (command === "plan")
    return `${tag}请针对以下目标给出完整实施计划。直接规划并写出可执行步骤，不要反复追问细节；不确定处写明假设后继续。这个命令不切换权限模式。\n目标：${goal}`;
  if (command === "easy")
    return `${tag}请以快速小改动方式完成任务：只读直接相关代码，实施最小清晰修改，不重构不扩大范围。修改后只做最低成本编译/类型检查；不要运行或新增测试，不运行lint、集成、端到端或性能检查。发现任务不简单或需复杂验证时停止并说明原因，向用户确认。\n任务：${goal}`;
  return `${tag}为Vega配置Lyra聊天模型/provider。目标：${goal}\n配置存于SQLite，不要写旧Nova文件。用read path=sqlite:config查看脱敏配置，再用write path=sqlite:config保存严格JSON（__stored_secret__保留密钥）。仅允许修改provider、model和scenes，保留其他配置。provider支持api、options:{baseURL,apiKey,headers}、models:{ID:{limit:{context,output},modalities:{input:[text,image]},variants}}；支持预设和本地订阅，不能将订阅令牌发到自定义上游。地址/Token/模型不明时询问用户，不写占位值。Token不回显到回复或命令日志。保存会校验配置；区分本地校验与真实推理验证。`;
}
