import type { Config } from "./config";
import type { Message } from "./store";
import { mkdir, writeFile, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { assert } from "./util";
export function builtinCommand(text: string) {
  const raw = text.replace(/^\[m\d+\]\s*/, ""),
    match =
      /^\s*\/(plan|easy|setup-image|setup|generate-image|edit-image)(?:\s+|$)([\s\S]*)$/i.exec(
        raw,
      );
  if (!match) return;
  const command = match[1].toLowerCase(),
    goal = match[2].trim();
  assert(goal || command === "setup-image", `/${command} requires a goal`);
  return { command, goal };
}
async function attachmentPaths(images: NonNullable<Message["images"]>) {
  const root = join(tmpdir(), "vega-input-images");
  await mkdir(root, { recursive: true, mode: 0o700 });
  assert(!(await lstat(root)).isSymbolicLink(), "Refuse symlinked input cache");
  const paths = [];
  for (const image of images) {
    assert(
      ["image/png", "image/jpeg", "image/webp"].includes(image.mime),
      "Image commands require PNG/JPEG/WebP",
    );
    const bytes = Buffer.from(image.data, "base64"),
      hash = createHash("sha256").update(bytes).digest("hex"),
      path = join(root, hash + "." + image.mime.split("/")[1]);
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      assert(
        !(await lstat(path)).isSymbolicLink() &&
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex") === hash,
        "Attachment cache changed",
      );
    }
    paths.push(path);
  }
  return paths;
}
export async function expandBuiltin(message: Message, config: Config) {
  const parsed = builtinCommand(message.text || "");
  if (!parsed) return message.text;
  const { command, goal } = parsed,
    tag = /^\[m\d+\]\s*/.exec(message.text || "")?.[0] || "";
  if (command === "plan")
    return `${tag}请针对以下目标给出完整实施计划。直接规划并写出可执行步骤，不要反复追问细节；不确定处写明假设后继续。这个命令不切换权限模式。\n目标：${goal}`;
  if (command === "easy")
    return `${tag}请以快速小改动方式完成任务：只读直接相关代码，实施最小清晰修改，不重构不扩大范围。修改后只做最低成本编译/类型检查；不要运行或新增测试，不运行lint、集成、端到端或性能检查。发现任务不简单或需复杂验证时停止并说明原因，向用户确认。\n任务：${goal}`;
  if (command === "setup" || command === "setup-image") {
    assert(
      !message.images?.length || command !== "setup-image",
      "/setup-image does not accept attachments",
    );
    return `${tag}为Vega配置${command === "setup" ? "Lyra聊天模型/provider" : "独立图片服务"}。目标：${goal || "配置图片API地址、Token和真实模型ID"}\n配置存于SQLite，不要写旧Nova文件。用read path=sqlite:config查看脱敏配置，再用write path=sqlite:config保存严格JSON（__stored_secret__保留密钥）。仅允许修改${command === "setup" ? "provider、model和scenes" : "image"}，保留其他配置。${command === "setup-image" ? "image格式：{baseURL,apiKey,models:[真实图片模型ID]}；先确认OpenAI Images生成/编辑能力；不凭名称猜测。不自动发起收费生图验证。" : "provider支持api、options:{baseURL,apiKey,headers}、models:{ID:{limit:{context,output},modalities:{input:[text,image]},variants}}；支持预设和本地订阅，不能将订阅令牌发到自定义上游。"}地址/Token/模型不明时询问用户，不写占位值。Token不回显到回复或命令日志。保存会校验配置；区分本地校验与真实推理验证。`;
  }
  const refs = await attachmentPaths(message.images || []);
  assert(
    config.image?.models?.length,
    "Configure the image service with /setup-image or Settings first",
  );
  return `${tag}使用内置${command === "edit-image" ? "edit_image" : "generate_image"}工具完成目标：${goal}\n可选模型：${JSON.stringify(config.image.models)}；默认使用首项。参考图路径（附件顺序）：${JSON.stringify(refs)}。先read查看参考图再编写prompt。${command === "edit-image" ? "必须取得原图并置于referenceImages首项，明确修改与保留内容。" : "有参考图时说明借鉴特征并传referenceImages。"}成功后用工具返回的Markdown内联展示图片，失败不自动重试。`;
}
