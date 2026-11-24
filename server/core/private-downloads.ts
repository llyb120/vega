import * as filesystem from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Obj } from "./util";

// Lists are browser-wide. Only verify the exact record requested, never guess which click created it.
export async function privateDownloadReceipt(result: Obj, id: unknown, directory: string, fs = filesystem) {
  const receipt = { ...result, directory };
  if (!result.downloads?.length) return { ...receipt, notice: "未检测到匹配的下载记录；页面可能仍在生成文件，或使用了不走下载管理器的保存方式。不要重复点击导出。" };
  const item = id && result.downloads.find((row: Obj) => row.id === id);
  if (!item) return { ...receipt, notice: `${result.notice || ""} 按时间和文件名确认后，用 downloadId 核实文件是否仍在私有目录。` };
  if (item.state !== "complete") return receipt;
  const path = item.path;
  if (typeof path !== "string" || !isAbsolute(path) || dirname(resolve(path)) !== directory || path !== resolve(path))
    return { ...receipt, saved: false, notice: "Chrome 报告下载完成，但路径不在当前下载目录（可能是历史记录）；未确认保存位置。" };
  try {
    if (!(await fs.lstat(directory)).isDirectory() || !(await fs.lstat(path)).isFile())
      return { ...receipt, saved: false, notice: "Chrome 报告下载完成，但私有下载目录中未找到对应的常规文件。" };
    return { ...receipt, saved: true, savedPath: path, notice: "已确认文件在服务端下载目录。" };
  } catch (error: any) {
    return { ...receipt, saved: false, notice: `Chrome 报告下载完成，但目前无法确认文件：${error.code || "文件不可访问"}。不要重复提交导出。` };
  }
}
