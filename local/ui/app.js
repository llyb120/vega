import { marked } from "./marked.js";

marked.setOptions({ gfm: true, breaks: true, async: false });

// 页面在 /assistant/<令牌>/ui/index.html 上；数据接口就在同一前缀下的 api/。
const API = location.pathname.replace(/\/ui\/.*$/, "/") + "api/";

const el = {
  app: document.getElementById("app"),
  side: document.getElementById("side"),
  rail: document.getElementById("rail"),
  searchBtn: document.getElementById("searchBtn"),
  searchRow: document.getElementById("searchRow"),
  searchInput: document.getElementById("searchInput"),
  createBtn: document.getElementById("createBtn"),
  hero: document.getElementById("hero"),
  heroFace: document.getElementById("heroFace"),
  heroName: document.getElementById("heroName"),
  accFace: document.getElementById("accFace"),
  accBtn: document.getElementById("accBtn"),
  accName: document.getElementById("accName"),
  accState: document.getElementById("accState"),
  splitter: document.getElementById("splitter"),
  pill: document.getElementById("pill"),
  pillFace: document.getElementById("pillFace"),
  pillName: document.getElementById("pillName"),
  titleDrag: document.getElementById("titleDrag"),
  stream: document.getElementById("stream"),
  latest: document.getElementById("latest"),
  composer: document.getElementById("composer"),
  attachBtn: document.getElementById("attachBtn"),
  menu: document.getElementById("menu"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  toast: document.getElementById("toast"),
};

const state = {
  threads: { employees: [], groups: [] },
  current: "", title: "", avatar: "", authors: {},
  messages: [], lastSeq: 0, newFrom: 0, markGone: false,
  running: false, busy: false, stick: true,
  filter: "", online: true,
};

const esc = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const initials = (name) => (String(name || "").trim().slice(0, 1) || "·");

// 窗口由宿主进程持有：标题栏拖动、最小化/最大化/关闭都交给它（WebView2 的 postMessage）。
const post = (message) => {
  try { window.chrome.webview.postMessage(JSON.stringify(message)); return true; } catch { return false; }
};

// ── 牛马头像 ────────────────────────────────────────────
function botFor(preset, seed) {
  return window.BotAvatar.parseBotAvatar(preset) || window.BotAvatar.defaultBotAvatar(seed || "");
}

/** 一个头像的 SVG。animate=true 的渲染后由 driveAvatars() 挂转头/眨眼/呼吸。 */
function avatarHTML(preset, seed, animate, wrap) {
  const A = window.BotAvatar;
  const bot = botFor(preset, seed);
  const geo = A.BOT_SHAPE_GEOMETRY[bot.shape] || A.BOT_SHAPE_GEOMETRY.round;
  const uid = "b" + Math.random().toString(36).slice(2, 8);
  const pose = A.BOT_POSES[animate ? "center" : A.MESSAGE_POSE] || A.BOT_POSES.center;
  const face = A.projectFace(geo, pose.yaw, pose.pitch, 1);
  const svg = `<svg class="bot-avatar" data-bot="1" ${animate ? 'data-animate="1" ' : ""}data-shape="${esc(bot.shape)}" viewBox="0 0 100 100" role="img" aria-hidden="true">
    <defs>
      <radialGradient id="${uid}b" gradientUnits="userSpaceOnUse" cx="${face.light.x}" cy="${face.light.y}" r="62" fx="${face.light.x}" fy="${face.light.y}">
        <stop offset="0" stop-color="${A.shade(bot.hex, 0.32)}"/><stop offset="0.42" stop-color="${bot.hex}"/><stop offset="0.8" stop-color="${A.shade(bot.hex, -0.22)}"/><stop offset="1" stop-color="${A.shade(bot.hex, -0.42)}"/>
      </radialGradient>
      <radialGradient id="${uid}h"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <radialGradient id="${uid}s"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      <clipPath id="${uid}c"><path d="${geo.d}"/></clipPath>
    </defs>
    <ellipse class="bot-shadow" cx="${face.shadow.x}" cy="93.5" rx="${face.shadow.rx}" ry="4.5" fill="url(#${uid}s)" opacity="${face.shadow.opacity}"/>
    <g class="bot-body"><g transform="translate(50 50) scale(.9) translate(-50 -50)"><g data-face="1" transform="${face.body}">
      <path d="${geo.d}" fill="url(#${uid}b)"/>
      <g clip-path="url(#${uid}c)"><ellipse cx="${face.highlight.x}" cy="${face.highlight.y}" rx="17" ry="12" fill="url(#${uid}h)" transform-origin="50 50"/></g>
      <ellipse class="bot-eye" data-eye="l" cx="${face.left.cx}" cy="${face.left.cy}" rx="${face.left.rx}" ry="${face.left.ry}" opacity="${face.left.opacity}"/>
      <ellipse class="bot-eye" data-eye="r" cx="${face.right.cx}" cy="${face.right.cy}" rx="${face.right.rx}" ry="${face.right.ry}" opacity="${face.right.opacity}"/>
    </g></g></g>
  </svg>`;
  return `<span class="${wrap} bot">${svg}</span>`;
}

/** 头像有人脸就用 SVG，群聊/用户用首字母块。 */
function faceHTML(item, wrap, animate) {
  const isEmployee = item.kind !== "group" && String(item.thread || "").startsWith("employee:");
  if (!isEmployee) return `<span class="${wrap}">${esc(initials(item.name))}</span>`;
  return avatarHTML(item.avatar, item.thread.slice(9), animate, wrap);
}

/* 转头/眨眼/呼吸：照 BotAvatar 的弹簧模型，渲染后重挂定时器。 */
const avatarAnim = { timer: 0, blink: 0, raf: 0, nodes: [] };
function driveAvatars() {
  const A = window.BotAvatar;
  clearTimeout(avatarAnim.timer); clearTimeout(avatarAnim.blink);
  if (avatarAnim.raf) cancelAnimationFrame(avatarAnim.raf);
  avatarAnim.raf = 0; avatarAnim.nodes = [];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const svg of document.querySelectorAll("svg.bot-avatar[data-animate]")) {
    avatarAnim.nodes.push({ svg, head: { ...A.BOT_POSES.center, lid: 1 }, target: { ...A.BOT_POSES.center }, vel: { yaw: 0, pitch: 0 }, anticipate: 0, last: 0, look: "center", prev: undefined, blinkAt: [], playing: !reduced });
    svg.classList.add("animate");
  }
  if (!avatarAnim.nodes.length) return;
  const paint = (n) => {
    const face = A.projectFace(A.BOT_SHAPE_GEOMETRY[n.svg.dataset.shape] || A.BOT_SHAPE_GEOMETRY.round, n.head.yaw, n.head.pitch, n.head.lid);
    const g = n.svg.querySelector("[data-face]"), l = n.svg.querySelector('[data-eye="l"]'), r = n.svg.querySelector('[data-eye="r"]');
    if (g) g.setAttribute("transform", face.body);
    for (const [node, eye] of [[l, face.left], [r, face.right]]) if (node) {
      node.setAttribute("cx", eye.cx); node.setAttribute("cy", eye.cy);
      node.setAttribute("rx", eye.rx); node.setAttribute("ry", eye.ry); node.setAttribute("opacity", eye.opacity);
    }
  };
  const lidAt = (n, now) => {
    while (n.blinkAt.length && now - n.blinkAt[0] > 205) n.blinkAt.shift();
    if (!n.blinkAt.length || now < n.blinkAt[0]) return 1;
    const t = now - n.blinkAt[0];
    return t < 70 ? 1 - (t / 70) ** 2 * 0.95 : t < 95 ? 0.05 : 0.05 + 0.95 * (1 - (1 - (t - 95) / 110) ** 2);
  };
  const tick = (now) => {
    avatarAnim.raf = 0;
    let live = false;
    for (const n of avatarAnim.nodes) {
      if (!n.svg.isConnected) continue;
      live = true;
      const dt = Math.min(0.05, (now - (n.last || now)) / 1000); n.last = now;
      const goal = n.anticipate > 0 ? { yaw: n.head.yaw - (n.target.yaw - n.head.yaw) * 0.12, pitch: n.head.pitch - (n.target.pitch - n.head.pitch) * 0.12 } : n.target;
      n.anticipate -= dt * 1000;
      for (const key of ["yaw", "pitch"]) { const accel = 150 * (goal[key] - n.head[key]) - 15 * n.vel[key]; n.vel[key] += accel * dt; n.head[key] += n.vel[key] * dt; }
      n.head.lid = lidAt(n, now);
      paint(n);
    }
    if (live) avatarAnim.raf = requestAnimationFrame(tick);
  };
  const startRaf = () => { if (!avatarAnim.raf) avatarAnim.raf = requestAnimationFrame(tick); };
  const glance = () => {
    if (!avatarAnim.nodes.length) return;
    for (const n of avatarAnim.nodes) {
      if (!n.playing) continue;
      const next = A.nextPose(n.look, n.prev); n.prev = n.look; n.look = next;
      const base = A.BOT_POSES[next] || A.BOT_POSES.center, j = 0.35;
      n.target = { yaw: base.yaw * (1 + (Math.random() - 0.5) * j) + (Math.random() - 0.5) * j * 8, pitch: base.pitch * (1 + (Math.random() - 0.5) * j) + (Math.random() - 0.5) * j * 6 };
      if (Math.random() < 0.7) n.anticipate = 90;
    }
    startRaf();
    avatarAnim.timer = setTimeout(glance, A.holdDuration());
  };
  const blink = () => {
    if (!avatarAnim.nodes.length) return;
    const { delay, double } = A.blinkPlan();
    avatarAnim.blink = setTimeout(() => {
      const now = performance.now();
      for (const n of avatarAnim.nodes) { n.blinkAt.push(now); if (double) n.blinkAt.push(now + 260); }
      startRaf(); blink();
    }, delay);
  };
  avatarAnim.timer = setTimeout(glance, 200 + Math.random() * 300);
  blink();
  startRaf();
}

