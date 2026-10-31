import {
  readFile,
  open,
  stat,
  mkdir,
  writeFile,
  rename,
  unlink,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { FormData } from "undici";
import { windowsShell } from "./presence";
import sharp from "sharp";
import chromeDefinition from "../../shared/chrome-tool.json";
import employeeDefinition from "../../shared/employee-tool.json";
import imageDefinitions from "../../shared/image-tools.json";
import { readPath, textSlice } from "./file-read";
import { materializeSkill, skillEntry } from "./skills";
import { isDeepStrictEqual } from "node:util";
import { maskedConfig, mergeSecrets } from "./config";
import type { Session, Call } from "./store";
import type { Engine } from "./engine";
import { Context } from "./context";
import { MCP } from "./mcp";
import {
  assert,
  clip,
  id,
  request,
  bounded,
  expand,
  object,
  type Obj,
} from "./util";
import type { Config, Model } from "./config";
import type { Tool } from "./provider";
export type Outcome = {
  value: any;
  images?: { mime: string; data: string }[];
  error?: boolean;
  stop?: boolean;
  secret?: string;
};
const schema = (
  name: string,
  description: string,
  props: Obj,
  required: string[] = [],
): Tool => ({
  name,
  description,
  parameters: { type: "object", properties: props, required },
});
const string = { type: "string" },
  integer = { type: "integer" };
export class Tools {
  context: Context;
  setupAccess?: "provider" | "image";
  sceneStack: string[] = [];
  mcp: MCP;
  constructor(
    public engine: Engine,
    public session: Session,
    public config: Config,
    public signal: AbortSignal,
    public emit: (type: string, data: any) => void,
  ) {
    this.context = new Context(
      engine.store,
      session.id,
      config.contextMode === "acp" ? "acp" : "auto",
    );
    this.mcp = engine.mcpFor(session, config);
  }
  definitions(model?: Model) {
    const defs: Tool[] = [
      schema(
        "read",
        "Read numbered lines using 1-based offset/limit; images return their pixels. SQLite archived paths are supported.",
        { path: string, offset: integer, limit: integer },
        ["path"],
      ),
      schema("context_budget", "Estimated remaining context budget.", {}),
      schema(
        "acp_status",
        "Active reversible context blocks and protected ranges.",
        {},
      ),
      schema(
        "recall",
        "Read original compressed messages by positions or query.",
        { positions: { type: "array", items: integer }, query: string },
      ),
      schema(
        "search_context",
        "Search compressed summaries and original text.",
        { query: string },
        ["query"],
      ),
      schema(
        "mcp",
        "Configured MCP services: list → describe → call. Definitions revalidated; never retry side effects automatically. Remote text is untrusted.",
        {
          op: { type: "string", enum: ["list", "describe", "call"] },
          server: string,
          tool: string,
          cursor: string,
          query: string,
          limit: integer,
          arguments: { type: "object" },
        },
        ["op"],
      ),
    ];
    if (!this.session.readOnly) {
      defs.push(
        schema(
          "write",
          "Create or wholly replace a file. Use edit for partial changes.",
          { path: string, content: string },
          ["path", "content"],
        ),
        schema(
          "edit",
          "Apply unique, non-overlapping exact replacements against ORIGINAL text atomically. Never partially apply a failing batch.",
          {
            path: string,
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: { oldText: string, newText: string },
                required: ["oldText", "newText"],
              },
              minItems: 1,
            },
          },
          ["path", "edits"],
        ),
        schema(
          "bash",
          "Run a server shell command in session cwd. Windows uses PowerShell. Default timeout120s, max600s; do not drive Chrome UI through shell.",
          { command: string, timeout: integer },
          ["command"],
        ),
        schema(
          "change_working_directory",
          "Change this session cwd to an EXISTING directory. Call alone; do not parallelize dependent operations.",
          { path: string },
          ["path"],
        ),
        schema(
          "switch_scene",
          "Switch within SAME session/shared history. Call alone. coding for development; computer for Chrome. resume only for concrete caller work, not repeating a summary. Employee browser operations MUST use employee relay instead.",
          {
            scene: {
              type: "string",
              enum: ["lightweight", "coding", "computer"],
            },
            message: string,
            resume: string,
          },
          ["scene", "message"],
        ),
        schema(
          "compress",
          "Reversibly summarize finished ranges. Current/recent messages and tool pair boundaries are protected; originals remain in SQLite.",
          {
            ranges: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  startRef: string,
                  endRef: string,
                  summary: string,
                  topic: string,
                },
                required: ["startRef", "endRef", "summary"],
              },
            },
          },
          ["ranges"],
        ),
        schema(
          "decompress",
          "Restore an active compressed block and reactivate its child blocks.",
          { block: string },
          ["block"],
        ),
        {
          name: employeeDefinition.name,
          description: employeeDefinition.description,
          parameters: employeeDefinition.inputSchema,
        },
        ...imageDefinitions.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      );
      if (
        (!this.session.taskId || this.session.scene === "computer") &&
        (this.session.scene === "computer" ||
          model?.selection === this.config.scenes?.computer?.[0] ||
          !this.config.scenes?.computer?.length)
      )
        defs.push({
          name: chromeDefinition.name,
          description: chromeDefinition.description.replace(
            "Chrome原生对话框和其它桌面应用用jianlai；两工具不能并行，切换后先观察。",
            "仅控制授权Chrome网页；不提供桌面应用或原生对话框操作，原生对话框请用户处理。",
          ),
          parameters: chromeDefinition.inputSchema,
        });
    }
    const scenes = ["coding", "computer"].filter(
      (scene) =>
        scene !== this.session.scene &&
        !this.sceneStack.includes(scene) &&
        this.config.scenes?.[scene]?.some((id) => id !== this.session.model) &&
        (!this.session.taskId || scene !== "computer"),
    );
    const switching = defs.find((t) => t.name === "switch_scene");
    if (switching) {
      if (!scenes.length) defs.splice(defs.indexOf(switching), 1);
      else switching.parameters.properties.scene.enum = scenes;
    }

    if (this.session.readOnly && scenes.includes("coding"))
      defs.push(
        schema(
          "switch_scene",
          "Use coding for read-only code analysis within this same session; permissions remain read-only.",
          {
            scene: { type: "string", enum: ["coding"] },
            message: string,
            resume: string,
          },
          ["scene", "message"],
        ),
      );
    if (this.session.readOnly) {
      for (const name of ["compress", "decompress"])
        if (!defs.some((t) => t.name === name))
          defs.push(
            schema(
              name,
              name === "compress"
                ? "Compress finished context ranges without modifying canonical history."
                : "Restore a compressed context block.",
              name === "compress"
                ? {
                    ranges: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          startRef: string,
                          endRef: string,
                          summary: string,
                          topic: string,
                        },
                        required: ["startRef", "endRef", "summary"],
                      },
                    },
                  }
                : { block: string },
              [name === "compress" ? "ranges" : "block"],
            ),
          );
    }
    for (const def of defs) {
      def.parameters = structuredClone(def.parameters);
      def.parameters.properties ??= {};
      def.parameters.properties._after = {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 64,
        description:
          "Earlier successful calls in this batch (1-based). UI/agent/MCP results require review and cannot be prerequisites.",
      };
    }
    return defs;
  }
  async execute(call: Call, model: Model): Promise<Outcome> {
    this.signal.throwIfAborted();
    const a = { ...call.arguments };
    delete a._after;
    assert(
      this.definitions(model).some((t) => t.name === call.name),
      "Tool unavailable in this scene",
    );
    if (call.name === "read") return this.read(a);
    if (a.path === "sqlite:config" && call.name === "write") {
      assert(
        this.setupAccess && !this.session.readOnly,
        "Configuration writes require an explicit current /setup or /setup-image user command",
      );
      const next = JSON.parse(a.content),
        previous = this.engine.config();
      mergeSecrets(next, previous);
      const allowed =
        this.setupAccess === "image"
          ? ["image"]
          : ["provider", "model", "scenes"];
      for (const key of new Set([
        ...Object.keys(next),
        ...Object.keys(previous),
      ]))
        if (!allowed.includes(key))
          assert(
            isDeepStrictEqual(next[key], (previous as any)[key]),
            "Setup cannot modify " + key,
          );
      return { value: await this.engine.saveConfig(next) };
    }
    if (["write", "edit"].includes(call.name))
      return { value: await mutate(this.session.cwd, call.name, a) };
    if (call.name === "bash")
      return shell(this.session.cwd, a, this.signal, this.emit);
    if (call.name === "change_working_directory") {
      const path = resolve(this.session.cwd, a.path || "");
      assert(
        a.path && (await stat(path)).isDirectory(),
        "Existing cwd directory required",
      );
      this.session.cwd = path;
      this.engine.store.saveSession(this.session);
      return { value: { cwd: path } };
    }
    if (call.name === "compress") {
      const summaries = (a.ranges || [a]).map((r: Obj) => ({
          summary: r.summary,
          topic: r.topic,
        })),
        redactor = this.engine.redactors.get(this.session.id);
      assert(
        !redactor || isDeepStrictEqual(redactor.value(summaries), summaries),
        "Credentials cannot be written to persistent context summaries",
      );
    }
    if (
      [
        "compress",
        "decompress",
        "recall",
        "search_context",
        "context_budget",
        "acp_status",
      ].includes(call.name)
    )
      return {
        value: this.context.tool(call.name, a),
      };
    if (call.name === "mcp") {
      this.mcp = this.engine.mcpFor(this.session, this.config);
      const result = await this.mcp.execute(
        a,
        !!this.session.readOnly,
        this.signal,
      );
      const images: Outcome["images"] = [];
      for (const part of result.content || [])
        if (part.type === "image") {
          images.push({ mime: part.mimeType, data: part.data });
          part.data = "[image attached]";
        }
      return { value: result, images, error: result.isError };
    }
    if (call.name === "employee") {
      const guarded = { text: a.text, note: a.note, plan: a.plan };
      assert(
        JSON.stringify(
          this.engine.redactors.get(this.session.id)?.value(guarded) ?? guarded,
        ) === JSON.stringify(guarded),
        "Credentials may not be copied to employee memory/notes/checkpoints",
      );
      const result = await this.engine.employee.execute(
        this.session.taskId || "",
        { ...a, ...(a.action === "add" ? { cwd: this.session.cwd } : {}) },
      );
      return { value: result.value, stop: result.stop, secret: result.secret };
    }
    if (call.name === "chrome") {
      const result = await this.engine.chrome.execute(
        this.session.id,
        this.session.cwd,
        a,
        this.signal,
      );
      const images: Outcome["images"] = [];
      for (const im of result.images || []) {
        this.engine.store.grantBlob(im.blobId, this.session.id);
        const data = this.engine.store.blobData(im.blobId);
        if (data)
          images.push({
            mime: data.mime,
            data: Buffer.from(data.data).toString("base64"),
          });
      }
      return {
        value: result,
        images,
        error: ["needs_review", "not_executed"].includes(result.status),
      };
    }
    if (["generate_image", "edit_image"].includes(call.name))
      return imageTool(
        this.session.cwd,
        call.name,
        a,
        this.config.image || {},
        this.signal,
      );
    throw Error("Runtime-only or unknown tool: " + call.name);
  }
  async read(a: Obj): Promise<Outcome> {
    if (a.path === "sqlite:config")
      return {
        value: {
          path: a.path,
          text: JSON.stringify(maskedConfig(this.engine.config()), null, 2),
          next: "__stored_secret__ preserves existing secrets; only explicit setup commands permit writes.",
        },
      };
    assert(typeof a.path === "string" && a.path, "path required");
    if (a.path.startsWith("sqlite:message/")) {
      const seq = Number(a.path.slice("sqlite:message/".length));
      assert(Number.isInteger(seq) && seq >= 1, "Invalid message position");
      const row = this.engine.store
        .messages(this.session.id)
        .find((m) => m.seq === seq);
      assert(row, "Message not found in this session");
      const text = JSON.stringify(row, null, 2).split("\n"),
        offset = a.offset ?? 1,
        limit = a.limit ?? 2000;
      assert(
        Number.isInteger(offset) &&
          offset >= 1 &&
          Number.isInteger(limit) &&
          limit >= 1 &&
          limit <= 20000,
        "Invalid offset/limit",
      );
      return {
        value: {
          path: a.path,
          text: clip(
            text
              .slice(offset - 1, offset - 1 + limit)
              .map((line, n) => `${offset + n}|${line}`)
              .join("\n"),
            2 << 20,
          ),
          hasMore: offset - 1 + limit < text.length,
        },
      };
    }
    if (a.path.startsWith("sqlite:skill/")) {
      const [skillID, ...rest] = a.path
        .slice("sqlite:skill/".length)
        .split("/");
      const skill = this.engine.store.object<any>("skill", skillID);
      assert(skill, "Skill not found");
      const path = rest.length ? skillEntry(rest.join("/")) : "SKILL.md";
      if (skill.assets?.length) {
        const cache = await materializeSkill(this.engine.store, skill);
        assert(
          skill.assets.some((asset: Obj) => asset.path === path),
          "Skill resource not found",
        );
        return this.read({ ...a, path: resolve(cache.resourceRoot!, path) });
      }
      assert(path === "SKILL.md", "Legacy skill has no archived resources");
      return { value: { path: a.path, text: skill.content } };
    }
    if (a.path.startsWith("sqlite:")) {
      const match =
        /^sqlite:(blob|browser-observation|tool-output)\/(.+)$/.exec(a.path);
      assert(match, "Invalid SQLite archive path");
      if (match[1] === "blob") {
        const blob = this.engine.store.blobData(match[2]);
        assert(blob, "Archived blob missing");
        return {
          value: { path: a.path },
          images: [
            {
              mime: blob.mime,
              data: Buffer.from(blob.data).toString("base64"),
            },
          ],
        };
      }
      const value = this.engine.store.object(match[1], match[2]);
      assert(value, "Archived observation missing");
      return { value };
    }
    const path = await readPath(this.session.cwd, a.path),
      st = await stat(path);
    assert(st.isFile(), "Regular file required");
    const extension = extname(path).toLowerCase();
    if (
      [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)
    ) {
      assert(st.size <= 25 << 20, "Image exceeds25MiB");
      const data = await readFile(path),
        metadata = await sharp(data, { limitInputPixels: 64000000 }).metadata();
      return {
        value: { path },
        images: [
          {
            mime:
              "image/" +
              (metadata.format === "jpeg" ? "jpeg" : metadata.format),
            data: data.toString("base64"),
          },
        ],
      };
    }
    assert(
      st.size <= 32 << 20,
      "Text file exceeds32MiB; use bounded shell extraction",
    );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(path),
    );
    assert(!content.includes("\0"), "Not a UTF-8 text file");
    return { value: { path, ...textSlice(content, a.offset, a.limit) } };
  }
  async close() {
    if (this.signal.aborted) await this.engine.releaseSession(this.session.id);
  }
}
export async function mutate(cwd: string, name: string, a: Obj) {
  assert(typeof a.path === "string" && a.path, "path required");
  let path = resolve(cwd, a.path),
    mode = 0o644;
  try {
    path = await realpath(path);
    const st = await stat(path);
    assert(st.isFile(), "Regular file required");
    mode = st.mode;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  let value: string;
  const changes: Obj[] = [];
  if (name === "write") {
    assert(typeof a.content === "string", "content required");
    value = a.content;
    await mkdir(dirname(path), { recursive: true });
  } else {
    const bytes = await readFile(path);
    assert(bytes.length <= 32 << 20, "Edit file exceeds32MiB");
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
    assert(Array.isArray(a.edits) && a.edits.length > 0, "edits required");
    const ranges = a.edits
      .map((e: Obj) => {
        assert(
          typeof e.oldText === "string" &&
            e.oldText &&
            typeof e.newText === "string",
          "Exact nonempty oldText/newText required",
        );
        const start = value.indexOf(e.oldText);
        const lines = value.split(/\r?\n/),
          anchor =
            e.oldText
              .split(/\r?\n/)
              .find((line: string) => line.trim())
              ?.trim() || "",
          closest = lines.findIndex(
            (line) =>
              line.trim() === anchor ||
              (anchor.length >= 12 && line.includes(anchor.slice(0, 40))),
          );
        assert(
          start >= 0 && value.indexOf(e.oldText, start + 1) < 0,
          "oldText must match exactly one region; no file changed." +
            (closest >= 0
              ? " Closest content:\n" +
                lines
                  .slice(Math.max(0, closest - 1), closest + 8)
                  .map(
                    (line, index) =>
                      `${Math.max(0, closest - 1) + index + 1}|${line}`,
                  )
                  .join("\n")
              : ""),
        );
        changes.push({
          line: value.slice(0, start).split("\n").length,
          oldText: e.oldText,
          newText: e.newText,
        });
        return { start, end: start + e.oldText.length, text: e.newText };
      })
      .sort((a: Obj, b: Obj) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++)
      assert(
        ranges[i].start >= ranges[i - 1].end,
        "Overlapping edits; no file changed",
      );
    for (const r of ranges.reverse())
      value = value.slice(0, r.start) + r.text + value.slice(r.end);
  }
  const temp = resolve(dirname(path), ".vega-" + id());
  try {
    await writeFile(temp, value, { flag: "wx", mode });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return {
    path,
    bytes: Buffer.byteLength(value),
    ...(changes.length ? { changes } : {}),
  };
}
export async function shell(
  cwd: string,
  a: Obj,
  parent: AbortSignal,
  emit: (type: string, data: any) => void,
): Promise<Outcome> {
  assert(typeof a.command === "string" && a.command.trim(), "command required");
  const timeout = a.timeout ?? 120;
  assert(
    Number.isInteger(timeout) && timeout >= 1 && timeout <= 600,
    "timeout must be1–600",
  );
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout * 1000)]);
  signal.throwIfAborted();
  const win = process.platform === "win32",
    bin = win ? windowsShell() : "/bin/sh";
  return await new Promise((resolve) => {
    const child = spawn(
      bin,
      win
        ? ["-NoProfile", "-NonInteractive", "-Command", a.command]
        : ["-c", a.command],
      {
        cwd,
        windowsHide: true,
        detached: !win,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      truncated = false,
      last = 0,
      finished = false;
    const abort = () => {
      if (child.pid) {
        if (win)
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    const stdoutDecoder = new StringDecoder("utf8"),
      stderrDecoder = new StringDecoder("utf8");
    const collect = (text: string) => {
      if (!text) return;
      if (output.length + text.length > 2 << 20) truncated = true;
      output = (output + text).slice(0, 2 << 20);
      if (Date.now() - last > 200) {
        last = Date.now();
        emit("tool_progress", clip(text, 4096));
      }
    };
    child.stdout.on("data", (chunk) => collect(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk) => collect(stderrDecoder.write(chunk)));
    const done = (code: number, error?: string) => {
      if (finished) return;
      finished = true;
      collect(stdoutDecoder.end());
      collect(stderrDecoder.end());
      signal.removeEventListener("abort", abort);
      resolve({
        value: {
          output,
          truncated,
          exitCode: code,
          error: signal.aborted ? "Cancelled/timeout" : error,
        },
        error: code !== 0 || signal.aborted,
      });
    };
    child.on("error", (e) => done(-1, e.message));
    child.on("close", (code) => done(code ?? -1));
    if (signal.aborted) abort();
  });
}
export async function imageTool(
  cwd: string,
  name: string,
  a: Obj,
  config: Obj,
  signal: AbortSignal,
): Promise<Outcome> {
  assert(
    Object.keys(a).every((k) =>
      ["prompt", "model", "size", "outputDir", "referenceImages"].includes(k),
    ),
    "Unsupported image tool parameter",
  );
  assert(
    (config.baseURL || config.baseUrl) &&
      expand(config.apiKey || "").trim() &&
      config.models?.length,
    "Configure image service first",
  );
  assert(
    typeof a.prompt === "string" &&
      a.prompt.trim() &&
      Buffer.byteLength(a.prompt) <= 32000,
    "Invalid image prompt",
  );
  const model = a.model || config.models[0],
    size = a.size || "auto";
  assert(
    config.models.includes(model) &&
      ["auto", "1024x1024", "1024x1536", "1536x1024"].includes(size),
    "Image model/size not configured",
  );
  const refs = a.referenceImages || [];
  assert(
    Array.isArray(refs) &&
      refs.length <= 16 &&
      (name !== "edit_image" || refs.length),
    "Editing requires original image; max16references",
  );
  const dir = resolve(cwd, a.outputDir || ".");
  assert((await stat(dir)).isDirectory(), "outputDir must exist");
  let body: any,
    headers: Obj = { Authorization: "Bearer " + expand(config.apiKey || "") },
    endpoint = (config.baseURL || config.baseUrl).replace(/\/$/, "");
  if (refs.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries({
      model,
      prompt: a.prompt,
      size,
      n: "1",
      output_format: "png",
    }))
      form.set(k, String(v));
    let total = 0;
    for (const [i, file] of refs.entries()) {
      const path = resolve(cwd, file),
        st = await stat(path);
      assert(st.isFile() && st.size <= 25 << 20, "Invalid reference file");
      total += st.size;
      assert(total <= 64 << 20, "References exceed64MiB");
      const data = await readFile(path),
        meta = await sharp(data, { limitInputPixels: 64000000 }).metadata();
      assert(
        ["png", "jpeg", "webp"].includes(meta.format || ""),
        "Reference must be PNG/JPEG/WebP",
      );
      form.append(
        refs.length === 1 ? "image" : "image[]",
        new Blob([data], { type: "image/" + meta.format }),
        `reference-${i}.${meta.format}`,
      );
    }
    body = form;
    endpoint += "/images/edits";
  } else {
    body = JSON.stringify({
      model,
      prompt: a.prompt,
      size,
      n: 1,
      output_format: "png",
    });
    headers["Content-Type"] = "application/json";
    endpoint += "/images/generations";
  }
  const response = await request(
    endpoint,
    { method: "POST", headers, body, signal },
    600000,
  );
  assert(
    response.ok,
    `Image API HTTP ${response.status}; do not automatically retry`,
  );
  const result = JSON.parse((await bounded(response, 64 << 20)).toString());
  const image = result.data?.[0];
  assert(image, "Image API returned no image");
  let data: Buffer;
  if (image.b64_json) {
    assert(
      typeof image.b64_json === "string" &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json) &&
        image.b64_json.length % 4 === 0,
      "Invalid image base64; inspect original service result before retry",
    );
    data = Buffer.from(image.b64_json, "base64");
  } else {
    const url = new URL(image.url);
    assert(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password,
      "Invalid image download URL",
    );
    const r = await request(url.href, { signal });
    assert(r.ok, "Image download failed");
    data = await bounded(r, 64 << 20);
  }
  assert(data.length <= 64 << 20, "Image exceeds64MiB");
  const meta = await sharp(data, { limitInputPixels: 64000000 }).metadata();
  assert(
    meta.format === "png" && meta.width && meta.height,
    "Expected PNG image",
  );
  await sharp(data).raw().toBuffer();
  const path = resolve(dir, "vega-" + id() + ".png");
  const file = await open(path, "wx");
  try {
    await file.writeFile(data);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  } finally {
    await file.close().catch(() => {});
  }
  return {
    value: {
      path,
      model,
      markdown: `![图片](<${path.replaceAll("\\", "/")}>)`,
    },
    images: [{ mime: "image/png", data: data.toString("base64") }],
  };
}
