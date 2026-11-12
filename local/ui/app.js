/* 桌面窗口：左栏牛马与群聊、右侧对话。数据走本机客户端 ./api/*（Go 端带设备凭据转发到站点），
   页面本身不接触站点 Cookie，也不保存凭据。 */
(function () {
"use strict";
const $ = (id) => document.getElementById(id);
const API = "./api/";
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, cls = "") => `<svg class="icon${cls ? " " + cls : ""}"><use href="#i-${name}"/></svg>`;
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

/* ── 接口 ───────────────────────────────────────────── */
async function api(op, body) {
  const response = await fetch(API + op, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || data.statusMessage || ("HTTP " + response.status));
  return data;
}

/* ── 状态 ───────────────────────────────────────────── */
const state = {
  threads: { employees: [], groups: [] },
  current: "", title: "", avatar: "", authors: {},
  messages: [], lastSeq: 0, running: false,
  newFrom: 0, markGone: false, unseen: 0, stick: true,
  me: null, client: null,
  query: "", busy: false,
  confirm: null, notice: null,
};

const STATUS = {
  queued: "排队中", running: "执行中", recovering: "自动恢复中", deferred: "等外部结果",
  waiting: "需要信息", approval: "需要确认", done: "已完成", failed: "失败",
  cancelled: "已取消", stopped: "已停止", sealed: "已封存",
};
const statusText = (s) => STATUS[s] || s || "";
const statusTone = (s) => s === "done" ? "done" : ["failed", "stopped", "cancelled"].includes(s) ? "bad" : "";
const endedStatus = (s) => ["done", "failed", "stopped", "cancelled", "sealed"].includes(s);

/* ── 头像 ───────────────────────────────────────────── */
const avatarAPI = window.BotAvatar;
function botFace(avatar, seed) {
  const bot = avatarAPI.parseBotAvatar(avatar) || avatarAPI.defaultBotAvatar(seed || "");
  const geometry = avatarAPI.BOT_SHAPE_GEOMETRY[bot.shape] || avatarAPI.BOT_SHAPE_GEOMETRY.round;
  const face = avatarAPI.projectFace(geometry, 0, 0, 1);
  const uid = "b" + Math.random().toString(36).slice(2, 9);
  return `<svg class="bot-avatar" viewBox="0 0 100 100" aria-hidden="true" data-shape="${esc(bot.shape)}">
  <defs>
    <radialGradient id="${uid}b" gradientUnits="userSpaceOnUse" cx="${face.light.x}" cy="${face.light.y}" r="62" fx="${face.light.x}" fy="${face.light.y}">
      <stop offset="0" stop-color="${avatarAPI.shade(bot.hex, 0.32)}"/><stop offset="0.42" stop-color="${bot.hex}"/><stop offset="0.8" stop-color="${avatarAPI.shade(bot.hex, -0.22)}"/><stop offset="1" stop-color="${avatarAPI.shade(bot.hex, -0.42)}"/>
    </radialGradient>
    <radialGradient id="${uid}h"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="${uid}s"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <clipPath id="${uid}c"><path d="${geometry.d}"/></clipPath>
  </defs>
  <ellipse cx="${face.shadow.x}" cy="93.5" rx="${face.shadow.rx}" ry="4.5" fill="url(#${uid}s)" opacity="${face.shadow.opacity}"/>
  <g class="bot-body"><g transform="translate(50 50) scale(.9) translate(-50 -50)"><g transform="${face.body}">
    <path d="${geometry.d}" fill="url(#${uid}b)"/>
    <g clip-path="url(#${uid}c)"><ellipse cx="${face.highlight.x}" cy="${face.highlight.y}" rx="17" ry="12" fill="url(#${uid}h)"/></g>
    <ellipse class="bot-eye" cx="${face.left.cx}" cy="${face.left.cy}" rx="${face.left.rx}" ry="${face.left.ry}" opacity="${face.left.opacity}"/>
    <ellipse class="bot-eye" cx="${face.right.cx}" cy="${face.right.cy}" rx="${face.right.rx}" ry="${face.right.ry}" opacity="${face.right.opacity}"/>
  </g></g></g>
</svg>`;
}
/** 一个头像：bot 预设画 SVG，上传的图片走本机代理，其它（旧星座预设）退回默认 bot。 */
function faceHTML(avatar, seed, ref) {
  if (typeof avatar === "string" && /^blob-[a-f\d]{32}$/.test(avatar)) {
    const query = ref && ref.startsWith("employee:") ? "employee=" + encodeURIComponent(ref.slice(9)) : "";
    if (query) return `<img class="face-img" alt="" src="${API}image?${query}">`;
  }
  return botFace(avatar, seed);
}
function initial(name) { return esc((String(name || "").trim().slice(0, 1) || "·")); }

/* ── 消息渲染 ───────────────────────────────────────── */
function plain(text) {
  return String(text ?? "").replace(/```[\s\S]*?```/g, "〔代码〕").replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1").replace(/[`*_~#>]/g, "").replace(/\s+/g, " ").trim();
}
function proxyImages(root) {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    const blob = /^\/api\/blobs\/(blob-[a-f\d]{32})$/.exec(src);
    const file = /^\/api\/files\/([^\s?#]+)$/.exec(src);
    if (blob) img.setAttribute("src", API + "image?blobId=" + encodeURIComponent(blob[1]));
    else if (file && !src.startsWith("http")) img.setAttribute("src", API + "image?path=" + encodeURIComponent(file[1]));
    img.setAttribute("loading", "lazy");
  }
}
function markdownHTML(text, archiveBase) {
  const host = document.createElement("div");
  try { host.innerHTML = window.renderMarkdown(String(text || ""), { archiveBase }).html; proxyImages(host); }
  catch { host.textContent = String(text || ""); }
  return host.innerHTML;
}
function quoteHTML(quote, name) {
  if (!quote) return "";
  return `<button type="button" class="quote" data-jump="${quote.seq}"><strong>${esc(quote.role === "user" ? "我" : name || "牛马")}</strong><span>${esc(plain(quote.text || ""))}</span></button>`;
}
function imagesHTML(message) {
  const list = message.images || [];
  if (!list.length) return "";
  const items = list.map((image) => {
    let src = "";
    if (image.data) src = `data:${image.mime};base64,${image.data}`;
    else if (image.blobId) src = `${API}image?blobId=${encodeURIComponent(image.blobId)}`;
    else if (image.url || image.path) src = `${API}image?path=${encodeURIComponent((image.url || "").replace(/^\/api\/files\//, "") || image.path)}`;
    return src ? `<img src="${esc(src)}" alt="附图" loading="lazy">` : "";
  }).join("");
  return items ? `<div class="attach">${items}</div>` : "";
}
function filesHTML(message) {
  const list = message.files || [];
  if (!list.length) return "";
  return `<div class="attach">${list.map((file) => `<span class="chip">${icon("file")}${esc(file.name || "文件")}${file.size ? " · " + sizeText(file.size) : ""}</span>`).join("")}</div>`;
}
function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}
function tasksHTML(message) {
  const list = message.tasks || [];
  if (!list.length) return "";
  return `<div class="attach">${list.map((task) => `<button type="button" class="chip task-chip" data-task="${esc(task.id)}" data-employee="${esc((state.current.split(":")[1] || ""))}">${icon("tasks")}<span>${esc(task.title || "任务")}</span>${statusText(task.status) ? `<span class="task-status ${statusTone(task.status)}">${esc(statusText(task.status))}</span>` : ""}</button>`).join("")}</div>`;
}
function askHTML(message, task) {
  const approval = task.status === "approval";
  const body = esc(plain(String(message.displayText || message.text || "").replace(/^\s*\*\*[^*]+\*\*\s*/, "")));
  return `<section class="ask" data-task="${esc(task.id)}">
    <div class="ask-head"><span class="ask-badge">${approval ? "需要你确认" : "需要你回答"}</span><span class="ask-task">${esc(task.title || "")}</span></div>
    ${body ? `<p class="ask-text">${body}</p>` : ""}
    ${approval ? "" : `<textarea class="ask-input" data-answer="${esc(task.id)}" rows="2" placeholder="补充它要的信息，提交后接着做"></textarea>`}
    <div class="ask-actions">
      ${approval
        ? `<button type="button" class="btn primary" data-act="approve" data-ok="1" data-task="${esc(task.id)}">允许</button><button type="button" class="btn" data-act="approve" data-ok="0" data-task="${esc(task.id)}">拒绝</button>`
        : `<button type="button" class="btn primary" data-act="answer" data-task="${esc(task.id)}">提交回答</button><button type="button" class="btn" data-act="stop" data-task="${esc(task.id)}">拒绝</button>`}
    </div>
  </section>`;
}
const askOpen = (message) => !!(message.delivery && message.tasks && message.tasks[0] && ["waiting", "approval"].includes(message.tasks[0].status));

function messageHTML(message) {
  if (!message) return "";
  if (message.notice) return `<div class="notice-line"><span>${esc(plain(message.text || ""))}</span></div>`;
  if (message.role !== "user" && message.role !== "assistant") return "";
  const mine = message.role === "user" && (!message.author || message.author.id === (state.me && state.me.id));
  const name = state.current.startsWith("group:") ? (message.author ? message.author.name : "") : state.title;
  const text = message.displayText || message.text || "";
  if (!mine && message.role === "assistant" && askOpen(message)) {
    const task = message.tasks[0];
    const ask = askHTML(message, task);
    if (state.current.startsWith("group:")) return `<div class="msg"><div class="ask-wrap">${ask}</div></div>`;
    return `<div class="msg">${ask}</div>`;
  }
  const quote = quoteHTML(message.quote, name);
  let inner = "";
  if (message.role === "assistant") inner = quote + (text ? `<div class="md">${markdownHTML(text, archiveBase())}</div>` : "");
  else inner = quote + (text ? `<div class="text">${esc(message.displayText || message.text)}</div>` : "");
  if (!inner && !(message.images || []).length && !(message.files || []).length && !(message.tasks || []).length) return "";
  if (message.error) inner = `<div class="md">${esc(plain(text))}</div>`;
  return `<div class="msg ${mine ? "user" : "bot"}" data-seq="${message.seq || ""}">
    <div class="bubble ${mine ? "user" : "bot"}${message.role === "assistant" && text && !message.error ? " md" : ""}${message.error ? " error" : ""}">${inner}${imagesHTML(message)}${filesHTML(message)}${tasksHTML(message)}</div>
  </div>`;
}
function archiveBase() {
  const employee = state.current.startsWith("employee:") ? state.current.slice(9) : "";
  const taskId = lastTaskId;
  return employee && taskId ? window.filesArchiveBase(employee, taskId) : "";
}
let lastTaskId = "";

/* ── 侧栏 ───────────────────────────────────────────── */
function railItems() {
  const q = state.query.trim().toLowerCase();
  const match = (item) => !q || String(item.name || "").toLowerCase().includes(q) || String(item.lastText || "").toLowerCase().includes(q);
  const all = state.threads.employees || [];
  const hero = all.find((item) => item.id === "default") || all[0] || null;
  return { hero, rest: all.filter((item) => item !== hero && match(item)), groups: (state.threads.groups || []).filter(match) };
}
function lineOf(item) {
  if (item.kind === "group") return plain(item.lastText) || `${item.users || 0} 人 · ${item.employees || 0} 个牛马`;
  if (item.running || item.runningTasks) return "正在工作…";
  if (item.attention) return `${item.attention} 项待你处理`;
  return plain(item.lastText) || (item.mine ? "我的牛马" : "共享牛马");
}
function rowHTML(item) {
  const on = item.thread === state.current ? " on" : "";
  const running = item.running || item.runningTasks > 0;
  const face = item.kind === "employee"
    ? faceHTML(item.avatar, item.id, "employee:" + item.id)
    : `<span class="row-letter">${initial(item.name)}</span>`;
  return `<button type="button" class="row${on}${item.unread ? " unread" : ""}" data-thread="${esc(item.thread)}">
    <span class="row-face${running ? " running" : ""}">${face}${item.unread ? `<span class="dot" aria-label="有未读消息"></span>` : ""}</span>
    <span class="row-text"><strong>${esc(item.name)}</strong><small>${esc(lineOf(item))}</small></span>
  </button>`;
}
function renderRail() {
  const { hero, rest, groups } = railItems();
  const heroNode = $("hero");
  if (hero) {
    heroNode.hidden = false;
    heroNode.classList.toggle("on", hero.thread === state.current);
    $("heroFace").innerHTML = faceHTML(hero.avatar, hero.id, "employee:" + hero.id);
    $("heroName").textContent = hero.name;
    heroNode.dataset.thread = hero.thread;
  } else heroNode.hidden = true;
  $("empList").innerHTML = rest.map(rowHTML).join("") || (!state.query ? `<p class="rail-empty">还没有牛马</p>` : "");
  $("grpList").innerHTML = groups.map(rowHTML).join("") || (!state.query ? `<p class="rail-empty">拉上同事和牛马一起干活</p>` : "");
}

/* hover 预览 */
let hoverTimer = 0;
function showHover(target, item) {
  clearTimeout(hoverTimer);
  const rect = target.getBoundingClientRect();
  const card = $("hoverCard");
  $("hoverFace").innerHTML = item.kind === "employee" ? faceHTML(item.avatar, item.id, "employee:" + item.id) : `<span class="row-letter">${initial(item.name)}</span>`;
  $("hoverName").textContent = item.name;
  $("hoverLine").textContent = lineOf(item);
  card.hidden = false;
  const width = card.offsetWidth, height = card.offsetHeight;
  let left = rect.right + 10;
  if (left + width > innerWidth - 8) left = rect.left - width - 10;
  card.style.left = Math.max(8, left) + "px";
  card.style.top = Math.min(innerHeight - height - 8, Math.max(8, rect.top + rect.height / 2 - height / 2)) + "px";
}
function hideHover() { clearTimeout(hoverTimer); $("hoverCard").hidden = true; }

/* ── 会话 ───────────────────────────────────────────── */
function threadOf(thread) {
  return [...(state.threads.employees || []), ...(state.threads.groups || [])].find((item) => item.thread === thread) || null;
}
function updatePill() {
  const item = threadOf(state.current);
  const pill = $("pill");
  if (!item) { pill.hidden = true; return; }
  pill.hidden = false;
  $("pillName").textContent = item.name || "牛马";
  $("pillFace").innerHTML = item.kind === "employee" ? faceHTML(state.avatar || item.avatar, item.id, "employee:" + item.id) : `<span class="row-letter">${initial(item.name)}</span>`;
}
function scrollBottom() {
  const stream = $("stream");
  stream.scrollTop = stream.scrollHeight;
  state.stick = true; state.unseen = 0; updateNewPill();
}
function updateNewPill() {
  const show = state.unseen > 0 && !state.stick;
  $("newPill").hidden = !show;
  if (show) $("newPillText").textContent = `${state.unseen} 条新消息`;
}
function renderStream(scroll) {
  const host = $("stream");
  if (!state.current) {
    host.innerHTML = `<div class="welcome">选一个牛马开始<small>左栏点一个牛马或群聊，就能在这里交代工作</small></div>`;
    return;
  }
  lastTaskId = "";
  const list = state.messages.slice(-400);
  const parts = [];
  let firstNew = -1;
  for (const message of list) {
    const html = messageHTML(message);
    if (html && firstNew < 0 && state.newFrom > 0 && message.seq > state.newFrom) firstNew = parts.length;
    if (html) parts.push(html);
    if (message.tasks && message.tasks[0] && endedStatus(message.tasks[0].status)) lastTaskId = message.tasks[0].id;
  }
  if (!parts.length) parts.push(`<div class="welcome">还没有消息<small>说一句话就能开工</small></div>`);
  if (firstNew >= 0 && !state.markGone) parts.splice(firstNew, 0, `<div class="new-line" role="separator">新</div>`);
  if (state.running) parts.push(`<div class="msg"><div class="bubble bot"><span class="typing">正在工作<i></i><i></i><i></i></span></div></div>`);
  host.innerHTML = parts.join("");
  if (scroll || state.stick) scrollBottom(); else updateNewPill();
}

async function open(thread) {
  if (!thread) return;
  hideHover();
  state.current = thread;
  state.messages = []; state.lastSeq = 0; state.running = false;
  state.stick = true; state.unseen = 0; state.avatar = ""; state.authors = {}; lastTaskId = "";
  state.title = threadOf(thread)?.name || "";
  state.newFrom = Number(store.get("seen:" + thread, "0")) || 0;
  state.markGone = false;
  store.set("thread", thread);
  updatePill();
  renderRail();
  $("stream").innerHTML = `<div class="welcome">正在打开…</div>`;
  try {
    const data = await api("messages", { thread, limit: 100 });
    if (state.current !== thread) return;
    state.messages = data.messages || [];
    state.lastSeq = data.lastSeq || (state.messages.at(-1)?.seq ?? 0);
    state.running = !!data.running;
    if (data.title) state.title = data.title;
    if (data.avatar !== undefined) state.avatar = data.avatar;
    if (data.authors !== undefined) state.authors = data.authors;
    seenAt(thread, state.lastSeq);
    updatePill();
    renderStream(true);
    markRead(thread);
    setSendState();
  } catch (error) {
    $("stream").innerHTML = `<div class="welcome">打不开这个会话<small>${esc(error.message)}</small></div>`;
    toast(error.message);
  }
}
function seenAt(thread, seq) { if (seq) store.set("seen:" + thread, String(seq)); }
async function markRead(thread) {
  try { await api("read", { thread }); const item = threadOf(thread); if (item) item.unread = 0; renderRail(); } catch {}
}

async function pollMessages() {
  const thread = state.current;
  if (!thread || state.busy) return;
  try {
    const data = await api("messages", { thread, after: state.lastSeq });
    if (state.current !== thread) return;
    if (typeof data.lastSeq === "number" && data.lastSeq < state.lastSeq) { await open(thread); return; }
    const fresh = (data.messages || []).filter((m) => m.seq > state.lastSeq);
    const running = !!data.running;
    if (data.avatar !== undefined) state.avatar = data.avatar;
    if (data.authors !== undefined) state.authors = data.authors;
    if (fresh.length) {
      state.messages.push(...fresh);
      state.lastSeq = data.lastSeq || fresh.at(-1).seq;
      state.markGone = true;
      state.unseen += fresh.filter((m) => m.role === "user" || m.role === "assistant").length;
      seenAt(thread, state.lastSeq);
      markRead(thread);
      const near = $("stream").scrollHeight - $("stream").scrollTop - $("stream").clientHeight < 64;
      if (near) state.stick = true;
    }
    if (fresh.length || running !== state.running) {
      state.running = running;
      renderStream();
      updatePill();
    }
  } catch {}
}
async function pollThreads() {
  try {
    const data = await api("threads", {});
    state.threads = { employees: data.employees || [], groups: data.groups || [] };
    renderRail();
    updatePill();
    if (!state.current) {
      const first = (state.threads.employees || [])[0];
      if (first) await open(store.get("thread", "") || first.thread);
    }
  } catch {}
}

/* ── 发送与控制 ─────────────────────────────────────── */
const input = $("input");
function setSendState() {
  $("sendBtn").disabled = !(state.current && String(input.value).trim());
}
function grow() {
  input.style.height = "auto";
  input.style.height = Math.min(120, input.scrollHeight) + "px";
}
async function send() {
  const text = String(input.value).trim();
  if (!text || !state.current || state.busy) return;
  state.busy = true;
  input.value = "";
  grow(); setSendState();
  try {
    await api("send", { thread: state.current, text });
    state.running = true; state.stick = true;
    renderStream(true);
    setTimeout(pollMessages, 200);
  } catch (error) { toast(error.message); input.value = text; grow(); setSendState(); }
  finally { state.busy = false; }
}
async function controlTask(taskId, action, extra) {
  try {
    await api("control", { thread: state.current, id: taskId, action, ...extra });
    setTimeout(pollMessages, 120);
    setTimeout(pollThreads, 120);
  } catch (error) { toast(error.message); }
}

/* ── 本机状态（确认卡、操作提示、连接） ─────────────── */
async function pollState() {
  try {
    const data = await api("state", {});
    const before = state.confirm && state.confirm.active;
    state.confirm = data.confirm || null;
    if (data.confirm && data.confirm.active && !before) { $("confirmText").textContent = data.confirm.text || ""; }
    const card = $("confirmCard");
    card.hidden = !(state.confirm && state.confirm.active);
    if (!card.hidden) $("confirmCount").textContent = state.confirm.left > 0 ? `${state.confirm.left} 秒后自动开始` : "";
    state.notice = data.notice || null;
    const notice = $("notice");
    notice.hidden = !state.notice;
    if (state.notice) $("noticeText").textContent = (state.notice.kind === "needs_review" ? "请核对： " : "") + state.notice.text;
    const banner = $("banner");
    const offline = data.connected === false;
    banner.hidden = !offline;
    if (offline) banner.innerHTML = `${icon("shield")}<span>还没连上站点：在托盘打开「设置」，用同一台电脑的浏览器登录站点完成连接授权</span>`;
    state.client = data;
    $("accState").textContent = offline ? "未连接" : "已连接";
    if (data.me && !state.me) { state.me = data.me; $("accName").textContent = state.me.name || ""; $("accFace").textContent = initial(state.me.name); }
  } catch {}
}
async function loadMe() {
  try { state.me = await api("me", {}); $("accName").textContent = state.me.name || ""; $("accFace").textContent = initial(state.me.name); }
  catch {}
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3600);
}