// ── 待确认 ──────────────────────────────────────────────
const askTask = (message) => (message?.delivery && Array.isArray(message.tasks) && message.tasks[0]) || undefined;
const askOpen = (message) => ["waiting", "approval"].includes(askTask(message)?.status);
const askBody = (text) => String(text ?? "").replace(/^\s*\*\*[^*]+\*\*\s*/, "").trim();

/** 审批按「允许/拒绝」，提问按输入框「提交回答」。status 变了就只剩记录，不再能点。 */
function askHTML(message) {
  const task = askTask(message);
  const approval = task.status === "approval";
  const badge = approval ? "需要你确认" : "需要你回答";
  const body = esc(askBody(message.displayText || message.text));
  const agent = `<span class="ask-agent">${esc(message.author?.name || state.title || "数字员工")}</span>`;
  let inner = `<div class="ask-head"><span class="ask-badge">${badge}</span>${agent}</div>`;
  if (task.title) inner += `<div class="ask-title">${esc(task.title)}</div>`;
  if (approval) {
    if (body) inner += `<pre class="ask-code">${body}</pre>`;
    inner += `<div class="ask-actions">
      <button type="button" class="btn primary" data-task="${esc(task.id)}" data-act="approve" data-ok="1">允许</button>
      <button type="button" class="btn reject" data-task="${esc(task.id)}" data-act="approve" data-ok="0">拒绝</button>
    </div>`;
  } else {
    inner += `<div class="ask-text">${body}</div>
    <textarea class="ask-input" data-answer="${esc(task.id)}" rows="2" placeholder="补充它要的信息，提交后接着做"></textarea>
    <div class="ask-actions">
      <button type="button" class="btn primary" data-task="${esc(task.id)}" data-act="answer">提交回答</button>
      <button type="button" class="btn reject" data-task="${esc(task.id)}" data-act="stop">拒绝</button>
    </div>`;
  }
  return `<section class="ask" data-ask="${esc(task.id)}">${inner}</section>`;
}

