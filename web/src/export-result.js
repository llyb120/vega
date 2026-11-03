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
    /(<img\b[^>]*\bsrc=")(\/api\/blobs\/[^"]+)(")/gi,
    (_, a, path, b) => a + origin + path + b,
  );
}

const PRINT_CSS = `
body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1b1f2a;margin:24px;max-width:960px}
h1,h2,h3,h4{line-height:1.35;margin:14px 0 6px}
p{margin:0 0 8px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}
th,td{border:1px solid #d0d5e0;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f3f5fa}
img{max-width:100%;height:auto;display:block;margin:8px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef0f7;padding:1px 5px;border-radius:4px}
pre{background:#1b1f2a;color:#e3e7f2;padding:10px 12px;overflow:auto;border-radius:8px}
blockquote{margin:0 0 8px;padding-left:12px;border-left:3px solid #c5cad8;color:#4b5568}
.markdown-table{overflow-x:auto;margin:8px 0}
`;

export function buildResultHtmlDocument({ title, markdown, origin } = {}) {
  const { html } = renderMarkdown(markdown || "");
  const body = absoluteBlobSrc(html, origin || (typeof location !== "undefined" ? location.origin : ""));
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title || "任务结果")}</title><style>${PRINT_CSS}</style></head><body><h1>${escapeXml(title || "任务结果")}</h1>${body}</body></html>`;
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

export function downloadHtml({ title, markdown, filename } = {}) {
  const doc = buildResultHtmlDocument({ title, markdown });
  downloadBlob(new Blob([doc], { type: "text/html;charset=utf-8" }), (filename || exportBasename(title)) + ".html");
}

export function printPdf({ title, markdown } = {}) {
  const doc = buildResultHtmlDocument({ title, markdown });
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
          : url.startsWith("/api/blobs/") ? origin + url : url;
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

export function buildDocxBytes({ title, markdown } = {}) {
  const body = htmlToDocxParagraphs(markdown);
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

export function downloadDocx({ title, markdown, filename } = {}) {
  const bytes = buildDocxBytes({ title, markdown });
  downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), (filename || exportBasename(title)) + ".docx");
}

export function exportResult(format, { title, markdown } = {}) {
  const filename = exportBasename(title);
  if (format === "html") return downloadHtml({ title, markdown, filename });
  if (format === "pdf") return printPdf({ title, markdown });
  if (format === "docx") return downloadDocx({ title, markdown, filename });
  if (format === "xlsx") return downloadXlsx({ title, markdown, filename });
  throw Error("不支持的导出格式");
}
