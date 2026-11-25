import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { Auth } from "../server/core/auth";
import { Redactor } from "../server/core/util";
import { PreviewTokens, handlePreviewRequest } from "../server/core/previews";
import { taskSummary } from "../server/core/employee";
import { EMPLOYEE_CHAT_DELIVERY_RULES, EMPLOYEE_TASK_RULES, sessionDynamicPrompt } from "../server/core/prompt";
import { renderInline } from "../web/src/markdown.js";

const owner = { id: "u1", username: "owner", role: "operator", disabled: false } as any;
const guest = { id: "u2", username: "guest", role: "operator", disabled: false } as any;
const outsider = { id: "u3", username: "outsider", role: "operator", disabled: false } as any;

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "vega-preview-"));
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  for (const user of [owner, guest, outsider]) {
    await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", user.id, user.username, "x", user.role, 0, Date.now(), 0);
  }
  const employee = await engine.employee.for((await engine.employee.create({ name: "WebMaker", cwd }, owner.id)).id);
  const chat = await employee.chat(owner.id);
  const created = await employee.execute("", { action: "add", kind: "todo", text: "制作静态网页" });
  const session = await store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, ownerId: owner.id, cwd, scene: "lightweight" });
  await employee.update((state) => {
    Object.assign(employee.task(state, created.value.id), {
      status: "running",
      workSession: session.id,
      plan: [{ content: "开发静态网站", status: "completed" }],
    });
  });
  employee.busy.set(created.value.id, { session: session.id, computer: false });
  const tools = await Tools.create(engine, session, await engine.config(), new AbortController().signal, () => {});
  const auth = new Auth(store, "fixture-token-at-least-16-bytes");
  const previewTokens = new PreviewTokens();
  t.after(async () => {
    employee.busy.clear();
    await engine.close();
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, store, engine, employee, chat, session, job: created.value.id, tools, auth, previewTokens };
}