/** 会话行只放一行预览，markdown 记号会看着脏，先拍平。 */
const plain = (text) => String(text ?? "")
  .replace(/```[\s\S]*?```/g, "〔代码〕")
  .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
  .replace(/[`*_~#>]/g, "")
  .replace(/\s+/g, " ")
  .trim();

/** 只留安全的节点与属性：模型输出里的脚本、事件属性、javascript: 链接一律去掉。 */
function sanitize(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("script,iframe,object,embed,link,style,meta,base,form").forEach((node) => node.remove());
  tpl.content.querySelectorAll("*").forEach((node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      else if (["href", "src", "srcset", "xlink:href"].includes(name) && /^\s*(javascript|data:text\/html):/i.test(attr.value)) node.removeAttribute(attr.name);
    }
  });
  return tpl.innerHTML;
}

async function api(op, body) {
  const response = await fetch(API + op, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.statusMessage || data.error || ("HTTP " + response.status));
  return data;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = !message;
  clearTimeout(toast.timer);
  if (message) toast.timer = setTimeout(() => { el.toast.hidden = true; }, 4000);
}

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  el.accName.textContent = online ? "Vega 客户端" : "未连接站点";
  el.accState.textContent = online ? "已连接" : "在托盘里完成配对";
}

// ── 侧栏 ────────────────────────────────────────────────
function rowHTML(item) {
  const on = item.thread === state.current ? " on" : "";
  const status = item.waiting ? "等待你确认" : item.running ? "正在工作…" : item.lastText ? plain(item.lastText) : item.kind === "group" ? `${item.users} 人 · ${item.employees} 个牛马` : item.mine ? "我的牛马" : "共享牛马";
  const badge = item.unread ? `<span class="row-count">${item.unread > 99 ? "99+" : item.unread}</span>` : "";
  const face = faceHTML(item, "row-face", !!item.runningTasks);
  return `<button type="button" class="row${on}" data-thread="${esc(item.thread)}">
    ${face}
    <span class="row-text"><span class="row-name">${esc(item.name)}</span><span class="row-sub">${esc(status)}</span></span>${badge}
  </button>`;
}

function renderRail() {
  const query = state.filter.trim().toLowerCase();
  const keep = (item) => !query || String(item.name || "").toLowerCase().includes(query) || String(item.lastText || "").toLowerCase().includes(query);
  const { employees, groups } = state.threads;
  const rows = [...employees, ...groups].filter(keep);
  el.rail.innerHTML = rows.length ? rows.map(rowHTML).join("") : `<div class="empty">${query ? "没有匹配的会话" : "还没有牛马"}</div>`;
  for (const node of el.rail.querySelectorAll(".row")) node.addEventListener("click", () => open(node.dataset.thread));
  driveAvatars();
}

function threadOf(thread) {
  return [...state.threads.employees, ...state.threads.groups].find((item) => item.thread === thread);
}

// ── 会话 ────────────────────────────────────────────────
const seen = {
  key: (thread) => "vega.assistant.seen:" + thread,
  of(thread) { try { return Number(localStorage.getItem(this.key(thread))) || 0; } catch { return 0; } },
  at(thread, seq) { try { if (seq) localStorage.setItem(this.key(thread), String(seq)); } catch {} },
};

function stepOutputOf(message) {
  if (message.stepOutput && typeof message.stepOutput === "object") return message.stepOutput;
  const prefix = "**步骤产物（任务未完成）**\n\n", text = String(message.text || "");
  if (message.stepOutput !== true || !text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length), split = rest.indexOf("\n\n");
  return { label: split < 0 ? "历史步骤产物" : rest.slice(0, split), text: split < 0 ? rest : rest.slice(split + 2) };
}

function stepOutputHTML(message) {
  const output = stepOutputOf(message);
  if (!output) return "";
  const files = (output.files || []).filter((file) => /^blob-[a-f\d]{32}$/.test(file.blobId || ""));
  const content = output.text ? `<details><summary>查看内容</summary><div class="bubble md">${sanitize(marked.parse(output.text))}</div></details>` : "";
  const actions = files.map((file) => `<button type="button" data-step-file="${esc(file.blobId)}" data-step-name="${esc(file.name)}">下载 ${esc(file.name)}</button>`).join("") +
    (output.text ? `<button type="button" data-step-export="${Number(message.seq) || 0}">导出 Markdown</button>` : "");
  return `<section class="step"><strong>步骤产物${output.step ? ` · 第 ${Number(output.step)} 步` : ""}</strong><small>${esc(output.label || "")}</small>${content}${actions ? `<div class="step-actions">${actions}</div>` : ""}</section>`;
}

function messageHTML(message) {
  if (message.notice) return `<div class="notice"><span>${esc(message.text || "")}</span></div>`;
  if (message.role !== "user" && message.role !== "assistant") return "";
  const text = message.stepOutput === true && stepOutputOf(message) ? "步骤产物已保存。" : message.displayText || message.text || "";
  const mine = message.role === "user" && !message.author;
  const other = message.author && message.author.kind === "user" && !mine;
  const ask = message.role === "assistant" && askOpen(message);
  const body = ask ? askHTML(message) : text ? (message.role === "assistant" ? `<div class="bubble md">${sanitize(marked.parse(text))}</div>` : esc(text)) : "";
  const chips = [];
  if (message.images?.length) chips.push(`${message.images.length} 张图片`);
  if (message.files?.length) chips.push(`${message.files.length} 个文件`);
  const chipHTML = !ask && chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : "";

  // 用户自己的消息不画头像（和参考界面一致）；群里别人的消息带首字母块。
  let face = "";
  if (message.role === "user") {
    face = other ? `<span class="bubble-face">${esc(initials(message.author.name))}</span>` : "";
  } else if (state.current.startsWith("employee:")) {
    face = avatarHTML(state.avatar, state.current.slice(9), false, "bubble-face");
  } else {
    const key = message.author ? message.author.kind + ":" + message.author.id : "";
    const preset = state.authors[key]?.avatar;
    face = message.author?.kind === "employee" && preset
      ? avatarHTML(preset, message.author.id, false, "bubble-face")
      : `<span class="bubble-face">${esc(initials(message.author?.name || state.title))}</span>`;
  }

  const author = other ? `<div class="author">${esc(message.author.name)}</div>` : "";
  const classes = ["bubble"];
  if (ask) classes.push("asking");
  else if (message.role === "assistant") classes.push(body ? "md" : "");
  if (message.error) classes.push("error");
  if (message.progress) classes.push("typing");
  const wrapClass = ask ? "ask-wrap" : "";
  return `<div class="msg ${message.role === "user" ? "user" : "bot"}"><div class="msg-row">${face}
    <div class="bubble-wrap">${author}<div class="${classes.join(" ")}">${body}${chipHTML}</div>${stepOutputHTML(message)}</div></div>
  </div>`;
}

function renderStream(scroll = false) {
  const thread = state.current;
  if (!thread) return;
  const parts = state.messages.map((message) => messageHTML(message));
  const first = state.newFrom > 0 ? parts.findIndex((part, index) => part && state.messages[index].seq > state.newFrom) : -1;
  let html = parts.map((part, index) => (index > 0 && index === first ? `<div class="new-line${state.markGone ? " gone" : ""}"><span>新</span></div>` : "") + part).join("");
  if (state.running) {
    const face = state.current.startsWith("employee:") ? avatarHTML(state.avatar, state.current.slice(9), false, "bubble-face") : `<span class="bubble-face">${esc(initials(state.title))}</span>`;
    html += `<div class="msg bot"><div class="msg-row">${face}<div class="bubble-wrap"><div class="bubble typing">正在工作<span class="dots"><i></i><i></i><i></i></span></div></div></div></div>`;
  }
  el.stream.innerHTML = html || `<div class="welcome"><strong>还没有消息</strong><small>说一句话就能开工</small></div>`;
  driveAvatars();
  if (scroll || state.stick) scrollToEnd();
  el.latest.hidden = state.stick;
}

function scrollToEnd() {
  el.stream.scrollTop = el.stream.scrollHeight;
  state.stick = true;
  el.latest.hidden = true;
}

async function controlTask(taskId, action, extra) {
  if (state.busy) return;
  state.busy = true;
  try {
    await api("control", { thread: state.current, id: taskId, action, ...extra });
    setTimeout(pollMessages, 200);
    setTimeout(pollThreads, 200);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

function saveStepFile(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = String(name || "步骤产物").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el.stream.addEventListener("click", (event) => {
  const file = event.target.closest?.("[data-step-file]");
  if (file && !file.disabled) {
    file.disabled = true;
    void api("file", { blobId: file.dataset.stepFile }).then((result) => {
      const raw = atob(result.data), bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      saveStepFile(bytes, file.dataset.stepName, "application/octet-stream");
    }).catch((error) => toast(error.message)).finally(() => { file.disabled = false; });
    return;
  }
  const exportButton = event.target.closest?.("[data-step-export]");
  if (exportButton) {
    const message = state.messages.find((item) => item.seq === Number(exportButton.dataset.stepExport));
    const output = message && stepOutputOf(message);
    if (output?.text) saveStepFile(output.text, (output.label || "步骤产物").slice(0, 110) + ".md", "text/markdown;charset=utf-8");
    return;
  }
  const button = event.target.closest?.(".btn");
  if (!button || button.disabled) return;
  const { task, act, ok } = button.dataset;
  if (act === "approve") controlTask(task, "approve", { approved: ok === "1" });
  else if (act === "stop") controlTask(task, "stop", {});
  else if (act === "answer") {
    const input = el.stream.querySelector(`textarea[data-answer="${CSS.escape(task)}"]`);
    const text = input?.value.trim();
    if (!text) { input?.focus(); return; }
    controlTask(task, "answer", { text });
  }
});

function updateHead() {
  const item = threadOf(state.current);
  const name = state.title || item?.name || "";
  const status = item?.waiting ? "等待你确认" : state.running ? "正在工作…" : item ? (item.kind === "group" ? `${item.users} 人 · ${item.employees} 个牛马` : item.mine ? "我的牛马" : "共享牛马") : "";
  el.hero.hidden = !item;
  el.pill.hidden = !item;
  el.heroName.textContent = name;
  el.pillName.textContent = name;
  el.heroFace.innerHTML = item ? faceHTML(item, "hero-face", false) : "";
  el.pillFace.innerHTML = item ? faceHTML(item, "pill-face", false) : "";
  el.hero.title = status;
  el.pill.title = status;
}

async function open(thread) {
  if (!thread) return;
  state.current = thread;
  state.messages = [];
  state.lastSeq = 0;
  state.running = false;
  state.stick = true;
  state.avatar = "";
  state.authors = {};
  state.title = threadOf(thread)?.name || "";
  state.newFrom = seen.of(thread);
  state.markGone = false;
  try { localStorage.setItem("vega.assistant.thread", thread); } catch {}
  updateHead();
  renderRail();
  el.stream.innerHTML = `<div class="welcome"><strong>正在打开…</strong></div>`;
  try {
    const data = await api("messages", { thread, limit: 100 });
    if (state.current !== thread) return;
    state.messages = data.messages || [];
    state.lastSeq = data.lastSeq || (state.messages.at(-1)?.seq ?? 0);
    state.running = !!data.running;
    state.title = data.title || state.title;
    if (data.avatar !== undefined) state.avatar = data.avatar;
    if (data.authors !== undefined) state.authors = data.authors;
    setOnline(true);
    seen.at(thread, state.lastSeq);
    updateHead();
    renderStream(true);
    api("read", { thread }).then(() => {
      const item = threadOf(thread);
      if (item) { item.unread = 0; renderRail(); }
    }).catch(() => {});
  } catch (error) {
    setOnline(false);
    el.stream.innerHTML = `<div class="welcome"><strong>打不开这个会话</strong><small>${esc(error.message)}</small></div>`;
    toast(error.message);
  }
}

async function pollMessages() {
  const thread = state.current;
  if (!thread) return;
  try {
    const data = await api("messages", { thread, after: state.lastSeq });
    if (state.current !== thread) return;
    // 清空聊天/重置牛马会删掉历史，序号从 1 重新数：服务器序号比本地还小就整段重开。
    if (typeof data.lastSeq === "number" && data.lastSeq < state.lastSeq) { await open(thread); return; }
    const fresh = (data.messages || []).filter((m) => m.seq > state.lastSeq);
    const running = !!data.running;
    if (data.avatar !== undefined) state.avatar = data.avatar;
    if (data.authors !== undefined) state.authors = data.authors;
    if (fresh.length) {
      state.messages.push(...fresh);
      state.lastSeq = data.lastSeq || fresh.at(-1).seq;
      state.markGone = true;
      seen.at(thread, state.lastSeq);
    }
    if (fresh.length || running !== state.running) {
      state.running = running;
      updateHead();
      renderStream();
    }
  } catch {}
}

async function pollThreads() {
  try {
    const data = await api("threads", {});
    state.threads = { employees: data.employees || [], groups: data.groups || [] };
    setOnline(true);
    renderRail();
    if (!state.current) return;
    updateHead();
  } catch {
    setOnline(false);
  }
}

// ── 发送 ────────────────────────────────────────────────
async function send(text) {
  const value = (text ?? el.input.value).trim();
  if (!value || !state.current || state.busy) return;
  state.busy = true;
  el.send.disabled = true;
  try {
    await api("send", { thread: state.current, text: value });
    if (text === undefined) { el.input.value = ""; grow(); }
    state.running = true;
    state.stick = true;
    renderStream(true);
    setTimeout(pollMessages, 300);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    el.send.disabled = !el.input.value.trim();
  }
}

function grow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(34, Math.max(24, el.input.scrollHeight)) + "px";
  el.send.disabled = !el.input.value.trim() || !state.current;
}

// ── 事件 ────────────────────────────────────────────────
el.input.addEventListener("input", grow);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
});
el.composer.addEventListener("submit", (event) => { event.preventDefault(); send(); });
el.latest.addEventListener("click", scrollToEnd);
el.stream.addEventListener("scroll", () => {
  const gap = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight;
  state.stick = gap < 24;
  el.latest.hidden = state.stick;
});

el.searchBtn.addEventListener("click", () => {
  el.searchRow.hidden = !el.searchRow.hidden;
  if (!el.searchRow.hidden) el.searchInput.focus();
  else { el.searchInput.value = ""; state.filter = ""; renderRail(); }
});
el.searchInput.addEventListener("input", () => { state.filter = el.searchInput.value; renderRail(); });
el.createBtn.addEventListener("click", () => { if (state.current) send("/new"); });

// 设置就在客户端窗口里：同一枚令牌，/assistant/<令牌>/ui/ → /config/<令牌>。
function openSettings() {
  const match = location.pathname.match(/^\/assistant\/([^/]+)\//);
  if (match) location.href = "/config/" + match[1];
}
el.accBtn.addEventListener("click", openSettings);
el.accFace.addEventListener("click", openSettings);

el.attachBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  el.menu.hidden = !el.menu.hidden;
  el.attachBtn.classList.toggle("open", !el.menu.hidden);
});
el.menu.addEventListener("click", (event) => {
  const act = event.target.closest("button")?.dataset.act;
  el.menu.hidden = true;
  el.attachBtn.classList.remove("open");
  if (act === "new") send("/new");
  if (act === "settings") openSettings();
  if (act === "reload") { open(state.current); pollThreads(); }
});
document.addEventListener("click", () => { el.menu.hidden = true; el.attachBtn.classList.remove("open"); });

// 标题栏：拖动交给宿主（Windows 原生拖动），双击切换最大化。
el.titleDrag.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  if (!post({ drag: 1 })) return;
});
el.titleDrag.addEventListener("dblclick", () => post({ win: "max" }));
for (const button of document.querySelectorAll(".win-btn")) {
  button.addEventListener("click", () => {
    const act = button.dataset.win;
    if (!post({ win: act })) {
      // 不在宿主里（浏览器预览）：关闭就关标签页。
      if (act === "close") window.close();
    }
  });
}

// 双击分隔线收起/展开侧栏。
el.splitter.addEventListener("dblclick", () => el.app.classList.toggle("rail"));

async function boot() {
  try {
    const data = await api("threads", {});
    state.threads = { employees: data.employees || [], groups: data.groups || [] };
    setOnline(true);
    const wanted = decodeURIComponent((location.hash.match(/thread=([^&]+)/) || [])[1] || "") || localStorage.getItem("vega.assistant.thread") || "";
    const all = [...state.threads.employees, ...state.threads.groups];
    const first = all.find((item) => item.thread === wanted) || all[0];
    renderRail();
    if (first) await open(first.thread);
  } catch (error) {
    setOnline(false);
    el.stream.innerHTML = `<div class="welcome"><strong>连不上站点</strong><small>${esc(error.message)}</small></div>`;
    toast(error.message);
  }
}

boot();
setInterval(pollMessages, 1500);
setInterval(pollThreads, 5000);
