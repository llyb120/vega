import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "./store";
import { assert, type Obj } from "./util";
import { importSkill } from "./skills";
export async function uploadSkill(store: Store, args: Obj) {
  assert(
    typeof args.filename === "string" &&
      args.filename.toLowerCase().endsWith(".zip"),
    "请选择技能ZIP文件",
  );
  assert(
    typeof args.content === "string" &&
      args.content.length <= 44 * 1024 * 1024 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(args.content),
    "技能包数据无效",
  );
  const data = Buffer.from(args.content, "base64");
  assert(data.length <= 32 * 1024 * 1024, "技能包不能超过32MiB");
  const dir = await mkdtemp(join(tmpdir(), "vega-skill-upload-"));
  try {
    const file = join(dir, "skill.zip");
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
    return await importSkill(store, file, undefined, args.replace === true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
