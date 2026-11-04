import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { Store } from "../server/core/store";
import {
  importSkill,
  materializeSkill,
  unpackSkill,
  skillEntry,
} from "../server/core/skills";
import { loadSkills, expandSkillCommand } from "../server/core/prompt";
import { shell } from "../server/core/tools";
test("directory skill import retains scripts/references in SQLite and works after original deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-bundle-")),
    root = join(dir, "example"),
    store = await Store.open(":memory:"),
    old = process.env.VEGA_SKILL_CACHE;
  process.env.VEGA_SKILL_CACHE = join(dir, "cache");
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "references"));
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: bundled\ndescription: example bundle\n---\nRun scripts/check.mjs and read references/info.md",
    );
    await writeFile(
      join(root, "scripts/check.mjs"),
      "console.log('bundle script works')",
    );
    await writeFile(join(root, "references/info.md"), "retained reference");
    await writeFile(join(root, ".env"), "DO_NOT_IMPORT=secret");
    const installed = await importSkill(store, root);
    assert(installed.files.includes("scripts/check.mjs"));
    assert(!installed.files.includes(".env"));
    await assert.rejects(() => importSkill(store, root));
    await rm(root, { recursive: true, force: true });
    const skills = await loadSkills(
        { model: "", provider: {}, skillsDirectory: join(dir, "empty") },
        store,
        dir,
      ),
      entry = skills.find((s) => s.name === "bundled")!;
    assert(entry.resourceRoot);
    assert.equal(
      await readFile(join(entry.resourceRoot, "references/info.md"), "utf8"),
      "retained reference",
    );
    const script = join(entry.resourceRoot, "scripts/check.mjs");
    const command =
      (process.platform === "win32" ? "& " : "") +
      "'" +
      process.execPath +
      "' '" +
      script +
      "'";
    const result = await shell(
      dir,
      { command, timeout: 10 },
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.error, false);
    assert.match(result.value.output, /bundle script works/);
    assert(
      expandSkillCommand("[m00001] /skill:bundled do it", skills).includes(
        entry.resourceRoot,
      ),
    );
    await writeFile(script, "tampered");
    await materializeSkill(store, (await store.object("skill", "bundled"))!);
    assert.match(await readFile(script, "utf8"), /bundle script works/);
  } finally {
    if (old === undefined) delete process.env.VEGA_SKILL_CACHE;
    else process.env.VEGA_SKILL_CACHE = old;
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("ZIP import snapshots packaged resources without traversal or unsafe archive paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-zip-")),
    store = await Store.open(":memory:");
  try {
    const data = zipSync({
      "wrapper/pack/SKILL.md": strToU8(
        "---\nname: zipped\n---\nUse references/data.txt",
      ),
      "wrapper/pack/references/data.txt": strToU8("zip reference"),
    });
    const path = join(dir, "skill.zip");
    await writeFile(path, data);
    const imported = await importSkill(store, path);
    assert(imported.files.includes("references/data.txt"));
    assert((await store.object<any>("skill", "zipped"))?.assets.length === 2);
    for (const entry of [
      "../outside",
      "/absolute",
      "C:/outside",
      "dir/../outside",
      "dir/con.txt",
      "file:ads",
    ])
      assert.throws(() => skillEntry(entry));
    assert.throws(() =>
      unpackSkill(zipSync({ "../SKILL.md": strToU8("bad") })),
    );
    assert.throws(() =>
      unpackSkill(
        zipSync({
          "a/SKILL.md": strToU8("good"),
          "a/REF.txt": strToU8("x"),
          "a/ref.txt": strToU8("y"),
        }),
      ),
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
