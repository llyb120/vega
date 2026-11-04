import { zipSync, strToU8 } from "fflate";
import { renderMarkdown } from "./markdown.js";
import { formatBeijing } from "../../shared/time";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeXml = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ESC[c]);

function stamp(at = Date.now()) {
  return formatBeijing(at).replace(/[/: ]/g, (c) => (c === " " ? "_" : "-")) || String(at);
}

export function exportBasename(title = "任务结果", at = Date.now()) {
  const slug = String(title || "任务结果")
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "任务结果";
  return `${slug}_${stamp(at)}`;
}

function absoluteBlobSrc(html, origin = typeof location !== "undefined" ? location.origin : "") {
  return String(html || "").replace(
    /(<img\b[^>]*\bsrc=")(\/api\/(?:blobs|files)\/[^"]+)(")/gi,
    (_, a, path, b) => a + origin + path + b,
  );
}

// Mirrors the app's .markdown-body styles (style.css) so exports read like the result did on screen.
const PRINT_CSS = `
body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1b1f2a;margin:24px auto;padding:0 24px;max-width:960px;overflow-wrap:anywhere}
.doc-title{font-size:20px;line-height:1.4;margin:0 0 12px}
.markdown-body>:first-child{margin-top:0}
.markdown-body>:last-child{margin-bottom:0}
p{margin:0 0 8px}
h1,h2,h3,h4{line-height:1.35;margin:14px 0 6px}
.markdown-body h1{font-size:18px}
.markdown-body h2{font-size:16px}
.markdown-body h3,.markdown-body h4{font-size:14px}
ul,ol{margin:0 0 8px;padding-left:20px}
li{margin:2px 0}
hr{margin:14px 0;border:0;border-top:1px solid #e3e6ee}
a{color:#2860e1}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #d0d5e0;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f3f5fa;font-weight:600}
img{max-width:100%;height:auto;display:block;margin:8px 0;border-radius:8px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
:is(p,li,h3,h4,td,th,blockquote) code{background:#eef0f7;color:#3a3f8f;padding:1px 5px;border-radius:4px}
pre{background:#1b1f2a;color:#e3e7f2;padding:10px 12px;margin:0;overflow:auto;border-radius:0 0 8px 8px;white-space:pre-wrap}
.code-block{margin:8px 0;break-inside:avoid}
.code-head{background:#2a2f3d;color:#aab1c4;font-size:12px;padding:4px 12px;border-radius:8px 8px 0 0}
.code-copy{display:none}
.code-fold>summary{display:none}
blockquote{margin:0 0 8px;padding-left:12px;border-left:3px solid #c5cad8;color:#4b5568}
.markdown-table{overflow-x:auto;margin:8px 0 10px}
.request{margin:0 0 20px;padding:10px 14px;border-left:3px solid #c5cad8;background:#f6f7fb;border-radius:0 8px 8px 0;color:#3b4354}
.request-label{font-size:12px;font-weight:600;color:#6b7385;margin-bottom:4px}
.missing-image{display:block;margin:8px 0;padding:8px 10px;border:1px dashed #c5cad8;color:#8a4b00;background:#fff8ec}
@media print{body{margin:0;padding:0}}
`;

const ARCHIVED_IMG = /<img\b[^>]*\bsrc="(\/api\/(?:blobs|files)\/[^"]+)"[^>]*>/gi;

function base64(bytes) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/**
 * Fetch every archived image (/api/blobs/…, /api/files/…) the result shows, while the signed-in page can still read it.
 * The exported file is opened elsewhere (file://, mail, another browser) where the strict session cookie is not
 * sent, so linked archive images would break; the map holds a data: URI, or null when the image is unavailable.
 */
