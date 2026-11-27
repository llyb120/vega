import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { ArgumentError, checkArgs, employeeTools, toInternal, type ToolContext } from "../server/core/public-tools";
import { formatAssistAnswer, inferAssistFromText, safeExternalUrl, type TaskAssist } from "../shared/task-assist";

const taskCtx: ToolContext = { kind: "task" };
const askSchema = () => employeeTools(taskCtx).find((t) => t.name === "task_ask_user")!.parameters;

test("formatAssistAnswer handles choices, SETTLE_CHOICE, multiSelect, forms, verification codes, and limits", () => {
  const settleAssist: TaskAssist = {
    kind: "choice",
    options: [
      { label: "接受当前已有结论作为最终交付", value: "1", recommended: true },
      { label: "继续完成剩余步骤", value: "2", needsDetail: true },
    ],
    allowCustom: true,
  };
  assert.deepEqual(formatAssistAnswer(settleAssist, { selectedOptions: [0] }), { ok: true, text: "1" });
  assert.equal(formatAssistAnswer(settleAssist, { selectedOptions: [1] }).ok, false, "needsDetail requires custom text");
  assert.deepEqual(
    formatAssistAnswer(settleAssist, { selectedOptions: [1], customText: "补完第 3 步" }),
    { ok: true, text: "选择：继续完成剩余步骤 (2)\n补充说明：补完第 3 步" },
  );

  const multiAssist: TaskAssist = {
    kind: "choice",
    multiSelect: true,
    options: [{ label: "导出 PDF" }, { label: "同步飞书", value: "feishu" }],
  };
  assert.deepEqual(
    formatAssistAnswer(multiAssist, { selectedOptions: [0, 1] }),
    { ok: true, text: "选择：导出 PDF；同步飞书 (feishu)" },
  );

  const formAssist: TaskAssist = {
    kind: "form",
    fields: [
      { key: "env", label: "目标环境", type: "select", required: true, options: ["staging", "prod"] },
      { key: "token", label: "临时口令", type: "code", required: false },
      { key: "notify", label: "完成后通知我", type: "checkbox", required: true },
    ],
  };
  assert.equal(formatAssistAnswer(formAssist, { fieldValues: { env: "prod", notify: false } }).ok, false);
  assert.deepEqual(
    formatAssistAnswer(formAssist, { fieldValues: { env: "prod", token: "8848", notify: true } }),
    { ok: true, text: "目标环境：prod\n临时口令：8848\n完成后通知我：是" },
  );

  assert.deepEqual(
    formatAssistAnswer({ kind: "verification" }, { verificationCode: "123456" }),
    { ok: true, text: "123456" },
  );
  assert.equal(formatAssistAnswer(undefined, { customText: "x".repeat(8001) }).ok, false);
  assert.equal(safeExternalUrl("javascript:alert(1)"), undefined);
  assert.equal(safeExternalUrl("https://user:pass@example.com/a"), undefined);
  assert.equal(safeExternalUrl("https://example.com/login?a=1"), "https://example.com/login?a=1");
});

test("inferAssistFromText infers QR login, verification, browser action, and settings shortcuts conservatively", () => {
  assert.deepEqual(
    inferAssistFromText("当前 computer 场景未配置模型，请前往设置补充"),
    { kind: "settings", settingsRoute: "scenes", settingsLabel: "前往配置电脑场景模型" },
  );
  assert.deepEqual(
    inferAssistFromText("请去密码本添加该站点的登录账号"),
    { kind: "settings", settingsRoute: "vault", settingsLabel: "前往密码本配置" },
  );
  assert.deepEqual(
    inferAssistFromText("请使用微信扫码登录该页面", { tabTag: "T1", url: "https://wx.test/login" }),
    { kind: "qr_login" },
  );
  assert.deepEqual(
    inferAssistFromText("请输入手机收到的短信验证码"),
    { kind: "verification" },
  );
  assert.deepEqual(
    inferAssistFromText("请在浏览器标签页手动完成人机验证后继续", { tabTag: "T2", url: "https://site.test" }),
    { kind: "browser_action" },
  );
  assert.deepEqual(inferAssistFromText("请补充项目编号"), {});
});

test("task_ask_user schema preserves plain question mapping and validates structured assist fields", () => {
  const plain = toInternal("task_ask_user", checkArgs(askSchema(), { question: "code?" }), taskCtx);
  assert.deepEqual(plain, { tool: "employee", args: { action: "help", text: "code?" } });

  const rich = toInternal("task_ask_user", checkArgs(askSchema(), {
    question: "请扫码登录工作台，或选择跳过该站点。",
    kind: "qr_login",
    title: "微信扫码登录",
    hint: "二维码 2 分钟后过期",
    options: [
      { label: "我已扫码完成", value: "done", recommended: true },
      { label: "改用其他方式", needsDetail: true },
    ],
    images: [{ url: "qr.webp", caption: "登录二维码", volatile: true }],
    browser: { tabTag: "tab-1", url: "https://work.test/login", title: "工作台登录" },
    quickActions: [{ label: "我已扫码", reply: "已扫码" }],
    externalUrl: { url: "https://work.test/help", label: "登录帮助" },
    settingsRoute: "vault",
  }), taskCtx);

  assert.equal(rich.args.action, "help");
  assert.equal(rich.args.assist.kind, "qr_login");
  assert.equal(rich.args.assist.options.length, 2);
  assert.equal(rich.args.assist.browser.tabTag, "tab-1");
  assert.equal(rich.args.assist.settingsRoute, "vault");

  assert.throws(
    () => checkArgs(askSchema(), { question: "hi", kind: "unknown_kind" }),
    ArgumentError,
  );
  assert.throws(
    () => checkArgs(askSchema(), { question: "hi", settingsRoute: "invalid" }),
    ArgumentError,
  );
});

