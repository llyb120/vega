import { EventEmitter } from "node:events";
import { BrowserLive } from "../server/core/browser-live";
import type { Auth, Principal } from "../server/core/auth";
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
import {
  browserTabs,
  browserScreenshot,
  browserControl,
} from "../server/core/browser-preview";
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
  override async start() {}
  override status() {
    return {
      ...super.status(),
      connected: this.ws?.readyState === WebSocket.OPEN,
      browser: "Chrome fixture",
    };
  }
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
      let loaded = false;
      while (Date.now() < end) {
        const ready = await this.send(
          "Runtime.evaluate",
          {
            expression: "({ready:document.readyState,url:location.href})",
            returnByValue: true,
          },
          this.sessions.get(result.targetId),
        );
        if (
          ready.result.value?.ready === "complete" &&
          ready.result.value?.url === new URL(a.url || "about:blank").href
        ) {
          loaded = true;
          break;
        }
        await sleep(30);
      }
      assert(
        loaded,
        "Fixture target did not load the requested URL; about:blank is not a ready page",
      );
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
  async (t) => {
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
    store.db.prepare("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)").run("fixture", "fixture", "test-only", "admin", 0, Date.now(), 0);
    let submitted = 0, liveSubmitted = 0,
      live: BrowserLive | undefined;
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
      if (req.url === "/live-form") {
        res.end(`<form action="/live-submitted" method="post" onkeydown="if(event.key==='Enter'){event.preventDefault();this.requestSubmit()}"><input aria-label="Query"><button>Submit</button></form>`);
        return;
      }
      if (req.url === "/live-submitted") {
        liveSubmitted++;
        setTimeout(() => res.end('<title>Submitted</title><input aria-label="Next input">'), 200);
        return;
      }
      res.end(
        `<!doctype html><html><head><title>Vega complete browser fixture</title></head><body><label>Name<input aria-label="Name"></label><input id="upload" type="file" hidden><button onclick="fetch('/submit').then(()=>document.querySelector('#state').textContent='Saved')">Save</button><div id="state">Ready</div><input id="slider" aria-label="Slider" type="range" min="0" max="100" value="0"><iframe src="/frame"></iframe><div id="shadow"></div><script>const r=document.querySelector('#shadow').attachShadow({mode:'open'});r.innerHTML='<button>Shadow action</button>'</script><div style="height:1800px">long content</div></body></html>`,
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
      const listed = await browserTabs(engine);
      assert(listed.tabs.some((t) => t.tag === tag));
      const preview = await browserScreenshot(
        engine,
        "browser-view:fixture",
        tag,
      );
      assert.equal(preview.tabTag, tag);
      assert(preview.image.width > 0);
      assert.equal(preview.title, "Vega complete browser fixture");
      assert(store.blobData(preview.image.url.split("/").at(-1)!));
      assert.equal(
        engine.observations.get("owner:" + tag)!.id,
        shot.snapshotId,
        "Preview must not overwrite an agent observation",
      );
      assert.equal(submitted, 0, "Viewing a tab must not submit the page");
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
      const remoteOwner = "browser-view:fixture";
      let remote = await browserScreenshot(engine, remoteOwner, tag);
      const remotePoint = async (selector: string) => {
        const o = engine.observations.get(remoteOwner + ":" + tag)!,
          image = o.images[0];
        const r = await engine.evaluate(
          tag,
          o.frames[0],
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
        );
        return {
          x: ((r.x + r.width / 2) * image.pixelWidth) / image.width,
          y: ((r.y + r.height / 2) * image.pixelHeight) / image.height,
          rect: r,
          sx: image.pixelWidth / image.width,
          sy: image.pixelHeight / image.height,
        };
      };
      const click = await remotePoint("input[aria-label=Name]");
      let controlled = await browserControl(engine, remoteOwner, {
        tabTag: tag,
        snapshotId: remote.snapshotId,
        action: { action: "click_at", x: click.x, y: click.y },
      });
      assert.equal(controlled.status, "executed", controlled.reason);
      assert.equal(controlled.editable, true);
      controlled = await browserControl(engine, remoteOwner, {
        tabTag: tag,
        snapshotId: controlled.snapshotId,
        action: { action: "press", key: "Ctrl+A" },
      });
      controlled = await browserControl(engine, remoteOwner, {
        tabTag: tag,
        snapshotId: controlled.snapshotId,
        action: { action: "type", text: "远程输入 ✓" },
      });
      assert.equal(controlled.status, "executed", controlled.reason);
      const remoteValue = await bridge.send(
        "Runtime.evaluate",
        {
          expression: "document.querySelector('input').value",
          returnByValue: true,
        },
        await bridge.attached(tag),
      );
      assert.equal(remoteValue.result.value, "远程输入 ✓");
      assert(
        !engine.observations.has("owner:" + tag),
        "human input invalidates stale agent snapshots without modifying its transcript",
      );
      const slider = await remotePoint("#slider");
      await bridge.send(
        "Runtime.evaluate",
        {
          expression: `window.__dragEvents=[];for(const type of ['pointerdown','pointermove','pointerup'])document.querySelector('#slider').addEventListener(type,()=>__dragEvents.push({type,at:performance.now()}))`,
        },
        await bridge.attached(tag),
      );
      controlled = await browserControl(engine, remoteOwner, {
        tabTag: tag,
        snapshotId: controlled.snapshotId,
        action: {
          action: "drag",
          x: (slider.rect.x + 5) * slider.sx,
          y: slider.y,
          to_x: (slider.rect.x + slider.rect.width - 5) * slider.sx,
          to_y: slider.y,
          duration_ms: 300,
        },
      });
      assert.equal(controlled.status, "executed", controlled.reason);
      const dragEvents = (
        await bridge.send(
          "Runtime.evaluate",
          { expression: "window.__dragEvents", returnByValue: true },
          await bridge.attached(tag),
        )
      ).result.value;
      const lastMove = dragEvents.filter((e: Obj) => e.type === "pointermove").at(-1);
      const release = dragEvents.find((e: Obj) => e.type === "pointerup");
      assert(lastMove && release, "drag must move before releasing");
      assert(
        release.at - lastMove.at >= 80,
        "drag must settle at its destination before releasing",
      );
      assert(
        dragEvents.find((e: Obj) => e.type === "pointerdown").at < lastMove.at,
        "drag must press before moving",
      );
      assert(
        Number(
          (
            await bridge.send(
              "Runtime.evaluate",
              {
                expression: "document.querySelector('#slider').value",
                returnByValue: true,
              },
              await bridge.attached(tag),
            )
          ).result.value,
        ) > 70,
      );
      const save = await remotePoint("button");
      const submission = {
        tabTag: tag,
        snapshotId: controlled.snapshotId,
        action: { action: "click_at", x: save.x, y: save.y },
      };
      controlled = await browserControl(engine, remoteOwner, submission);
      assert.equal(controlled.status, "executed", controlled.reason);
      assert.equal(submitted, 2);
      await assert.rejects(() =>
        browserControl(engine, remoteOwner, submission),
      );
      assert.equal(
        submitted,
        2,
        "lost/duplicate remote request must never submit twice",
      );
      await bridge.send(
        "Runtime.evaluate",
        { expression: "window.scrollTo(0,200)" },
        await bridge.attached(tag),
      );
      await assert.rejects(
        () =>
          browserControl(engine, remoteOwner, {
            tabTag: tag,
            snapshotId: controlled.snapshotId,
            action: { action: "click_at", x: save.x, y: save.y },
          }),
        /变化/,
      );
      await bridge.send(
        "Runtime.evaluate",
        { expression: "window.scrollTo(0,0)" },
        await bridge.attached(tag),
      );
      await t.test("changed target pixels reject coordinate clicks", {
        skip: "截图目标像素校验按用户要求不恢复；其余浏览器安全检查继续执行",
      }, async () => {
        remote = await browserScreenshot(engine, remoteOwner, tag);
        const beforeChange = await remotePoint("button");
        await bridge.send(
          "Runtime.evaluate",
          { expression: "document.querySelector('button').style.background='rgb(255,0,0)'" },
          await bridge.attached(tag),
        );
        controlled = await browserControl(engine, remoteOwner, {
          tabTag: tag,
          snapshotId: remote.snapshotId,
          action: { action: "click_at", x: beforeChange.x, y: beforeChange.y },
        });
        assert.equal(controlled.status, "not_executed", controlled.reason);
        assert.equal(controlled.inputAttempted, false);
        assert.equal(submitted, 2);
      });
      remote = await browserScreenshot(engine, remoteOwner, tag);
      controlled = await browserControl(engine, remoteOwner, {
        tabTag: tag,
        snapshotId: remote.snapshotId,
        action: { action: "scroll_at", x: 400, y: 300, delta: 500 },
      });
      assert.equal(controlled.status, "executed", controlled.reason);
      assert(
        Number(
          (
            await bridge.send(
              "Runtime.evaluate",
              { expression: "scrollY", returnByValue: true },
              await bridge.attached(tag),
            )
          ).result.value,
        ) > 100,
      );
      await bridge.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false },
        await bridge.attached(tag),
      );
      await bridge.send(
        "Runtime.evaluate",
        { expression: "window.scrollTo(0,0)" },
        await bridge.attached(tag),
      );
      const principal = {
        hash: "live-user",
        user: { id: "live-admin", role: "admin" },
      } as Principal;
      const auth = {
        events: new EventEmitter(),
        resolveHash: () => principal,
        authenticate: () => principal,
      } as unknown as Auth;
      live = new BrowserLive(engine, auth);
      const ticket = await live.ticket(principal, tag),
        frames: Obj[] = [],
        messages: Obj[] = [];
      const peer = {
        id: "live-socket",
        request: {
          url: "http://localhost/api/chrome/live?ticket=" + ticket.ticket,
          headers: new Headers({
            origin: "http://localhost",
            cookie: "vega_session=fixture",
          }),
        },
        close: () => {},
        send: (raw: unknown) => {
          const value = JSON.parse(String(raw));
          messages.push(value);
          if (value.type === "frame") {
            frames.push(value);
            queueMicrotask(() =>
              live!.message(
                peer,
                JSON.stringify({ type: "frame_ack", frameId: value.frameId }),
              ),
            );
          }
        },
      };
      const until = async (predicate: () => boolean) => {
        for (let i = 0; i < 400; i++) {
          if (predicate()) return;
          await sleep(10);
        }
        throw Error(
          "Live Chrome timed out " +
            JSON.stringify(
              messages.map((m) => ({
                type: m.type,
                reason: m.reason,
                status: m.status,
              })),
            ),
        );
      };
      const beforeFrames = Number(
        store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get()!.n,
      );
      live.open(peer);
      await until(() => frames.length >= 2);
      assert.equal(
        frames.at(-1)!.width,
        1568,
        "high-DPR frames are resized independently of CSS coordinates",
      );
      live.message(peer, JSON.stringify({ type: "mode", mode: "control" }));
      await until(() =>
        messages.some((m) => m.type === "mode" && m.mode === "control"),
      );
      let sequence = 0;
      const input = async (action: Obj) => {
        const seq = ++sequence;
        live!.message(
          peer,
          JSON.stringify({
            type: "input",
            seq,
            frameId: frames.at(-1)!.frameId,
            action,
          }),
        );
        await until(() =>
          messages.some((m) => m.type === "input_result" && m.seq === seq),
        );
        const result = messages.find(
          (m) => m.type === "input_result" && m.seq === seq,
        )!;
        assert.equal(result.status, "executed", result.reason);
      };
      const point = async (selector: string) => {
        const r = (
          await bridge.send(
            "Runtime.evaluate",
            {
              expression: `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}})()`,
              returnByValue: true,
            },
            await bridge.attached(tag),
          )
        ).result.value;
        const f = frames.at(-1)!;
        return { x: (r.x * f.width) / r.width, y: (r.y * f.height) / r.height };
      };
      await input({
        action: "click_at",
        ...(await point("input[aria-label=Name]")),
      });
      await until(() => frames.at(-1)!.editable === true);
      await input({ action: "press", key: "Ctrl+A" });
      await input({ action: "type", text: "实时WS输入" });
      assert.equal(
        (
          await bridge.send(
            "Runtime.evaluate",
            {
              expression: "document.querySelector('input').value",
              returnByValue: true,
            },
            await bridge.attached(tag),
          )
        ).result.value,
        "实时WS输入",
      );
      const sliderLive = await point("#slider");
      await input({ action: "pointer", phase: "down", ...sliderLive });
      await input({
        action: "pointer",
        phase: "move",
        x: sliderLive.x + 70,
        y: sliderLive.y,
      });
      await input({
        action: "pointer",
        phase: "up",
        x: sliderLive.x + 70,
        y: sliderLive.y,
      });
      await input({ action: "goto", url: url + "/live-form" });
      await until(() => frames.at(-1)!.url === url + "/live-form");
      await input({ action: "click_at", ...(await point('input[aria-label="Query"]')) });
      await until(() => frames.at(-1)!.editable === true);
      const liveSession = live.sessions.get(peer.id);
      await input({ action: "press", key: "Enter" });
      await until(() => frames.at(-1)!.url === url + "/live-submitted");
      const submittedFrame = frames.at(-1)!;
      await until(() => frames.at(-1)!.frameId > submittedFrame.frameId);
      assert.equal(liveSubmitted, 1, "Enter must submit once even when navigation interrupts live observation");
      assert.equal(live.sessions.get(peer.id), liveSession, "navigation must retain the same connection and control lease");
      assert.equal(liveSession!.locked, true);
      assert.equal(messages.some(m => m.type === "error"), false);
      await input({ action: "goto", url: url + "/live" });
      await until(() => frames.at(-1)!.url === url + "/live");
      await input({ action: "click_at", ...(await point("button")) });
      await until(() => submitted === 3);
      const duplicate = {
        type: "input",
        seq: sequence,
        frameId: frames.at(-1)!.frameId,
        action: { action: "click_at", ...(await point("button")) },
      };
      live.message(peer, JSON.stringify(duplicate));
      await engine.gate.run(async () => {});
      assert.equal(submitted, 3, "duplicate WS input cannot submit twice");
      assert.equal(
        Number(store.db.prepare("SELECT COUNT(*) AS n FROM blobs").get()!.n),
        beforeFrames,
        "continuous live frames must never be saved to SQLite",
      );
      await live.close();
      live = undefined;
      assert(
        archive.images.length === 1,
        "Observation not persisted in SQLite",
      );
    } finally {
      await live?.close();
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
