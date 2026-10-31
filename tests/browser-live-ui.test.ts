import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { createServer } from "node:http";
import vue from "@vitejs/plugin-vue";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import sharp from "sharp";
import { sleep, type Obj } from "../server/core/util";

test(
  "live browser component on real touch/desktop Chrome: continuous WS frames, input, URL draft, drag across repaint and no reconnect replay",
  {
    timeout: 60000,
    skip: process.env.VEGA_TEST_CHROME !== "1",
  },
  async () => {
    const binary =
      process.env.VEGA_CHROME_PATH ||
      [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].find(existsSync);
    assert(binary);
    const dir = await mkdtemp(join(tmpdir(), "vega-live-ui-"));
    const inputs: Obj[] = [],
      modes: Obj[] = [],
      clients = new Set<WebSocket>();
    let frames = 0,
      broken = false;
    const image = await sharp({
      create: { width: 900, height: 2500, channels: 3, background: "#c7dafa" },
    })
      .jpeg()
      .toBuffer();
    const tabs = [1, 2].map((n) => ({
      tag: "tab-" + n,
      title: "远程网页" + n,
      url: "https://example.test/" + n + "?" + "long=".repeat(1000),
      controllable: true,
      active: n === 1,
    }));
    const entry = "virtual:live-browser-test";
    await build({
      configFile: false,
      root: process.cwd(),
      logLevel: "error",
      plugins: [
        vue(),
        {
          name: "live-test-entry",
          resolveId(id) {
            if (id === entry) return "\0" + entry;
          },
          load(id) {
            if (id === "\0" + entry)
              return `import {createVaporApp}from'vue';import Browser from ${JSON.stringify(resolve("web/src/BrowserView.vue").replaceAll("\\", "/"))};import ${JSON.stringify(resolve("web/src/style.css").replaceAll("\\", "/"))};const api=async(path,method,value)=>path==='/chrome/tabs'?${JSON.stringify({ connected: true, browser: "fixture", tabs })}:{ticket:value.tabTag};createVaporApp(Browser,{api:()=>api}).mount('#app');`;
          },
        },
      ],
      build: {
        outDir: join(dir, "dist"),
        emptyOutDir: true,
        cssCodeSplit: false,
        rollupOptions: {
          input: entry,
          output: {
            entryFileNames: "entry.js",
            chunkFileNames: "[name].js",
            assetFileNames: "[name][extname]",
          },
        },
      },
    });
    const app = createServer(async (req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname.slice(1);
      if (!path || path === "live-fixture") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>#app{display:flex;flex-direction:column;width:100%;height:100dvh}.topbar{flex-shrink:0}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`,
        );
        return;
      }
      if (!/^[\w.-]+\.(js|css)$/.test(path)) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        res.setHeader(
          "Content-Type",
          path.endsWith(".css") ? "text/css" : "text/javascript",
        );
        res.end(await readFile(join(dir, "dist", path)));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((yes) => app.listen(0, "127.0.0.1", yes));
    const port = (app.address() as any).port,
      base = "http://127.0.0.1:" + port;
    const liveServer = new WebSocketServer({
      server: app,
      path: "/api/chrome/live",
    });
    liveServer.on("connection", (socket, req) => {
      clients.add(socket);
      const tabTag = new URL(req.url!, "http://localhost").searchParams.get(
        "ticket",
      )!;
      let pending = false,
        frameId = 0,
        editable = false,
        url = tabs[0].url;
      const send = () => {
        if (pending || socket.readyState !== WebSocket.OPEN) return;
        pending = true;
        frames++;
        socket.send(
          JSON.stringify({
            type: "frame",
            frameId: ++frameId,
            tabTag,
            title: "远程网页",
            url,
            capturedAt: Date.now(),
            editable,
            width: 900,
            height: 2500,
            data: image.toString("base64"),
          }),
        );
      };
      const timer = setInterval(send, 80);
      socket.send(JSON.stringify({ type: "ready", mode: "view", tabTag }));
      send();
      socket.on("close", () => {
        clients.delete(socket);
        clearInterval(timer);
      });
      socket.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "frame_ack") {
          pending = false;
          return;
        }
        if (m.type === "mode") {
          modes.push(m);
          socket.send(JSON.stringify(m));
          return;
        }
        if (m.type !== "input") return;
        inputs.push(m);
        if (broken) {
          socket.terminate();
          return;
        }
        editable = true;
        if (m.action.action === "goto") url = m.action.url;
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: "input_result",
                seq: m.seq,
                status: "executed",
              }),
            );
        }, 100);
      });
    });
    const chrome = spawn(
      binary,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--user-data-dir=" + join(dir, "profile"),
        "--no-sandbox",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    let ws: WebSocket | undefined,
      session = "",
      sequence = 0;
    const waits = new Map<
      number,
      {
        yes: (value: Obj) => void;
        no: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const errors: string[] = [];
    const command = (method: string, params: Obj = {}, target = session) =>
      new Promise<Obj>((yes, no) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            waits.delete(id);
            no(Error(method + " timeout"));
          }, 5000);
        waits.set(id, { yes, no, timer });
        ws!.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(target ? { sessionId: target } : {}),
          }),
        );
      });
    const evaluate = async (expression: string) => {
      const r = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const until = async (expression: string) => {
      for (let i = 0; i < 150; i++) {
        if (await evaluate(expression)) return;
        await sleep(30);
      }
      throw Error(
        expression +
          "\n" +
          (await evaluate("document.body.innerText")) +
          "\nMODES " +
          JSON.stringify(modes),
      );
    };
    const tap = async (selector: string) => {
      const p = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)}+' '+JSON.stringify([...document.querySelectorAll('button')].map(e=>({text:e.textContent,label:e.getAttribute('aria-label')})))+' '+location.href);e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:Math.min(innerHeight-10,Math.max(10,r.y+r.height/2))};})()`,
      );
      assert(
        await evaluate(
          `!!document.elementFromPoint(${p.x},${p.y})?.closest(${JSON.stringify(selector)})`,
        ),
        "Touch target is occluded " + selector + " " + JSON.stringify(p),
      );
      await command("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [p],
      });
      await command("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await sleep(30);
    };
    const fill = (selector: string, text: string) =>
      evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    try {
      let endpoint = "";
      for (let i = 0; i < 100; i++) {
        try {
          const [port, path] = (
            await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split("\n");
          endpoint = "ws://127.0.0.1:" + port + path;
          break;
        } catch {
          await sleep(50);
        }
      }
      assert(endpoint);
      ws = new WebSocket(endpoint);
      await new Promise<void>((yes, no) => {
        ws!.once("open", yes);
        ws!.once("error", no);
      });
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()),
          p = waits.get(m.id);
        if (p) {
          waits.delete(m.id);
          clearTimeout(p.timer);
          m.error ? p.no(Error(m.error.message)) : p.yes(m.result);
        } else if (m.method === "Runtime.exceptionThrown")
          errors.push(
            m.params.exceptionDetails.exception?.description ||
              m.params.exceptionDetails.text,
          );
      });
      const { targetId } = await command(
        "Target.createTarget",
        { url: "about:blank" },
        "",
      );
      session = (
        await command("Target.attachToTarget", { targetId, flatten: true }, "")
      ).sessionId;
      await command("Runtime.enable");
      await command("Page.enable");
      await command("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await command("Emulation.setTouchEmulationEnabled", { enabled: true });
      await command("Page.navigate", { url: base + "/live-fixture" });
      await until(
        `document.querySelector('.browser-image img')?.naturalWidth===900`,
      );
      const before = frames;
      await evaluate(
        `window.__liveImage=document.querySelector('.browser-image img');window.__liveButton=document.querySelector('.browser-address button')`,
      );
      await sleep(250);
      assert(
        await evaluate(
          `window.__liveImage===document.querySelector('.browser-image img')`,
        ),
        "live frame node state " +
          JSON.stringify(
            await evaluate(
              `({saved:typeof window.__liveImage,connected:window.__liveImage?.isConnected,frames:document.querySelectorAll('.browser-image img').length,origin:performance.timeOrigin})`,
            ),
          ),
      );
      assert(
        await evaluate(
          `window.__liveButton===document.querySelector('.browser-address button')`,
        ),
        "live frames must retain the control button",
      );
      assert(frames > before, "frames update without manual refresh or input");
      await until(
        `document.querySelector('[aria-label="开启远程操作"]')?.disabled===false`,
      );
      await tap('[aria-label="开启远程操作"]');
      await sleep(350);
      assert.equal(modes.at(-1)?.mode, "control", JSON.stringify(modes));
      await until(`document.querySelector('.remote-controls')`);
      await tap(".browser-image img");
      for (let i = 0; i < 100 && !inputs.length; i++) await sleep(10);
      assert.equal(inputs[0].action.action, "click_at");
      assert(Math.abs(inputs[0].action.x - 450) < 3);
      await tap(".remote-input summary");
      await until(
        `!document.querySelector('.remote-text button').disabled||document.querySelector('.browser-image img').naturalWidth===900`,
      );
      await fill('textarea[aria-label="远程输入文字"]', "即时输入：你好");
      await until(`!document.querySelector('.remote-text button').disabled`);
      await tap(".remote-text button");
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.text === "即时输入：你好");
        i++
      )
        await sleep(10);
      assert(inputs.some((m) => m.action.text === "即时输入：你好"));
      await sleep(140);
      await tap('[aria-label="远程按键 回车"]');
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.key === "Enter");
        i++
      )
        await sleep(10);
      assert(inputs.some((m) => m.action.key === "Enter"));
      await fill(
        'input[aria-label="远程网页地址"]',
        "https://example.test/new-draft",
      );
      await sleep(350);
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="远程网页地址"]').value`,
        ),
        "https://example.test/new-draft",
        "stream frames must not overwrite URL edits",
      );
      await tap(".remote-url button");
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.action === "goto");
        i++
      )
        await sleep(10);
      assert.equal(
        inputs.find((m) => m.action.action === "goto")?.action.url,
        "https://example.test/new-draft",
      );
      await sleep(150);
      await fill('select[aria-label="截图操作模式"]', "drag");
      const p = await evaluate(
        `(()=>{const e=document.querySelector('.browser-image img');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width*.75,y:innerHeight/2}})()`,
      );
      await command("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [p],
      });
      for (let n = 1; n <= 6; n++) {
        await sleep(60);
        await command("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: p.x - n * 20, y: p.y }],
        });
      }
      await command("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.phase === "up");
        i++
      )
        await sleep(10);
      assert(inputs.some((m) => m.action.phase === "down"));
      assert(inputs.some((m) => m.action.phase === "move"));
      assert(
        inputs.some((m) => m.action.phase === "up"),
        "stream repaint must not remove pointer capture during drag",
      );
      for (const [width, height] of [
        [320, 568],
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width < 800,
        });
        assert(
          await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),
          "browser width " + width,
        );
        if (width < 760)
          assert.equal(
            await evaluate(
              `JSON.stringify([...document.querySelectorAll('.remote-controls button,.browser-address button,.browser-tab')].filter(e=>e.getBoundingClientRect().height>0&&e.getBoundingClientRect().height<43).map(e=>e.textContent.trim()))`,
            ),
            "[]",
            "touch controls at least 44px",
          );
      }
      await fill('select[aria-label="截图操作模式"]', "click");
      await sleep(150);
      await evaluate(`document.querySelector('.browser-image img').focus()`);
      for (const key of "abc")
        await command("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code: "Key" + key.toUpperCase(),
          windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        });
      for (
        let i = 0;
        i < 100 &&
        inputs
          .filter((m) => m.action.action === "type")
          .map((m) => m.action.text)
          .join("")
          .indexOf("abc") < 0;
        i++
      )
        await sleep(10);
      assert(
        inputs
          .filter((m) => m.action.action === "type")
          .map((m) => m.action.text)
          .join("")
          .includes("abc"),
        "rapid typing is coalesced rather than dropped",
      );
      await until(
        `document.querySelector('[aria-label="远程按键 回车"]')?.disabled===false`,
      );
      broken = true;
      const sent = inputs.length;
      await tap('[aria-label="远程按键 回车"]');
      await until(
        `document.querySelector('[role=alert]')?.textContent.includes('不要重复提交')`,
      );
      await sleep(250);
      assert.equal(
        inputs.length,
        sent + 1,
        "disconnection must not replay input",
      );
      assert.equal(clients.size, 0);
      assert.deepEqual(errors, []);
    } finally {
      if (ws?.readyState === WebSocket.OPEN)
        await command("Browser.close", {}, "").catch(() => {});
      ws?.terminate();
      for (const p of waits.values()) {
        clearTimeout(p.timer);
        p.no(Error("Test closed"));
      }
      chrome.kill();
      for (const c of clients) c.terminate();
      await new Promise<void>((yes) => liveServer.close(() => yes()));
      app.closeAllConnections();
      await new Promise<void>((yes) => app.close(() => yes()));
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