test("静态前端目录产物托管到沙盒预览路由，支持权限隔离、会话吊销与目录清理", async (t) => {
  const f = await fixture(t);
  const siteDir = join(f.cwd, "finance-quiz");
  await mkdir(join(siteDir, "assets"), { recursive: true });
  await mkdir(join(siteDir, ".git"), { recursive: true });
  await mkdir(join(siteDir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(siteDir, "index.html"), '<!doctype html><html><link rel="stylesheet" href="./assets/styles.css"><script src="./assets/app.js"></script></html>');
  await writeFile(join(siteDir, "assets", "styles.css"), "body{color:#111}");
  await writeFile(join(siteDir, "assets", "app.js"), "console.log('ok');");
  await writeFile(join(siteDir, ".git", "HEAD"), "ref: refs/heads/main");
  await writeFile(join(siteDir, "node_modules", "pkg", "index.js"), "ignored");

  const completeRes = await f.tools.execute({
    id: "preview-complete",
    name: "task_complete",
    arguments: {
      evidence: "网页已实测通过",
      summary: "完成纯前端静态站点",
      deliverableRefs: [],
      preview: { dir: siteDir, title: "财管刷题学习" },
    },
  }, {} as any);
  assert.equal(completeRes.value.ok, true);
  assert.match(completeRes.value.previewUrl, /^\/preview\/pv-[a-f\d]{32}\/$/);

  const task = (await f.employee.findTask(f.job))!;
  assert.equal(task.preview.url, completeRes.value.previewUrl);
  assert.equal(task.preview.fileCount, 3, ".git 与 node_modules 应被跳过");
  assert.equal(task.preview.title, "财管刷题学习");
  assert.deepEqual(taskSummary(task).preview, { title: "财管刷题学习", url: task.preview.url });
  assert.equal(taskSummary(task).files, undefined);

  const group = await f.engine.groups.create(owner, { name: "前端群", users: [guest.id], employees: [f.employee.employeeId] });
  await f.employee.update((state) => {
    f.employee.task(state, f.job).group = { groupId: group.id, name: "前端群", hop: 0, requester: { kind: "user", id: guest.id, name: "guest" }, byOwner: false };
  });

  const ownerIssued = await f.auth.issue(owner);
  const guestIssued = await f.auth.issue(guest);
  const outsiderIssued = await f.auth.issue(outsider);
  const deps = { store: f.store, auth: f.auth, previewTokens: f.previewTokens };

  const unauth = await handlePreviewRequest(deps, { method: "GET", pathname: task.preview.url });
  assert.equal(unauth.status, 401);

  const denied = await handlePreviewRequest(deps, { method: "GET", pathname: task.preview.url, sessionCookie: outsiderIssued.token });
  assert.equal(denied.status, 404);

  const entryRes = await handlePreviewRequest(deps, { method: "GET", pathname: task.preview.url, sessionCookie: ownerIssued.token });
  assert.equal(entryRes.status, 302);
  const sandboxBase = entryRes.headers.Location;
  assert.match(sandboxBase, new RegExp(`^/preview/${task.preview.id}/_t/[A-Za-z0-9_-]+/$`));

  const htmlRes = await handlePreviewRequest(deps, { method: "GET", pathname: sandboxBase });
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(htmlRes.headers["Content-Security-Policy"], "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads");
  assert.equal(htmlRes.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(htmlRes.headers["X-Frame-Options"], "DENY");
  assert.match(htmlRes.body!.toString("utf8"), /styles\.css/);

  const cssRes = await handlePreviewRequest(deps, { method: "GET", pathname: sandboxBase + "assets/styles.css" });
  assert.equal(cssRes.status, 200);
  assert.equal(cssRes.headers["Content-Type"], "text/css; charset=utf-8");
  assert.equal(cssRes.headers["Content-Security-Policy"], undefined);
  assert.equal(cssRes.body!.toString("utf8"), "body{color:#111}");

  const traversalRes = await handlePreviewRequest(deps, { method: "GET", pathname: sandboxBase + "../../vega.db" });
  assert.equal(traversalRes.status, 404);
  const skippedRes = await handlePreviewRequest(deps, { method: "GET", pathname: sandboxBase + ".git/HEAD" });
  assert.equal(skippedRes.status, 404);

  const guestEntry = await handlePreviewRequest(deps, { method: "GET", pathname: task.preview.url, sessionCookie: guestIssued.token });
  assert.equal(guestEntry.status, 302);
  const guestHtml = await handlePreviewRequest(deps, { method: "GET", pathname: guestEntry.headers.Location });
  assert.equal(guestHtml.status, 200);

  await f.engine.groups.removeUser(owner, group.id, guest.id);
  const guestRevoked = await handlePreviewRequest(deps, { method: "GET", pathname: guestEntry.headers.Location });
  assert.equal(guestRevoked.status, 404, "被移出群聊后已发放的预览令牌立即失效");

  await f.auth.logout(ownerIssued.principal.hash);
  const loggedOut = await handlePreviewRequest(deps, { method: "GET", pathname: sandboxBase });
  assert.equal(loggedOut.status, 401, "退出登录后已发放的预览令牌立即失效");

  assert.match(
    renderInline(`[打开财管刷题](${task.preview.url})`),
    new RegExp(`<a href="${task.preview.url}" target="_blank" rel="noopener noreferrer">打开财管刷题</a>`),
  );

  f.employee.busy.clear();
  await f.employee.update((state) => { f.employee.task(state, f.job).status = "done"; });
  await f.employee.control({ action: "remove", id: f.job });
  const ownerReissued = await f.auth.issue(owner);
  const afterRemove = await handlePreviewRequest(deps, { method: "GET", pathname: task.preview.url, sessionCookie: ownerReissued.token });
  assert.equal(afterRemove.status, 404, "删除任务后预览记录与文件一起清理");
});

test("静态预览严格拦截缺失入口、凭据文件、目录外符号链接、本轮凭据与越界路径", async (t) => {
  const f = await fixture(t);
  const badDir = join(f.cwd, "bad-site");
  await mkdir(badDir, { recursive: true });
  await writeFile(join(badDir, "main.js"), "console.log(1)");

  await assert.rejects(f.tools.execute({
    id: "p-no-index",
    name: "task_progress",
    arguments: { message: "尝试发布", stepOutput: { step: 1, preview: { dir: badDir } } },
  }, {} as any), /入口文件不存在/);

  await writeFile(join(badDir, "index.html"), "<html></html>");
  await writeFile(join(badDir, ".env"), "SECRET=1");
  await assert.rejects(f.tools.execute({
    id: "p-env",
    name: "task_progress",
    arguments: { message: "尝试发布", stepOutput: { step: 1, preview: { dir: badDir } } },
  }, {} as any), /凭据文件/);
  await rm(join(badDir, ".env"));

  const outside = await mkdtemp(join(tmpdir(), "vega-preview-out-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "leak.txt"), "secret");
  try {
    await symlink(join(outside, "leak.txt"), join(badDir, "leak.txt"));
    await assert.rejects(f.tools.execute({
      id: "p-sym",
      name: "task_progress",
      arguments: { message: "尝试发布", stepOutput: { step: 1, preview: { dir: badDir } } },
    }, {} as any), /符号链接/);
    await rm(join(badDir, "leak.txt"));
  } catch (err: any) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(err.code)) throw err;
  }

  const redactor = new Redactor();
  redactor.add("vault-secret-preview");
  f.engine.redactors.set(f.session.id, redactor);
  await writeFile(join(badDir, "app.js"), "const k = 'vault-secret-preview';");
  await assert.rejects(f.tools.execute({
    id: "p-secret",
    name: "task_progress",
    arguments: { message: "尝试发布", stepOutput: { step: 1, preview: { dir: badDir } } },
  }, {} as any), /含有本轮凭据/);

  await assert.rejects(f.tools.execute({
    id: "p-outside",
    name: "task_progress",
    arguments: { message: "尝试发布", stepOutput: { step: 1, preview: { dir: outside } } },
  }, {} as any), /工作区内/);
});

test("静态预览支持本机客户端目录采集并保留 stepOutput 预览", async (t) => {
  const f = await fixture(t);
  const clientId = "c".repeat(32);
  f.engine.localAgents.connect(owner.id, { clientId, instance: "b".repeat(32), name: "Win", cwd: "C:\\work", platform: "windows" });
  const localSess = await f.store.newSession({
    employeeId: f.employee.employeeId,
    taskId: f.job,
    ownerId: owner.id,
    cwd: "C:\\work",
    scene: "lightweight",
    localAgent: true,
    clientId,
    localPlatform: "windows",
  });
  await f.employee.update((state) => {
    f.employee.task(state, f.job).workSession = localSess.id;
  });
  f.employee.busy.set(f.job, { session: localSess.id, computer: false });
  const localTools = await Tools.create(f.engine, localSess, await f.engine.config(), new AbortController().signal, () => {});
  const ops: string[] = [];
  (f.engine.localAgents as any).request = async (_agent: unknown, op: string, args: any) => {
    assert.equal(op, "file");
    ops.push(args.op);
    if (args.op === "stat") return { path: "C:\\work\\site", isDir: true };
    if (args.op === "list") return { root: "C:\\work\\site", files: [{ path: "index.html", size: 20 }, { path: "app.js", size: 15 }] };
    if (args.op === "read_workspace") {
      if (args.path.endsWith("index.html")) return { path: args.path, content: Buffer.from("<h1>Local</h1>").toString("base64") };
      return { path: args.path, content: Buffer.from("window.ok=1;").toString("base64") };
    }
    throw Error("unexpected op " + args.op);
  };

  const stepCall = {
    id: "local-step-preview",
    name: "task_progress",
    arguments: {
      message: "已生成本地前端预览",
      stepOutput: { step: 1, preview: { dir: "C:\\work\\site", title: "本地站点" } },
    },
  };
  await f.store.append(localSess.id, { role: "assistant", model: "fixture/model", text: "", calls: [stepCall] });
  const res = await localTools.execute(stepCall, {} as any);
  assert.equal(res.value.ok, true);
  assert.match(res.value.stepOutput.previewUrl, /^\/preview\/pv-[a-f\d]{32}\/$/);
  assert.match(res.value.next, /绑定用户登录态的平台鉴权沙盒预览地址/);
  assert.match(res.value.next, /task_complete\.preview/);
  assert.deepEqual(ops, ["stat", "list", "read_workspace", "read_workspace"]);
  const chatMsg = (await f.store.messages(f.chat.id)).find((m) => m.stepOutput)!;
  assert.equal(typeof chatMsg.stepOutput === "object" && chatMsg.stepOutput.preview?.url, res.value.stepOutput.previewUrl);
});

test("已有冻结沟通会话与任务会话均注入泛用产物交付规则，taskSummary 同步暴露 files", async (t) => {
  const f = await fixture(t);
  f.chat.frozenSystem = "legacy frozen chat prompt";
  await f.store.saveSession(f.chat);
  const chatTools = await Tools.create(f.engine, f.chat, await f.engine.config(), new AbortController().signal, () => {});
  const chatRules = await chatTools.rules();
  assert(chatRules.includes(EMPLOYEE_CHAT_DELIVERY_RULES));
  assert.match(chatRules, /先核对关联任务摘要中是否已有现成的 preview 或 files/);
  assert.match(chatRules, /已有 files 直接告知用户可在原任务交付中下载/);
  assert.match(chatRules, /不要擅自把底层实现或运维做法/);

  const taskRules = await f.tools.rules();
  assert(taskRules.includes(EMPLOYEE_TASK_RULES));
  assert.match(EMPLOYEE_TASK_RULES, /产物交付优先使用平台内置通道/);
  assert.match(EMPLOYEE_TASK_RULES, /禁止在执行环境自起常驻本地服务或端口进程充当交付地址/);
  assert.match(EMPLOYEE_TASK_RULES, /勿用无登录态浏览器猜测平台域名访问/);
  assert.match(EMPLOYEE_TASK_RULES, /仅可起短生命周期临时服务并在验证后立即关闭/);
  assert.match(EMPLOYEE_TASK_RULES, /bash\(detach=true\)/);
  assert.match(EMPLOYEE_TASK_RULES, /bash_poll\(kill=true\)/);

  const serverSameSide = await sessionDynamicPrompt(
    { ...f.session, localAgent: false, localBrowser: false },
    await f.engine.config(),
    f.store,
  );
  assert.match(serverSameSide, /当前浏览器：服务端私有 Chrome（与当前命令端同机/);
  const crossSide = await sessionDynamicPrompt(
    { ...f.session, localAgent: false, localBrowser: true, browserClientId: "c1" },
    await f.engine.config(),
    f.store,
  );
  assert.match(crossSide, /当前浏览器：客户端 Chrome（与当前命令端不在同一台机器/);
  const clientSameSide = await sessionDynamicPrompt(
    { ...f.session, localAgent: true, clientId: "c1", localBrowser: true, browserClientId: "c1" },
    await f.engine.config(),
    f.store,
  );
  assert.match(clientSameSide, /当前浏览器：客户端 Chrome（与当前命令端同机/);

  await f.employee.update((state) => {
    f.employee.task(state, f.job).deliverableFiles = [
      { name: "bundle.zip", mime: "application/octet-stream", size: 12, blobId: "blob-1" },
    ];
  });
  const updated = (await f.employee.findTask(f.job))!;
  assert.deepEqual(taskSummary(updated).files, ["bundle.zip"]);
});
