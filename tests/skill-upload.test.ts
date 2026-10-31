import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { Store } from "../server/core/store";
import { uploadSkill } from "../server/core/skill-upload";
test("skill upload snapshots ZIP resources without exposing server directory configuration", async () => {
  const store = new Store(":memory:");
  try {
    const zip = zipSync({
      "remote-skill/SKILL.md": strToU8(
        "---\nname: upload-fixture\ndescription: upload test\n---\nRead references/file.txt",
      ),
      "remote-skill/references/file.txt": strToU8("preserved"),
    });
    const args = {
      filename: "skill.zip",
      content: Buffer.from(zip).toString("base64"),
    };
    const installed = await uploadSkill(store, args);
    assert.equal(installed.id, "upload-fixture");
    assert(installed.files.includes("references/file.txt"));
    await assert.rejects(() =>
      uploadSkill(store, { ...args, filename: "skill.exe" }),
    );
    await assert.rejects(() =>
      uploadSkill(store, { ...args, content: "not-base64" }),
    );
    await assert.rejects(() => uploadSkill(store, args));
    assert.equal(
      (await uploadSkill(store, { ...args, replace: true })).id,
      "upload-fixture",
    );
  } finally {
    store.close();
  }
});
