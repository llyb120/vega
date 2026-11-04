import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/core/store";
import { Subscriptions, locateWorkBuddy } from "../server/core/subscriptions";
import {
  loadSkills,
  skillMetadata,
  expandSkillCommand,
  sessionPrompt,
} from "../server/core/prompt";
import { nativeArguments } from "../server/core/util";
import { Providers } from "../server/core/provider";
import { resolveModel } from "../server/core/config";
import { createServer } from "node:http";
test("skills index/frontmatter and explicit /skill invocation remain readable with SQLite storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-skill-")),
    s = await Store.open(":memory:");
  try {
    await mkdir(join(dir, "skills/example"), { recursive: true });
    const content =
      '---\nname: example\ndescription: "Example task trigger"\n---\nDo this.';
    await writeFile(join(dir, "skills/example/SKILL.md"), content);
    await writeFile(join(dir, "AGENTS.md"), "project convention");
    const cfg: any = { model: "p/m", provider: {}, skillsDirectory: "skills" },
      skills = await loadSkills(cfg, s, dir);
    assert.equal(skills[0].name, "example");
    assert.equal(skills[0].description, "Example task trigger");
    assert.match(
      expandSkillCommand("/skill:example do it", skills),
      /先用 read/,
    );
    const session = await s.newSession({ cwd: dir }),
      prompt = await sessionPrompt(session, cfg, s);
    assert.match(prompt, /project convention/);
    assert.match(prompt, /SKILL.md/);
    await s.save("skill", "db", {
            id: "db",
            name: "saved",
            description: "DB skill",
            content: "do it",
          });
    const all = await loadSkills(cfg, s, dir);
    assert.equal(all.length, 2);
    assert(all.some((v) => v.path === "sqlite:skill/db"));
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("WorkBuddy built-in CLI locator uses reference app.asar.unpacked layout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-wb-"));
  try {
    assert.equal(
      locateWorkBuddy(join(dir, "WorkBuddy.exe")),
      join(dir, "resources/app.asar.unpacked/cli/bin/codebuddy"),
    );
    assert.equal(
      locateWorkBuddy(dir),
      join(dir, "resources/app.asar.unpacked/cli/bin/codebuddy"),
    );
    assert.equal(locateWorkBuddy("/explicit/cli"), "/explicit/cli");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("subscription sessions encrypt before SQLite persistence; native wrapped args stay objects", async () => {
  const s = await Store.open(":memory:");
  try {
    const a = new Subscriptions(s, "");
    await a.saveLogin("codebuddy", {
            origin: "https://www.codebuddy.ai",
            auth: {
              accessToken: "subscription-secret",
              expiresAt: Date.now() + 3600000,
            },
          });
    assert(
      !JSON.stringify(await s.get("subscription:codebuddy", {})).includes(
        "subscription-secret",
      ),
    );
    assert.equal(
      (await a.saved("codebuddy")).auth.accessToken,
      "subscription-secret",
    );
    assert.deepEqual(nativeArguments(JSON.stringify('{"path":"file"}')), {
      path: "file",
    });
    assert.throws(() => nativeArguments("[1]"));
    assert.throws(() => nativeArguments("{"));
    a.close();
  } finally {
    await s.close();
  }
});
test("CodeBuddy repeated/changing delta IDs and wrapped JSON match original native fixture", async () => {
  const events = [
    {
      tool_calls: [
        {
          index: 0,
          id: "a",
          function: { name: "re", arguments: JSON.stringify('{"path":"a"}') },
        },
        {
          index: 1,
          id: "a",
          function: { name: "read", arguments: '{"path":"b"}' },
        },
      ],
    },
    {
      tool_calls: [
        { index: 0, id: "later-id", function: { name: "ad", arguments: "" } },
      ],
    },
  ];
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      events
        .map(
          (delta) =>
            "data: " +
            JSON.stringify({ choices: [{ index: 0, delta }] }) +
            "\r\n\r\n",
        )
        .join("") +
        "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }) +
        "\r\n\r\ndata: [DONE]\r\n\r\n",
    );
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  try {
    const model = resolveModel({
        model: "p/m",
        provider: {
          p: {
            api: "codebuddy",
            baseURL: `http://127.0.0.1:${(server.address() as any).port}`,
            models: { m: {} },
          },
        },
      }),
      result = await new Providers().chat(
        model,
        "sys",
        [],
        [{ name: "read", description: "read", parameters: { type: "object" } }],
        new AbortController().signal,
      );
    assert.equal(result.calls?.length, 2);
    assert.notEqual(result.calls![0].id, result.calls![1].id);
    assert.deepEqual(result.calls![0].arguments, { path: "a" });
    assert.equal(result.calls![1].arguments.path, "b");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  }
});