export async function fetchArchivedImages(markdown, fetcher = fetch) {
  const { html } = renderMarkdown(markdown || "");
  const paths = new Set([...html.matchAll(ARCHIVED_IMG)].map((m) => m[1].replace(/&amp;/g, "&")));
  const images = new Map();
  await Promise.all([...paths].map(async (path) => {
    try {
      const response = await fetcher(path, { credentials: "same-origin" });
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|bmp|avif)$/.test(mime)) throw Error(String(response.status));
      images.set(path, `data:${mime};base64,${base64(new Uint8Array(await response.arrayBuffer()))}`);
    } catch { images.set(path, null); }
  }));
  return images;
}

function inlineArchivedImages(html, images, origin) {
  return html.replace(ARCHIVED_IMG, (tag, src) => {
    const path = src.replace(/&amp;/g, "&"), data = images.get(path);
    if (data) return tag.replace(`src="${src}"`, `src="${data}"`).replace(/\sloading="lazy"/, "");
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] || "图片";
    // Never drop an image silently: say what is missing and where it was.
    return `<span class="missing-image">[图片无法导出：${alt}；原地址 ${escapeXml(origin + path)}]</span>`;
  });
}

/** A short document title from a task's request: its first line without Markdown markers, at most 60 chars. */
export function exportTitleOf(text, fallback = "任务结果") {
  const line = String(text || "").split(/\r?\n/).map((row) => row.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "").trim()).find(Boolean) || "";
  return line ? (line.length > 60 ? line.slice(0, 60) + "…" : line) : fallback;
}

// Exports are static: collapsed code folds open (print would hide them) and archived images are inlined or absolute.
function exportBody(markdown, images, base) {
  const html = renderMarkdown(markdown || "").html.replace(/<details class="code-fold">/g, '<details class="code-fold" open>');
  return images ? inlineArchivedImages(html, images, base) : absoluteBlobSrc(html, base);
}

/**
 * title: a short heading; request: the task's original request (Markdown), shown as a quoted block under it;
 * images: from fetchArchivedImages, to embed archived images; without it they stay absolute links to this server.
 */
export function buildResultHtmlDocument({ title, request, markdown, origin, images } = {}) {
  const base = origin || (typeof location !== "undefined" ? location.origin : "");
  const heading = escapeXml(title || "任务结果");
  const asked = String(request || "").trim()
    ? `<section class="request markdown-body"><div class="request-label">原始要求</div>${exportBody(request, images, base)}</section>`
    : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${heading}</title><style>${PRINT_CSS}</style></head>` +
    `<body><h1 class="doc-title">${heading}</h1>${asked}<main class="markdown-body">${exportBody(markdown, images, base)}</main></body></html>`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadHtml({ title, request, markdown, filename } = {}) {
  const doc = buildResultHtmlDocument({ title, request, markdown, images: await fetchArchivedImages(`${request || ""}\n\n${markdown || ""}`) });
  downloadBlob(new Blob([doc], { type: "text/html;charset=utf-8" }), (filename || exportBasename(title)) + ".html");
}

export async function printPdf({ title, request, markdown } = {}) {
  // Embedded images are already decoded when print runs; lazy archive links in a hidden frame may never load.
  const doc = buildResultHtmlDocument({ title, request, markdown, images: await fetchArchivedImages(`${request || ""}\n\n${markdown || ""}`) });
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const finish = () => { try { frame.remove(); } catch {} };
  if (!win) { finish(); throw Error("无法打开打印预览"); }
  win.document.open();
  win.document.write(doc);
  win.document.close();
  const run = () => {
    try {
      win.focus();
      win.print();
    } finally {
      setTimeout(finish, 1000);
    }
  };
  if (win.document.readyState === "complete") setTimeout(run, 50);
  else win.addEventListener("load", () => setTimeout(run, 50), { once: true });
}

function parseMarkdownTables(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const tables = [];
  const row = (line) => {
    if (!line.includes("|")) return;
    const cells = [""];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && ["\\", "|"].includes(line[i + 1])) cells[cells.length - 1] += line[++i];
      else if (ch === "|") cells.push("");
      else cells[cells.length - 1] += ch;
    }
    if (cells.length < 2) return;
    if (!cells[0].trim()) cells.shift();
    if (cells.length && !cells.at(-1).trim()) cells.pop();
    return cells.map((cell) => cell.trim());
  };
  for (let i = 0; i < lines.length; i++) {
    const header = row(lines[i]);
    const divider = header && row(lines[i + 1] || "");
    if (!header || !divider || divider.length !== header.length || !divider.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const body = [];
    i++;
    while (i + 1 < lines.length) {
      const cells = row(lines[i + 1]);
      if (!cells) break;
      body.push(cells);
      i++;
    }
    tables.push({ header, rows: body });
  }
  return tables;
}

function sheetXml(rows) {
  const built = rows.map((row, r) => {
    const cols = row.map((value, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cols}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${built}</sheetData></worksheet>`;
}