/* ── 窗口动作 ───────────────────────────────────────── */
function win(action) { void api("window", { action }).catch(() => {}); }
function openURL(body) { void api("open", body).catch((error) => toast(error.message)); }

/* ── 事件绑定 ───────────────────────────────────────── */
const hero = $("hero");
hero.addEventListener("click", () => hero.dataset.thread && open(hero.dataset.thread));
document.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (row) { void open(row.dataset.thread); return; }
  const jump = event.target.closest(".quote");
  if (jump) {
    $("stream").querySelector(`[data-seq="${jump.dataset.jump}"]`)?.scrollIntoView({ block: "center" });
    return;
  }
  const task = event.target.closest(".task-chip");
  if (task) {
    const origin = (state.client && state.client.origin) || "";
    if (origin) openURL({ url: origin + "/employees/" + encodeURIComponent(task.dataset.employee) + "/tasks/" + encodeURIComponent(task.dataset.task) });
    return;
  }
  const act = event.target.closest("[data-act]");
  if (act) {
    const id = act.dataset.task;
    const action = act.dataset.act;
    if (action === "approve") controlTask(id, "approve", { approved: act.dataset.ok === "1" });
    else if (action === "stop") controlTask(id, "stop");
    else if (action === "answer") {
      const box = document.querySelector(`.ask-input[data-answer="${id}"]`);
      const text = String(box?.value || "").trim();
      if (!text) { toast("先填写要补充的信息"); return; }
      controlTask(id, "answer", { text });
    }
    return;
  }
  const confirm = event.target.closest("[data-confirm]");
  if (confirm) {
    void api("confirm", { option: confirm.dataset.confirm }).catch(() => {});
    $("confirmCard").hidden = true;
    return;
  }
  if (!event.target.closest(".hover-card")) hideHover();
});
document.addEventListener("mousemove", (event) => {
  const row = event.target.closest(".row");
  if (!row) { if (!event.target.closest(".hover-card")) hideHover(); return; }
  const item = threadOf(row.dataset.thread);
  if (!item) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showHover(row, item), 90);
});

