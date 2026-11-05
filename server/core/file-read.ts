import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, basename, join } from "node:path";
import { assert } from "./util";
export async function readPath(cwd: string, input: string, fs = { stat }, home = homedir()) {
  let value = input.trim().replace(/^@/, "");
  if (value === "~" || /^~[\\/]/.test(value))
    value = join(home, value.slice(2));
  const first = resolve(cwd, value),
    name = basename(first),
    variants = [
      first,
      ...[
        name.replace(/[‘’]/g, "'"),
        name.replace(/ (AM|PM)/g, "\u202f$1"),
      ].map((v) => join(dirname(first), v)),
    ];
  for (const path of new Set(variants)) {
    try {
      if ((await fs.stat(path)).isFile()) return path;
    } catch (e: any) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    }
  }
  throw Error("File not found: " + input);
}
export function textSlice(content: string, offset = 1, limit = 2000, maxBytes = 50 * 1024) {
  assert(
    Number.isInteger(offset) &&
      offset >= 1 &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 20000,
    "Invalid offset/limit",
  );
  const lines = content.split(/\r?\n/);
  assert(
    offset <= lines.length,
    `Offset ${offset} is beyond end of file (${lines.length} lines total)`,
  );
  const selected: string[] = [];
  let bytes = 0;
  const end = Math.min(lines.length, offset - 1 + limit, offset - 1 + 2000);
  for (let at = offset - 1; at < end; at++) {
    const line = `${at + 1}|${lines[at]}`,
      size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) break;
    selected.push(line);
    bytes += size;
  }
  if (!selected.length)
    return {
      text: `[Line ${offset} exceeds${Math.round(maxBytes / 1024)}KiB. Use bounded shell extraction; no line was skipped.]`,
      firstLineExceedsLimit: true,
      truncated: true,
      hasMore: true,
      nextOffset: offset,
      totalLines: lines.length,
    };
  const nextOffset = offset + selected.length;
  return {
    text: selected.join("\n"),
    hasMore: nextOffset <= lines.length,
    nextOffset,
    totalLines: lines.length,
    truncated: nextOffset - 1 < end,
  };
}

/** Archive lines longer than this are split across consecutive numbered lines. */
export const ARCHIVE_WRAP = 2000;
/**
 * A SQLite archive (observation, tool output) as numbered pretty-JSON lines, paged like a text file.
 * Pages stay under ~12KiB so the JSON-escaped page fits one tool result (32KiB) and is never clipped.
 */
export function archiveSlice(value: unknown, offset?: number, limit?: number) {
  const lines = JSON.stringify(value, null, 1).split("\n").flatMap((line) => {
    const parts: string[] = [];
    for (let at = 0; at < line.length; at += ARCHIVE_WRAP) parts.push(line.slice(at, at + ARCHIVE_WRAP));
    return parts.length ? parts : [""];
  });
  return { ...textSlice(lines.join("\n"), offset, limit, 12 * 1024), wrappedAt: ARCHIVE_WRAP };
}
