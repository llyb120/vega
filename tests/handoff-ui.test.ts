import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handoffCanClose, handoffHeadline } from "../web/src/handoff-status.js";

const read = (path: string) => readFileSync(path, "utf8");

test("the close-computer line is shown only from the verified flag", () => {
  const synced = { phase: "files_synced_local_dependent", owner: "local", canCloseComputer: false, message: "文件已同步，仍依赖本地：预览。执行权仍在本机，不要关闭电脑。", deps: [{ status: "local" }] };
  assert.equal(handoffHeadline(synced), "文件已同步，仍依赖本地");
  assert.equal(handoffCanClose(synced), false);
  assert.equal(handoffCanClose({ canCloseComputer: false, message: "云端已接管，可以关闭电脑", deps: [] }), false);
  assert.match(handoffHeadline({ canCloseComputer: false, phase: "cloud_owned", message: "已在云端继续，但以下内容缺失" }), /不能关闭电脑|缺失/);
  assert.equal(handoffHeadline({ canCloseComputer: true, phase: "cloud_owned", deps: [{ status: "cloud" }] }), "云端已接管，可以关闭电脑");
  assert.equal(handoffHeadline(undefined), "还没有交接状态；依赖未核验，不能关闭电脑");
  assert.match(handoffHeadline({ phase: "needs_confirmation", canCloseComputer: false }), /草稿/);
});

test("the handoff panel is mounted and does not send migrate or reload consent by default", () => {
  const panel = read("web/src/WorkspaceHandoff.vue");
  const app = read("web/src/App.vue");
  const task = read("web/src/TaskDetail.vue");
  const session = read("web/src/EmployeeSessionView.vue");
  assert.match(panel, /handoffHeadline/);
  assert.match(panel, /data-can-close/);
  for (const action of ["checkpoint", "handoff", "recover", "sync_back", "transfer_back"]) assert.match(panel, new RegExp("run\\('" + action + "'\\)"));
  assert.match(panel, /acknowledgeReload = true/);
  assert.match(panel, /needs_confirmation/);
  assert.match(panel, /未保存的草稿可能丢失/);
  assert.match(panel, /migrateBrowser = true/);
  assert.match(panel, /migrate = ref\(false\)/);
  assert.match(panel, /confirmed = ref\(false\)/);
  assert.match(app, /handoff_changed/);
  assert.match(app, /handoffRevision/);
  assert.match(app, /WorkspaceHandoff/);
  assert.match(task, /WorkspaceHandoff/);
  assert.match(session, /WorkspaceHandoff/);
  assert.match(read("web/src/BrowserView.vue"), /云端浏览器，不是你电脑上的日常浏览器/);
  assert.doesNotMatch(panel, /migrateBrowser:\s*true/);
});