/* 输入条 */
$("composer").addEventListener("submit", (event) => { event.preventDefault(); void send(); });
input.addEventListener("input", () => { grow(); setSendState(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
});
$("attachBtn").addEventListener("click", () => toast("附件在网页里发给牛马"));
$("newPill").addEventListener("click", scrollBottom);
$("noticeClose").addEventListener("click", () => { $("notice").hidden = true; });

/* 侧栏 */
$("searchBtn").addEventListener("click", () => {
  const row = $("searchRow");
  row.hidden = !row.hidden;
  $("searchBtn").classList.toggle("on", !row.hidden);
  if (!row.hidden) $("searchInput").focus();
});
$("searchInput").addEventListener("input", (event) => { state.query = event.target.value; renderRail(); });
$("createBtn").addEventListener("click", () => openURL({ url: ((state.client && state.client.origin) || "") + "/groups/new" }));
const openAccount = () => openURL({ url: (state.client && state.client.origin) || "" });
$("accFace").addEventListener("click", openAccount);
$("accBtn").addEventListener("click", openAccount);
$("gearBtn").addEventListener("click", () => openURL({ config: true }));
$("shareBtn").addEventListener("click", () => {
  const id = state.current.split(":")[1];
  const origin = (state.client && state.client.origin) || "";
  if (!origin || !id) return openURL({ url: origin });
  openURL({ url: state.current.startsWith("employee:") ? `${origin}/employees/${encodeURIComponent(id)}` : `${origin}/groups/${encodeURIComponent(id)}` });
});

/* 拖动标题栏 / 双向最大化 / 窗口按钮 */
const bar = $("titlebar");
let dragging = false;
bar.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  if (event.detail === 2) { win("max"); return; }
  dragging = true;
  win("drag");
});
window.addEventListener("mouseup", () => { dragging = false; });
for (const button of document.querySelectorAll("[data-win]")) button.addEventListener("click", () => win(button.dataset.win));

