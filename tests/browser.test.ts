import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { Store } from "../server/core/store";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Chrome } from "../server/core/chrome";
import { sleep, type Obj } from "../server/core/util";
class FixtureBridge extends ChromeBridge {
  ws!: WebSocket;
  seq = 0;
  calls = new Map<
    number,
    {
      yes: (v: any) => void;
      no: (e: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  sessions = new Map<string, string>();
  async connect(url: string) {
    this.ws = new WebSocket(url);
    await new Promise<void>((yes, no) => {
      this.ws.once("open", yes);
      this.ws.once("error", no);
    });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id) {
        const p = this.calls.get(m.id);
        if (p) {
          this.calls.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) p.no(Error(m.error.message));
          else p.yes(m.result);
        }
      }
    });
  }
  async send(
    method: string,
    params: Obj = {},
    sessionId?: string,
  ): Promise<any> {
    return await new Promise((yes, no) => {
      const key = ++this.seq,
        timer = setTimeout(() => {
          this.calls.delete(key);
          no(Error("fixture CDP timeout " + method));
        }, 10000);
      this.calls.set(key, { yes, no, timer });
      this.ws.send(JSON.stringify({ id: key, method, params, sessionId }));
    });
  }
  async attached(tag: string) {
    if (!this.sessions.has(tag)) {
      const r = await this.send("Target.attachToTarget", {
        targetId: tag,
        flatten: true,
      });
      this.sessions.set(tag, r.sessionId);
      await this.send("Page.enable", {}, r.sessionId);
      await this.send("Runtime.enable", {}, r.sessionId);
    }
    return this.sessions.get(tag)!;
  }
  override async request(
    operation: string,
    a: Obj,
    signal?: AbortSignal,
  ): Promise<any> {
    signal?.throwIfAborted();
    if (operation === "tabs") {
      const r = await this.send("Target.getTargets");
      return {
        tabs: r.targetInfos
          .filter((t: Obj) => t.type === "page")
          .map((t: Obj) => ({
            tag: t.targetId,
            title: t.title,
            url: t.url,
            active: true,
            controllable: true,
            loading: false,
          })),
      };
    }
    if (operation === "open" || operation === "new_tab") {
      const result = await this.send("Target.createTarget", {
        url: a.url || "about:blank",
      });
      await this.attached(result.targetId);
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const ready = await this.send(
          "Runtime.evaluate",
          { expression: "document.readyState", returnByValue: true },
          this.sessions.get(result.targetId),
        );
        if (ready.result.value === "complete") break;
        await sleep(30);
      }
      return {
        tabTag: result.targetId,
        tabs: (await this.request("tabs", {})).tabs,
      };
    }
    if (operation === "cdp") {
      const session = a.sessionId || (await this.attached(a.tabTag));
      return this.send(a.method, a.params, session);
    }
    if (operation === "close_tab") {
      await this.send("Target.closeTarget", { targetId: a.tabTag });
      return { closed: true };
    }
    if (operation === "goto") {
      await this.send(
        "Page.navigate",
        { url: a.url },
        await this.attached(a.tabTag),
      );
      await sleep(100);
      return { tabTag: a.tabTag };
    }
    throw Error("Unsupported fixture route " + operation);
  }
  override close() {
    this.ws?.close();
    for (const p of this.calls.values()) {
      clearTimeout(p.timer);
      p.no(Error("Fixture closed"));
    }
    this.calls.clear();
  }
}
test(
  "real isolated Chrome: DOM/ref, fill, iframe/shadow, screenshots/crop, upload, run and exactly-once submission",
  { timeout: 60000, skip: process.env.VEGA_TEST_CHROME !== "1" },
  async () => {
    const binary =
      process.env.VEGA_CHROME_PATH ||
      [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].find(existsSync);
    assert(binary, "Set VEGA_CHROME_PATH");
    const dir = await mkdtemp(join(tmpdir(), "vega-chrome-")),
      profile = join(dir, "profile");
    const child = spawn(
      binary,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profile,
        "--no-sandbox",
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const store = new Store(":memory:"),
      bridge = new FixtureBridge();
    let submitted = 0;
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/submit") {
        submitted++;
        res.end("done");
        return;
      }
      if (req.url === "/frame") {
        res.end("<button>Frame action</button>");
        return;
      }
      res.end(
        `<!doctype html><html><head><title>Vega complete browser fixture</title></head><body><label>Name<input aria-label="Name"></label><input id="upload" type="file" hidden><button onclick="fetch('/submit').then(()=>document.querySelector('#state').textContent='Saved')">Save</button><div id="state">Ready</div><iframe src="/frame"></iframe><div id="shadow"></div><script>const r=document.querySelector('#shadow').attachShadow({mode:'open'});r.innerHTML='<button>Shadow action</button>'</script><div style="height:1800px">long content</div></body></html>`,
      );
    });
    await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      let endpoint = "";
      for (let i = 0; i < 100; i++) {
        try {
          const [port, path] = (
            await readFile(join(profile, "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split("\n");
          endpoint = `ws://127.0.0.1:${port}${path}`;
          break;
        } catch {
          await sleep(50);
        }
      }
      assert(endpoint, "Chrome did not publish DevToolsActivePort");
      await bridge.connect(endpoint);
      const engine = new Chrome(
        store,
        bridge,
        readFileSync("server/assets/browser/browser-page.js", "utf8"),
      );
      const open = await engine.execute("owner", dir, {
        operation: "open",
        url,
        visual: "none",
      });
      const tag = open.tabTag;
      assert(open.pages[0].text.includes("Ready"));
      assert(
        open.pages.some((p: Obj) =>
          p.items.some((i: Obj) => i.name === "Shadow action"),
        ),
        "Shadow controls missing",
      );
      assert(
        open.pages.some((p: Obj) =>
          p.items.some((i: Obj) => i.name === "Frame action"),
        ),
        "Iframe controls missing",
      );
      const name = open.pages[0].items.find((i: Obj) => i.name === "Name");
      assert(name);
      const fill = await engine.execute("owner", dir, {
        operation: "act",
        tabTag: tag,
        snapshotId: open.snapshotId,
        action: { action: "fill", frame: 0, ref: name.ref, text: "Vega" },
        visual: "none",
      });
      assert.equal(fill.status, "executed", fill.reason);
      const value = await engine.execute("owner", dir, {
        operation: "evaluate",
        tabTag: tag,
        expression: "document.querySelector('input').value",
        feedback: "none",
      });
      assert.equal(value.value, "Vega");
      const shot = await engine.execute("owner", dir, {
        operation: "screenshot",
        tabTag: tag,
        maxEdge: 800,
      });
      assert.equal(shot.images.length, 1);
      assert(shot.images[0].pixelWidth <= 800);
      const cropped = await engine.execute("owner", dir, {
        operation: "screenshot",
        tabTag: tag,
        region: { x: 0, y: 0, width: 200, height: 200 },
      });
      assert(cropped.images[0].pixelWidth <= 200);
      await writeFile(join(dir, "upload.txt"), "authorized upload");
      const upload = await engine.execute("owner", dir, {
        operation: "act",
        tabTag: tag,
        action: {
          action: "upload",
          frame: 0,
          selector: "#upload",
          files: ["upload.txt"],
        },
        visual: "none",
      });
      assert.equal(upload.status, "executed", upload.reason);
      const info = await engine.execute("owner", dir, {
        operation: "evaluate",
        tabTag: tag,
        expression: "document.querySelector('#upload').files[0].name",
        feedback: "none",
      });
      assert.equal(info.value, "upload.txt");
      const result = await engine.execute("owner", dir, {
        operation: "run",
        tabTag: tag,
        visual: "none",
        plan: {
          task: "save local fixture once",
          steps: [{ action: "click", name: "Save", expect: "Saved" }],
          expectedText: "Saved",
        },
      });
      assert.equal(
        result.altairRun.status,
        "completed",
        JSON.stringify(result.altairRun),
      );
      assert.equal(submitted, 1);
      const invalid = await engine.execute("owner", dir, {
        operation: "act",
        tabTag: tag,
        action: { action: "click", ref: "fabricated" },
        visual: "none",
      });
      assert.equal(invalid.completedActions, 0);
      assert.equal(submitted, 1);
      const archive = store.object<any>("browser-observation", shot.snapshotId);
      assert(
        archive.images.length === 1,
        "Observation not persisted in SQLite",
      );
    } finally {
      bridge.close();
      store.close();
      await new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      });
      child.kill();
      await new Promise<void>((yes) => {
        if (child.exitCode !== null) yes();
        else child.once("exit", () => yes());
      });
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
