import * as filesystem from "node:fs/promises";
import type { CloudRuntime } from "./cloud";
import {
  readFile,
  stat,
  lstat,
  readdir,
  realpath,
  mkdir,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import {
  resolve,
  dirname,
  join,
  relative,
  sep,
  isAbsolute,
  extname,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { Store } from "./store";
import { assert, Mutex, type Obj } from "./util";
export const skillKind = (employeeId?: string) => employeeId ? "skill:" + employeeId : "skill";
export function skillMetadata(text: string, path: string) {
  let name = dirname(path).replaceAll("\\", "/").split("/").at(-1) || "skill",
    description = "";
  const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front)
    for (const line of front[1].split(/\r?\n/)) {
      const pair = /^\s*(name|description):\s*(.*)$/.exec(line);
      if (pair) {
        const value = pair[2].replace(/^['"]|['"]$/g, "");
        if (pair[1] === "name") name = value;
        else description = value;
      }
    }
  return { name, description, path };
}
const excluded = new Set([
  "node_modules",
  "__pycache__",
  "target",
  "dist",
  ".git",
  ".env",
  ".cache",
  "__MACOSX",
]);
export function skillEntry(path: string) {
  const value = path.replaceAll("\\", "/");
  assert(
    value && !/^[\/]|^[a-z]:/i.test(value) && !/[\x00-\x1f:]/.test(value),
    "Unsafe skill archive path",
  );
  const parts = value.replace(/\/$/, "").split("/");
  assert(
    parts.every(
      (p) =>
        p &&
        p !== "." &&
        p !== ".." &&
        !/[. ]$/.test(p) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    ),
    "Unsafe skill archive path",
  );
  return parts.join("/");
}
function ignored(path: string) {
  return path
    .split("/")
    .some((part) => excluded.has(part) || part.startsWith("."));
}
type File = { path: string; data: Buffer; mode: number };
export function unpackSkill(data: Uint8Array): File[] {
  assert(data.length <= 32 << 20, "Skill ZIP exceeds32MiB");
  let total = 0,
    count = 0;
  const seen = new Set<string>();
  const files = unzipSync(data, {
    filter: (file) => {
      const path = skillEntry(file.name);
      assert(++count <= 2048, "Skill ZIP has too many entries");
      if (file.name.endsWith("/") || ignored(path)) return false;
      assert(
        !seen.has(path.toLowerCase()),
        "Duplicate or case-colliding skill path",
      );
      seen.add(path.toLowerCase());
      assert(file.originalSize <= 16 << 20, "Skill file exceeds16MiB");
      total += file.originalSize;
      assert(
        total <= 64 << 20 && seen.size <= 512,
        "Skill exceeds64MiB or512 files",
      );
      return true;
    },
  });
  return Object.entries(files).map(([path, data]) => ({
    path: skillEntry(path),
    data: Buffer.from(data),
    mode: /\.(sh|py|js|cjs|mjs)$/.test(path) ? 0o700 : 0o600,
  }));
}
async function directoryFiles(root: string): Promise<File[]> {
  const out: File[] = [];
  let total = 0;
  async function walk(dir: string, depth: number) {
    assert(depth <= 8, "Skill nesting exceeds8");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name),
        path = relative(root, file).split(sep).join("/");
      if (ignored(path)) continue;
      const st = await lstat(file);
      assert(!st.isSymbolicLink(), "Skill bundles must not contain symlinks");
      if (st.isDirectory()) await walk(file, depth + 1);
      else if (st.isFile()) {
        assert(st.size <= 16 << 20, "Skill file exceeds16MiB");
        total += st.size;
        assert(
          total <= 64 << 20 && out.length < 512,
          "Skill exceeds64MiB or512 files",
        );
        out.push({
          path: skillEntry(path),
          data: await readFile(file),
          mode: st.mode & 0o777,
        });
      } else throw Error("Only regular files may be imported");
    }
  }
  await walk(root, 0);
  return out;
}
async function findRoot(
  root: string,
  depth = 0,
  budget = { n: 0 },
): Promise<string | undefined> {
  assert(
    ++budget.n <= 512,
    "Skill discovery exceeds512 directories; choose a narrower root",
  );
  try {
    if ((await stat(join(root, "SKILL.md"))).isFile()) return root;
  } catch {}
  if (depth >= 4) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignored(entry.name)) {
      const found = await findRoot(join(root, entry.name), depth + 1, budget);
      if (found) return found;
    }
  }
}
export async function importSkill(
  store: Store,
  input: string,
  key?: string,
  replace = false,
  employeeId?: string,
) {
  const source = await realpath(input),
    info = await stat(source);
  let files: File[];
  if (info.isDirectory()) {
    const root = await findRoot(source);
    assert(root, "No SKILL.md found within4 directories");
    files = await directoryFiles(root);
  } else if (extname(source).toLowerCase() === ".zip") {
    files = unpackSkill(await readFile(source));
    const candidates = files
      .filter((f) => f.path.endsWith("/SKILL.md") || f.path === "SKILL.md")
      .sort(
        (a, b) =>
          a.path.split("/").length - b.path.split("/").length ||
          a.path.localeCompare(b.path),
      );
    assert(candidates.length, "ZIP has no SKILL.md");
    const prefix = candidates[0].path.slice(0, -"SKILL.md".length);
    files = files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
  } else {
    assert(
      source.toLowerCase().endsWith("skill.md"),
      "Import a skill directory,SKILL.md orZIP",
    );
    files = await directoryFiles(dirname(source));
  }
  const main = files.find((f) => f.path === "SKILL.md");
  assert(
    main && main.data.length <= 128 << 10,
    "SKILL.md missing or exceeds128KiB",
  );
  const inputText = new TextDecoder("utf-8", { fatal: true }).decode(main.data),
    metadata = skillMetadata(
      inputText,
      info.isDirectory()
        ? join(source, "SKILL.md")
        : files.find((f) => f.path === "SKILL.md")!.path.includes("/")
          ? files.find((f) => f.path === "SKILL.md")!.path
          : join(
              dirname(source),
              info.isFile() && extname(source) === ".zip"
                ? source
                    .split(/[\\/]/)
                    .at(-1)!
                    .replace(/\.zip$/i, "")
                : "",
              "SKILL.md",
            ),
    ),
    content = inputText,
    name = key || metadata.name;
  assert(
    /^[\p{L}\p{N}_.-]{1,100}$/u.test(name) && name !== "." && name !== "..",
    "Invalid skill name",
  );
  const kind = skillKind(employeeId), old = await store.object<any>(kind, name);
  if (employeeId) assert(employeeId === "default" ? !await store.get("employee:default-deleted", false) : !!await store.object("employee", employeeId), "Employee not found");
  assert(
    !old || replace,
    "Skill already exists; confirm replace=true to update it and its resources",
  );
  const assets: Obj[] = [],
    digest = createHash("sha256");
  await store.transaction(async () => {
        for (const file of files) {
          digest.update(file.path).update(file.data);
          assets.push({
            path: file.path,
            blob: await store.blob("application/octet-stream", file.data),
            mode: file.mode,
          });
        }
        await store.save(kind, name, {
                ...metadata,
                employeeId,
                id: name,
                name,
                content,
                sourcePath: source,
                assets,
                digest: digest.digest("hex"),
              });
      });
  return {
    id: name,
    name,
    description: metadata.description,
    path: "sqlite:skill/" + name,
    files: assets.map((a) => a.path),
    next: "Skill scripts are not executed on import; read SKILL.md before using them. All resources are stored in SQLite.",
  };
}
const locks = new Map<string, Mutex>();
export async function materializeSkill(store: Store, skill: Obj, cloud?: CloudRuntime) {
  const { mkdir, lstat, readFile, realpath, writeFile, rename, chmod, rm } = cloud?.fs || filesystem;
  if (!skill.assets?.length)
    return { path: "sqlite:skill/" + skill.id, resourceRoot: undefined };
  const safe = createHash("sha256")
      .update((skill.employeeId || "") + ":" + skill.id + ":" + skill.digest)
      .digest("hex"),
    root = resolve(
      cloud ? join((await cloud.identity()).home, "skills") : process.env.VEGA_SKILL_CACHE || join(tmpdir(), "vega-skill-cache"),
      safe,
    );
  let lock = locks.get(root);
  if (!lock) {
    lock = new Mutex();
    locks.set(root, lock);
  }
  return lock.run(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    assert(
      !(await lstat(root)).isSymbolicLink(),
      "Refuse symlinked skill cache root",
    );
    for (const asset of skill.assets) {
      const path = skillEntry(asset.path),
        target = resolve(root, path);
      assert(
        relative(root, target) !== ".." &&
          !relative(root, target).startsWith(".." + sep),
        "Skill cache escape",
      );
      const blob = await store.blobData(asset.blob);
      assert(blob, "Skill resource blob missing");
      let current: Buffer | undefined;
      try {
        const st = await lstat(target);
        assert(
          !st.isSymbolicLink(),
          "Refuse symlink in materialized skill cache",
        );
        if (st.isFile() && st.size === blob.data.length)
          current = await readFile(target);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (current && current.equals(Buffer.from(blob.data))) continue;
      const parent = dirname(target);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const realParent = await realpath(parent),
        realRoot = await realpath(root);
      assert(
        realParent === realRoot || realParent.startsWith(realRoot + sep),
        "Skill cache parent symlink escape",
      );
      const tmp = target + ".vega-tmp";
      try {
        await writeFile(tmp, blob.data, {
          flag: "wx",
          mode: asset.mode || 0o600,
        });
        await rename(tmp, target);
        if (process.platform !== "win32")
          await chmod(target, asset.mode || 0o600);
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
    return {
      path: join(root, "SKILL.md"),
      resourceRoot: root,
      archivePath: "sqlite:skill/" + skill.id,
    };
  });
}
export function legacySkillDirectories() {
  const home = process.env.NOVA_ROOT || join(homedir(), ".nova");
  return [join(home, "skills"), join(home, "alkaid/skills")];
}