/* 拖拽调宽 / 双击收起 */
const splitter = $("splitter"), app = $("app");
let resizing = false;
splitter.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  resizing = true;
  document.body.classList.add("resizing");
  const startX = event.clientX, startWidth = $("side").getBoundingClientRect().width;
  const move = (moveEvent) => {
    const width = Math.min(420, Math.max(200, startWidth + moveEvent.clientX - startX));
    app.style.setProperty("--side-w", width + "px");
  };
  const up = () => {
    resizing = false;
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    store.set("side-w", String(Math.round($("side").getBoundingClientRect().width)));
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  event.preventDefault();
});
splitter.addEventListener("dblclick", () => app.classList.toggle("rails"));
window.addEventListener("resize", () => { if ($("side").getBoundingClientRect().width < 160) app.classList.add("rails"); });

/* 外部点击收起 hover 卡 */
window.addEventListener("scroll", hideHover, true);
window.addEventListener("blur", hideHover);

/* ── 启动 ───────────────────────────────────────────── */
function restoreSidebar() {
  const width = Number(store.get("side-w", "318")) || 318;
  app.style.setProperty("--side-w", Math.min(420, Math.max(200, width)) + "px");
}
async function boot() {
  restoreSidebar();
  grow(); setSendState();
  await loadMe();
  await pollThreads();
  void pollState();
  setInterval(() => { if (!document.hidden) void pollMessages(); }, 1100);
  setInterval(() => { if (!document.hidden) void pollThreads(); }, 5000);
  setInterval(() => { if (!document.hidden) void pollState(); }, 2000);
}
boot();
})();
