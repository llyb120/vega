const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const MARK = String.fromCharCode(0);
const escape = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ESCAPES[c]);

const TOKEN = new RegExp(MARK + "(\\d+)" + MARK, "g");
/** Chrome screenshot basename: <32-hex>[-n].webp or live-<tag>-n.webp */
const SCREENSHOT_NAME = /^(?:[a-f\d]{32}(?:-\d+)?|live-[\w-]+)\.(?:webp|png|jpe?g)$/i;
/** Delimiters around a standalone archive URL / screenshot name in report prose. */
const BEFORE = "(^|[\\s：:，、,（【])";
const AFTER = "(?=$|[\\s，。；！？、）】]|[.,;!?](?=\\s|$))";

/** Task/session files directory as a web prefix, e.g. /api/files/employees/<id>/<taskId> */
export function filesArchiveBase(employeeId, taskId) {
  if (!employeeId || !taskId) return;
  return `/api/files/employees/${encodeURIComponent(String(employeeId))}/${encodeURIComponent(String(taskId))}`;
}

/** Absolute or relative disk path under the files tree → /api/files/… */
function archivePathURL(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)((?:employees|users|views)\/(?:[\w.-]+\/)+[\w.-]+\.(?:webp|png|jpe?g))$/i);
  if (!match || /(^|\/)\.\.?(\/|$)/.test(match[1])) return;
  return "/api/files/" + match[1].split("/").map(encodeURIComponent).join("/");
}

function imageURL(value) {
  // Prefer strict 32-hex archive ids (bare blob-… or prefixed); keep prefixed non-hex ids for fixtures/legacy.
  const hex = /^(?:\/api\/blobs\/|sqlite:blob\/)?(blob-[a-f\d]{32})$/i.exec(value);
  if (hex) return "/api/blobs/" + hex[1];
  const archived = /^(?:\/api\/blobs\/|sqlite:blob\/)(blob-[\w-]+)$/.exec(value);
  if (archived) return "/api/blobs/" + archived[1];
  // Archived Chrome screenshots (images[].url of a chrome result).
  if (/^\/api\/files\/(?:[\w.%-]+\/)*[\w.%-]+\.(?:webp|png|jpe?g)$/i.test(value) && !/(^|\/)\.\.?(\/|$)/.test(value.slice(11))) return value;
  const fromPath = archivePathURL(value);
  if (fromPath) return fromPath;
  // Bare Chrome screenshot filename when the page knows the task/session files directory.
  if (archiveBase && SCREENSHOT_NAME.test(value)) {
    const base = String(archiveBase).replace(/\/+$/, "");
    if (/^\/api\/files\/(?:[\w.%-]+\/)+[\w.%-]+$/i.test(base)) return `${base}/${encodeURIComponent(value)}`;
  }
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value))
    return value;
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return url.href;
  } catch {}
}

/**
 * "@名称" of known people, active only during one renderMarkdown call ({ name, id, link? } list; names are unique per
 * user and per group). Employees the reader can open become links; `link: false` (users, other people's employees in
 * a group) renders a highlighted mention only.
 */
