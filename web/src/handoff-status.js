/** Display copy for a handoff status payload. File sync alone never says the computer can be closed. */
export function handoffHeadline(status) {
  if (!status || typeof status !== "object") return "还没有交接状态；依赖未核验，不能关闭电脑";
  if (status.canCloseComputer === true) return "云端已接管，可以关闭电脑";
  if (status.phase === "files_synced_local_dependent") return "文件已同步，仍依赖本地";
  if (status.phase === "needs_confirmation") return "需要确认后才继续：预览页面会刷新，未保存的草稿可能丢失";
  if (status.phase === "cloud_owned") return status.message || "云端已继续，但仍有未核验的依赖，不能关闭电脑";
  if (status.phase === "failed") return status.message || "交接失败，执行权未转移";
  if (typeof status.message === "string" && status.message) return status.message;
  return "依赖尚未在云端核验成功，不能关闭电脑";
}

export function handoffCanClose(status) {
  return status?.canCloseComputer === true && handoffHeadline(status) === "云端已接管，可以关闭电脑";
}