test("Files.resolveTaskImageUrl resolves task-scoped screenshots, -som clean paths, and blobs while rejecting external/traversal paths", async () => {
  const store = await Store.open(":memory:");
  try {
    const files = store.files;
    const session = await store.newSession({ cwd: process.cwd(), employeeId: "e1", taskId: "t1" });
    const name = "a".repeat(32) + "-0.webp";
    const somName = "a".repeat(32) + "-0-som.webp";
    const cleanPath = await files.write(session, name, "clean");
    await files.write(session, somName, "som");
    const expectedUrl = files.url(cleanPath);

    assert.equal(await files.resolveTaskImageUrl(session, name), expectedUrl);
    assert.equal(await files.resolveTaskImageUrl(session, files.url(join(files.task("e1", "t1"), somName))), expectedUrl);
    assert.equal(await files.resolveTaskImageUrl(session, "sqlite:blob/blob-" + "b".repeat(32)), "/api/blobs/blob-" + "b".repeat(32));
    assert.equal(await files.resolveTaskImageUrl(session, "https://evil.test/qr.png"), undefined);
    assert.equal(await files.resolveTaskImageUrl(session, "../other/qr.png"), undefined);
    assert.equal(await files.resolveTaskImageUrl(session, "javascript:alert(1)"), undefined);
  } finally {
    await store.close();
  }
});

test("Employee.execute help auto-enriches waitingAssist from current-turn browser_agent evidence, clears on answer, and exposes it in groups", async () => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  try {
    await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", "u1", "alice", "x", "operator", 0, Date.now(), 0);
    const created = await engine.employee.create({ name: "小助手" }, "u1");
    const emp = await engine.employee.for(created.id);
    const group = await engine.groups.create({ id: "u1", role: "operator" }, { name: "协作群", bulletin: "", employees: [created.id] });

    const { value: added } = await emp.execute("", { action: "add", kind: "todo", text: "登录内部系统并导出报表" });
    const workSession = await store.newSession({ cwd: process.cwd(), employeeId: created.id, taskId: added.id });
    const shotName = "c".repeat(32) + "-0.webp";
    const shotUrl = store.files.url(await store.files.write(workSession, shotName, "qr-bytes"));

    await emp.update((s) => {
      const task = emp.task(s, added.id);
      task.status = "running";
      task.workSession = workSession.id;
      task.group = { groupId: group.id, name: group.name, hop: 0, requester: { kind: "user", id: "u1", name: "alice" }, byOwner: true };
    });

    await store.append(workSession.id, { role: "user", text: "开始任务" });
    await store.append(workSession.id, {
      role: "tool",
      name: "browser_agent",
      callId: "call-browser-1",
      text: JSON.stringify({
        status: "blocked",
        evidence: {
          tabs: [{ tabTag: "TAB-QR", url: "https://sso.internal.test/qr", title: "内部工作台扫码登录" }],
          visitedUrls: [{ url: "https://sso.internal.test/qr", title: "内部工作台扫码登录" }],
          screenshots: [{ url: shotUrl }],
        },
      }),
    });

    emp.busy.set(added.id, { session: workSession.id } as any);
    try {
      await emp.execute(added.id, {
        action: "help",
        text: "需要扫码登录后才能继续，请扫码。",
      });
    } finally {
      emp.busy.delete(added.id);
    }

    let task = (await emp.state()).tasks.find((t) => t.id === added.id)!;
    assert.equal(task.status, "waiting");
    assert.equal(task.waitingAssist?.kind, "qr_login");
    assert.equal(task.waitingAssist?.browser?.tabTag, "TAB-QR");
    assert.equal(task.waitingAssist?.browser?.url, "https://sso.internal.test/qr");
    assert.equal(task.waitingAssist?.images?.[0]?.url, shotUrl);
    assert.equal(task.waitingAssist?.images?.[0]?.volatile, true);

    const groupView = await engine.groups.task({ id: "u1", role: "operator" }, group.id, created.id, added.id);
    assert.equal(groupView.waitingAssist?.kind, "qr_login");
    assert.equal(groupView.waitingAssist?.images?.[0]?.url, shotUrl);

    await emp.control({ id: added.id, action: "answer", text: "我已完成扫码登录，请继续原任务" });
    task = (await emp.state()).tasks.find((t) => t.id === added.id)!;
    assert.equal(task.status, "queued");
    assert.equal(task.waiting, "");
    assert.equal(task.waitingAssist, undefined);
  } finally {
    await engine.close();
    await store.close();
  }
});