let mentionPattern, mentionIds, archiveBase;
function useMentions(people) {
  const named = (people || []).filter((p) => p?.id && String(p.name || "").trim());
  mentionIds = new Map(named.map((p) => [String(p.name).trim(), { id: String(p.id), link: p.link !== false }]));
  const names = [...mentionIds.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Longest name first, so "@测试牛马处理" finds 测试牛马; "@" right after a letter or digit (an email) does not count.
  mentionPattern = names.length ? new RegExp(`(^|[^\\p{L}\\p{N}_])@(${names.join("|")})`, "gu") : undefined;
}

function imgTag(url, alt = "存档图片") {
  return `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

export function renderInline(text) {
  const fragments = [];
  const protect = (html, plain) => {
    fragments.push({ html, plain });
    return MARK + (fragments.length - 1) + MARK;
  };
  const source = String(text).replace(/\u0000/g, "")
    .replace(/`([^`\n]+)`/g, (_, code) => protect(`<code>${escape(code)}</code>`, code))
    .replace(
      /!\[([^\]\n]*)\]\([ \t]*(?:<([^<>\n]+)>|((?:\\[()\\]|[^()\s\\]|\([^()\s]*\))+))(?:[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'))?[ \t]*\)/g,
      (match, alt, bracketed, bare, doubleTitle, singleTitle) => {
        const url = imageURL((bracketed || bare).replace(/\\([()\\])/g, "$1"));
        if (!url) return protect(escape(match), match);
        alt = alt.replace(TOKEN, (_, i) => fragments[i].plain);
        const title = (doubleTitle ?? singleTitle)?.replace(TOKEN, (_, i) => fragments[i].plain);
        return protect(`<img src="${escape(url)}" alt="${escape(alt)}"${title === undefined ? "" : ` title="${escape(title)}"`} loading="lazy" decoding="async" referrerpolicy="no-referrer">`, alt);
      },
    )
    // Older task reports printed archive URLs / Chrome screenshot names instead of Markdown images.
    .replace(
      new RegExp(
        `${BEFORE}(` +
          `(?:\\/api\\/blobs\\/|sqlite:blob\\/)?blob-[a-f\\d]{32}` +
          `|\\/api\\/files\\/(?:[\\w.%-]+\\/)*[\\w.%-]+\\.(?:webp|png|jpe?g)` +
          `|(?:[A-Za-z]:)?(?:\\/[\\w.-]+)+\\/(?:employees|users|views)\\/(?:[\\w.-]+\\/)+[\\w.-]+\\.(?:webp|png|jpe?g)` +
          (archiveBase ? `|(?:[a-f\\d]{32}(?:-\\d+)?|live-[\\w-]+)\\.(?:webp|png|jpe?g)` : "") +
        `)${AFTER}`,
        "gi",
      ),
      (match, prefix, url) => {
        const src = imageURL(url);
        return src ? prefix + protect(imgTag(src), url) : match;
      },
    )
    .replace(mentionPattern || /(?!)()()/gu, (match, prefix, name) => {
      const { id, link } = mentionIds.get(name);
      return prefix + protect(link ? `<a class="mention" href="/employees/${encodeURIComponent(id)}" data-employee="${escape(id)}">@${escape(name)}</a>` : `<span class="mention">@${escape(name)}</span>`, "@" + name);
    });
  const html = escape(source)
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g,
      (_, label, url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  return html.replace(TOKEN, (_, i) => fragments[i].html);
}

function tableRow(line) {
  if (!line.includes("|")) return;
  const cells = [""];
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && ["\\", "|"].includes(line[i + 1]))
      cells[cells.length - 1] += line[++i];
    else if (char === "|") {
      cells.push("");
      pipes++;
    } else cells[cells.length - 1] += char;
  }
  if (!pipes) return;
  if (!cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (cells.length) return cells.map((cell) => cell.trim());
}

// shortcut: chat-oriented Markdown subset (no raw HTML or reference-style images);
// upgrade to a full parser if richer message formatting is required.
export function renderMarkdown(text, options = {}) {
  useMentions(options.mentions);
  archiveBase = options.archiveBase || undefined;
  try { return renderBlocks(text); } finally { useMentions(); archiveBase = undefined; }
}
function renderBlocks(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n"),
    html = [],
    codes = [];
  let paragraph = [],
    list = "",
    quote = [];
  const flush = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
      paragraph = [];
    }
    if (list) {
      html.push(`</${list}>`);
      list = "";
    }
    if (quote.length) {
      html.push(
        `<blockquote>${quote.map(renderInline).join("<br>")}</blockquote>`,
      );
      quote = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const language = line.trim().slice(3).trim(),
        body = [];
      while (i + 1 < lines.length && !/^\s*```/.test(lines[++i]))
        body.push(lines[i]);
      const code = body.join("\n");
      codes.push(code);
      const block = `<div class="code-block"><div class="code-head"><span>${escape(language || "code")}</span><button type="button" class="code-copy" data-code="${codes.length - 1}">复制</button></div><pre><code>${escape(code)}</code></pre></div>`;
      html.push(
        body.length > 18
          ? `<details class="code-fold"><summary>展开 ${escape(language || "code")} 代码 · ${body.length} 行</summary>${block}</details>`
          : block,
      );
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      flush();
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/),
      ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = unordered ? "ul" : "ol",
        item = unordered ? unordered[1] : ordered[2];
      if (paragraph.length || quote.length || (list && list !== tag)) flush();
      if (!list) {
        // Keep the author's numbering when a list resumes after other blocks ("4. …" after bullets).
        const start = ordered ? Number(ordered[1]) : 1;
        html.push(start !== 1 ? `<ol start="${start}">` : `<${tag}>`);
        list = tag;
      }
      html.push(`<li>${renderInline(item)}</li>`);
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      if (paragraph.length || list) flush();
      quote.push(quoted[1]);
      continue;
    }
    const header = tableRow(line),
      divider = header && tableRow(lines[i + 1] || "");
    if (
      header && divider?.length === header.length &&
      divider.every((cell) => /^:?-+:?$/.test(cell))
    ) {
      flush();
      const align = divider.map((cell) => {
        if (cell.endsWith(":")) return cell.startsWith(":") ? "center" : "right";
        return cell.startsWith(":") ? "left" : "";
      });
      const row = (cells, tag) => `<tr>${header.map((_, column) => {
        const scope = tag === "th" ? ' scope="col"' : "",
          style = align[column] ? ` style="text-align:${align[column]}"` : "";
        return `<${tag}${scope}${style}>${renderInline(cells[column] || "")}</${tag}>`;
      }).join("")}</tr>`;
      const body = [];
      i++;
      while (i + 1 < lines.length) {
        if (/^\s{0,3}(?:```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i + 1])) break;
        const cells = tableRow(lines[i + 1]);
        if (!cells) break;
        body.push(row(cells, "td"));
        i++;
      }
      html.push(`<div class="markdown-table" role="region" aria-label="表格" tabindex="0"><table><thead>${row(header, "th")}</thead><tbody>${body.join("")}</tbody></table></div>`);
      continue;
    }
    if (list || quote.length) flush();
    paragraph.push(line);
  }
  flush();
  return { html: html.join(""), codes };
}
