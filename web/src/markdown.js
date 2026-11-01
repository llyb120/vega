const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const MARK = String.fromCharCode(0);
const escape = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ESCAPES[c]);

const TOKEN = new RegExp(MARK + "(\\d+)" + MARK, "g");
function imageURL(value) {
  const archived = /^(?:\/api\/blobs\/|sqlite:blob\/)(blob-[\w-]+)$/.exec(value);
  if (archived) return "/api/blobs/" + archived[1];
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value))
    return value;
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return url.href;
  } catch {}
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
    // Older task reports printed archive URLs instead of Markdown images.
    .replace(
      /(^|[\s：:])((?:\/api\/blobs\/|sqlite:blob\/)blob-[a-f\d]{32})(?=$|[\s，。；！？、]|[.,;!?](?=\s|$))/g,
      (_, prefix, url) => prefix + protect(`<img src="${escape(imageURL(url))}" alt="存档图片" loading="lazy" decoding="async" referrerpolicy="no-referrer">`, url),
    );
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
export function renderMarkdown(text) {
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
      ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = unordered ? "ul" : "ol",
        item = (unordered || ordered)[1];
      if (paragraph.length || quote.length || (list && list !== tag)) flush();
      if (!list) {
        html.push(`<${tag}>`);
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