function colName(index) {
  let n = index, s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function buildXlsxBytes(markdown) {
  const tables = parseMarkdownTables(markdown);
  const rows = tables.length
    ? tables.flatMap((table, index) => {
        const block = [table.header, ...table.rows.map((row) => {
          const padded = [...row];
          while (padded.length < table.header.length) padded.push("");
          return padded.slice(0, table.header.length);
        })];
        return index ? [[""], ...block] : block;
      })
    : String(markdown || "").split(/\r\n?|\n/).map((line) => [line]);
  const width = Math.max(1, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const next = [...row];
    while (next.length < width) next.push("");
    return next;
  });
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="结果" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(normalized)),
  };
  return zipSync(files);
}

export function downloadXlsx({ title, markdown, filename } = {}) {
  const bytes = buildXlsxBytes(markdown);
  downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), (filename || exportBasename(title)) + ".xlsx");
}

function htmlToDocxParagraphs(markdown) {
  // Keep a readable plain-text-ish Word document; embed absolute image links as text when images are present.
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const origin = typeof location !== "undefined" ? location.origin : "";
  const paras = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      paras.push('<w:p><w:r><w:t></w:t></w:r></w:p>');
      continue;
    }
    const withLinks = trimmed
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
        const src = /^(?:\/api\/blobs\/|sqlite:blob\/)?blob-[a-f\d]{32}$/i.test(url)
          ? `${origin}/api/blobs/${url.replace(/^(?:\/api\/blobs\/|sqlite:blob\/)/, "")}`
          : /^\/api\/(?:blobs|files)\//.test(url) ? origin + url : url;
        return `${alt || "图片"}（${src}）`;
      })
      .replace(/(^|[\s：:])((?:\/api\/blobs\/|sqlite:blob\/)?blob-[a-f\d]{32})(?=$|[\s，。；！？、])/gi, (_, prefix, id) => {
        const src = `${origin}/api/blobs/${id.replace(/^(?:\/api\/blobs\/|sqlite:blob\/)/, "")}`;
        return `${prefix}${src}`;
      });
    paras.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(withLinks)}</w:t></w:r></w:p>`);
  }
  return paras.join("");
}

export function buildDocxBytes({ title, request, markdown } = {}) {
  const body = (String(request || "").trim() ? htmlToDocxParagraphs(`原始要求：\n${request}\n`) : "") + htmlToDocxParagraphs(markdown);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${escapeXml(title || "任务结果")}</w:t></w:r></w:p>${body}` +
    `<w:sectPr/></w:body></w:document>`;
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`),
    "word/document.xml": strToU8(document),
  };
  return zipSync(files);
}

export function downloadDocx({ title, request, markdown, filename } = {}) {
  const bytes = buildDocxBytes({ title, request, markdown });
  downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), (filename || exportBasename(title)) + ".docx");
}

/** HTML and PDF fetch archived images first, so this returns a promise for every format. */
export async function exportResult(format, { title, request, markdown } = {}) {
  const filename = exportBasename(title);
  if (format === "html") return downloadHtml({ title, request, markdown, filename });
  if (format === "pdf") return printPdf({ title, request, markdown });
  if (format === "docx") return downloadDocx({ title, request, markdown, filename });
  if (format === "xlsx") return downloadXlsx({ title, markdown, filename });
  throw Error("不支持的导出格式");
}
