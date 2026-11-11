import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { createServer, type ServerResponse } from "node:http";
import vue from "@vitejs/plugin-vue";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import sharp from "sharp";
import { sleep, type Obj } from "../server/core/util";

test(
  "live browser component on real touch/desktop Chrome: continuous SSE frames, input, URL draft, drag across repaint and no reconnect replay",
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
      modes: Obj[] = [];
    let frames = 0,
      broken = false,
      inputDelay = 100;
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
    // 浏览器实时通道是 SSE：车道 0 只走控制帧（channel/ready/mode/input_result），并请对端再开一条数据车道
    // 放画面帧；数据车道还没建立时大帧退回车道 0（协议允许的兜底）。
    type LiveSession = {
      channel: string;
      tabTag: string;
      lane0: ServerResponse;
      lane1?: ServerResponse;
      timer: ReturnType<typeof setInterval>;
      frameId: number;
      inputSeq: number;
      pending: boolean;
      editable: boolean;
      url: string;
      closed: boolean;
    };
    const live = new Map<string, LiveSession>(),
      streams = new Set<ServerResponse>();
    let channels = 0;
    const emit = (lane: ServerResponse | undefined, value: unknown) => {
      if (!lane || lane.writableEnded || lane.destroyed) return;
      lane.write("data: " + JSON.stringify(value) + "\n\n");
    };
    const openStream = (res: ServerResponse) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streams.add(res);
      res.on("close", () => streams.delete(res));
    };
    const sendFrame = (session: LiveSession) => {
      if (session.pending || session.closed) return;
      session.pending = true;
      frames++;
      emit(session.lane1 || session.lane0, {
        type: "frame",
        frameId: ++session.frameId,
        inputSeq: session.inputSeq,
        tabTag: session.tabTag,
        title: "远程网页",
        url: session.url,
        capturedAt: Date.now(),
        editable: session.editable,
        width: 900,
        height: 2500,
        data: image.toString("base64"),
      });
    };
    // 模拟连接中断：不发 closed 帧直接断流，对端按 1006 处理，不会重放已发出的操作。
    const abort = (session: LiveSession) => {
      session.closed = true;
      clearInterval(session.timer);
      live.delete(session.channel);
      for (const lane of [session.lane0, session.lane1])
        if (lane && !lane.destroyed) lane.destroy();
    };
    const app = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost"),
        path = url.pathname.slice(1);
      if (path === "api/chrome/live") {
        if (Number(url.searchParams.get("lane") || 0) > 0) {
          // 数据车道：对端用 channel 重新验证同一个身份再开一条流；夹具只认通道是否存在。
          const session = live.get(url.searchParams.get("channel") || "");
          if (!session) return void res.writeHead(409).end();
          openStream(res);
          session.lane1 = res;
          res.on("close", () => {
            if (session.lane1 === res) session.lane1 = undefined;
          });
          return;
        }
        // 夹具里票据就是标签本身。
        const tabTag = url.searchParams.get("ticket")!,
          session: LiveSession = {
            channel: "ch" + ++channels,
            tabTag,
            lane0: res,
            timer: undefined as any,
            frameId: 0,
            inputSeq: 0,
            pending: false,
            editable: false,
            url: tabs[0].url,
            closed: false,
          };
        live.set(session.channel, session);
        openStream(res);
        emit(res, { type: "channel", channel: session.channel });
        emit(res, { type: "ready", mode: "view", tabTag });
        sendFrame(session);
        // 首帧已经落在车道 0；现在请对端再开一条数据车道，后面的画面帧走它。
        emit(res, { type: "lane", open: 1 });
        session.timer = setInterval(() => sendFrame(session), 80);
        return;
      }
      if (path === "api/chrome/live/input") {
        // 上行：每个手势一条 POST，body 是 { channel, message }，同一通道按到达顺序处理。
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"),
          session = live.get(body.channel),
          message: Obj = body.message || {};
        res.setHeader("Content-Type", "application/json");
        if (!session) {
          res.writeHead(409);
          res.end(JSON.stringify({ message: "实时连接已失效，请重新连接" }));
          return;
        }
        if (message.type === "frame_ack") session.pending = false;
        else if (message.type === "mode") {
          modes.push(message);
          emit(session.lane0, message);
        } else if (["input", "pointer"].includes(message.type)) {
          inputs.push(message);
          if (broken) {
            abort(session);
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          session.editable = true;
          if (message.action.action === "goto") session.url = message.action.url;
          setTimeout(() => {
            session.inputSeq = message.seq;
            emit(session.lane0, {
              type: message.type === "pointer" ? "pointer_result" : "input_result",
              dragSeq: message.dragSeq,
              seq: message.seq,
              status: "executed",
            });
          }, inputDelay);
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }
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
    const contextMenu = (pointerType: string) =>
      evaluate(
        `(()=>{const e=document.querySelector('.browser-image'),r=e.querySelector('img').getBoundingClientRect();if(${JSON.stringify(pointerType)}==='mouse')e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:2}));const event=new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:${JSON.stringify(pointerType)},button:2,clientX:r.x+r.width/2,clientY:r.y+r.height/2});e.dispatchEvent(event);return event.defaultPrevented;})()`,
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
        `window.__liveImage=document.querySelector('.browser-image img');window.__liveButton=document.querySelector('.browser-address .remote-toggle')`,
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
          `window.__liveButton===document.querySelector('.browser-address .remote-toggle')`,
        ),
        "live frames must retain the control button",
      );
      assert(frames > before, "frames update without manual refresh or input");
      await until(
        `document.querySelector('.browser-image img')?.complete===true`,
      );
      assert.equal(
        await contextMenu("touch"),
        true,
        "view mode must suppress the local image context menu",
      );
      assert.equal(inputs.length, 0, "long press must not claim control");
      assert.equal(modes.length, 0);
      await tap(".browser-image");
      await sleep(100);
      assert.equal(modes.length, 0, "a view click must not request control");
      assert.equal(inputs.length, 0, "a view click must not reach the webpage");
      await evaluate(`(()=>{const e=document.querySelector('.browser-image img'),r=e.getBoundingClientRect();e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,deltaY:-240}));})()`);
      assert(await evaluate(`document.querySelector('.browser-image img').style.transform.includes('scale(1.')`), "wheel zooms the local preview");
      const viewPoint = await evaluate(`(()=>{const r=document.querySelector('.browser-image img').getBoundingClientRect();return{x:(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y:(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2}})()`);
      await command("Input.dispatchMouseEvent", { type: "mousePressed", x: viewPoint.x, y: viewPoint.y, button: "left", buttons: 1, clickCount: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: viewPoint.x + 24, y: viewPoint.y + 16, button: "left", buttons: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: viewPoint.x + 24, y: viewPoint.y + 16, button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      assert.equal(modes.length, 0, "preview panning must not claim control");
      assert.equal(inputs.length, 0, "preview zoom and panning must not reach the webpage");
      await tap(".browser-address .zoom-reset");
      assert(await evaluate(`document.querySelector('.browser-image img').style.transform.includes('scale(1)')`));
      const pinch = await evaluate(`(()=>{const e=document.querySelector('.browser-image');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2}})()`);
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: pinch.x - 25, y: pinch.y }, { id: 2, x: pinch.x + 25, y: pinch.y }] });
      for (let step = 1; step <= 5; step++) {
        await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: pinch.x - 25 - step * 6, y: pinch.y }, { id: 2, x: pinch.x + 25 + step * 6, y: pinch.y }] });
        await sleep(20);
      }
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert(await evaluate(`Number(/scale\\(([^)]+)\\)/.exec(document.querySelector('.browser-image img').style.transform)[1])>1.5`), "two fingers zoom only the preview");
      assert.equal(await evaluate("visualViewport.scale"), 1, "the surrounding application stays fixed");
      const beforePan = await evaluate(`document.querySelector('.browser-image img').style.transform`);
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pinch.x, y: pinch.y }] });
      await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pinch.x + 30, y: pinch.y - 25 }] });
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.notEqual(await evaluate(`document.querySelector('.browser-image img').style.transform`), beforePan, "one finger pans the zoomed preview");
      assert.equal(inputs.length, 0);
      assert.equal(modes.length, 0);
      // 查看模式不渲染辅助输入（组件里是 v-if="selected && operating"），所以基线只比较画面本身的几何。
      const geometry = () => evaluate(`(()=>{const image=document.querySelector('.browser-image'),controls=document.querySelector('.remote-controls'),panel=document.querySelector('.browser-panel'),box=image.getBoundingClientRect();return{imageTop:box.top-panel.getBoundingClientRect().top,imageWidth:box.width,imageHeight:box.height,controlsHeight:controls?controls.getBoundingClientRect().height:0,panelHeight:panel.getBoundingClientRect().height}})()`);
      const beforeControl = await geometry();
      const zoomedTransform = await evaluate(`document.querySelector('.browser-image img').style.transform`);
      assert.equal(beforeControl.controlsHeight, 0, "view mode leaves the auxiliary controls out of the layout");
      assert.equal(await evaluate(`!!document.querySelector('.remote-text textarea')`), false, "view mode offers no auxiliary input");
      await tap(".browser-address .remote-toggle");
      await sleep(350);
      const controlling = await geometry();
      assert(controlling.controlsHeight > 0, "control mode adds the auxiliary controls");
      assert.equal(controlling.imageWidth, beforeControl.imageWidth, "starting control must not change the image width");
      assert.equal(await evaluate(`document.querySelector('.browser-image img').style.transform`), zoomedTransform, "starting control preserves pinch zoom and panning");
      assert.equal(modes.at(-1)?.mode, "control", JSON.stringify(modes));
      assert.equal(await evaluate(`document.querySelector('.browser-address .remote-toggle').textContent.trim()`), "退出操作");
      await until(`document.querySelector('.remote-text textarea')?.getClientRects().length>0`);
      assert.equal(await evaluate(`document.querySelector('.remote-input').open`), false, "auxiliary input is visible without opening advanced controls");
      const held = await evaluate(`(()=>{const e=document.querySelector('.browser-image');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2}})()`);
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [held] });
      await sleep(650);
      assert.equal(await contextMenu(""), true, "legacy touch context menus without pointerType are blocked too");
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.equal(inputs.length, 0, "a real touch long press must not turn into a click or a remote right click");
      const expectedTap = await evaluate(`(()=>{const e=document.querySelector('.browser-image');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),image=e.querySelector('img'),picture=image.getBoundingClientRect();return{x:Math.floor((r.x+r.width/2-picture.left)*image.naturalWidth/picture.width),y:Math.floor((Math.min(innerHeight-10,Math.max(10,r.y+r.height/2))-picture.top)*image.naturalHeight/picture.height)}})()`);
      await tap(".browser-image");
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.action === "click_at");
        i++
      )
        await sleep(10);
      assert(
        inputs.some((m) => m.action.action === "click_at"),
        "tap after explicitly starting control must send click_at; modes=" +
          JSON.stringify(modes) +
          " state=" +
          (await evaluate(
            `JSON.stringify([...document.querySelectorAll('.browser-address .pill,.browser-address button')].map(e=>e.textContent.trim()))`,
          )),
      );
      assert.equal(inputs[0].action.action, "click_at");
      await until(`!document.querySelector('.remote-text textarea').placeholder.startsWith('先点击')`);
      assert.deepEqual(await geometry(), controlling, "selecting an editable target must not reflow the auxiliary controls");
      assert(Math.abs(inputs[0].action.x - expectedTap.x) < 3);
      assert(Math.abs(inputs[0].action.y - expectedTap.y) < 3);
      assert.equal(await contextMenu("touch"), true);
      await sleep(250);
      assert.equal(
        inputs.filter((m) => m.action.button === "right").length,
        0,
        "touch long press must not send a remote right click",
      );
      assert.equal(await contextMenu("mouse"), true);
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.button === "right");
        i++
      )
        await sleep(10);
      assert.equal(
        inputs.filter((m) => m.action.button === "right").length,
        1,
        "only a mouse context menu must send a remote right click",
      );
      await until(`!document.querySelector('[aria-label="远程按键 回车"]').disabled`);
      const touchDragStart = inputs.length;
      const dragPoint = await evaluate(`(()=>{const e=document.querySelector('.browser-image');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),image=e.querySelector('img'),picture=image.getBoundingClientRect(),x=r.x+r.width/2,y=Math.min(innerHeight-30,Math.max(30,r.y+r.height/2));return{x,y,rawX:Math.floor((x-picture.left)*image.naturalWidth/picture.width),rawY:Math.floor((y-picture.top)*image.naturalHeight/picture.height)}})()`);
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: dragPoint.x, y: dragPoint.y }] });
      await sleep(650);
      assert.equal(inputs.length, touchDragStart, "holding still must not send a mouse press");
      for (let n = 1; n <= 8; n++) {
        await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: dragPoint.x - n * 6, y: dragPoint.y + n * 2 }] });
        await sleep(20);
      }
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      for (let i = 0; i < 100 && !inputs.slice(touchDragStart).some((m) => m.action.phase === "up"); i++) await sleep(20);
      const touchDrag = inputs.slice(touchDragStart);
      assert.equal(touchDrag[0]?.action.phase, "down", JSON.stringify(touchDrag));
      assert.equal(touchDrag.at(-1)?.action.phase, "up", JSON.stringify(touchDrag));
      assert(touchDrag.some((m) => m.action.phase === "move"));
      assert(touchDrag.every((m) => m.action.action === "pointer" && m.frameId === touchDrag[0].frameId), "held touch maps to one pinned mouse gesture, not clicks");
      assert(Math.abs(touchDrag[0].action.x - dragPoint.rawX) < 3);
      assert(Math.abs(touchDrag[0].action.y - dragPoint.rawY) < 3);
      assert(touchDrag.at(-1)!.action.x < touchDrag[0].action.x);
      assert.equal(await evaluate(`document.querySelector('.browser-image img').style.transform`), zoomedTransform, "remote touch drag must not pan the zoomed preview");
      await sleep(150);
      assert.equal(inputs.length, touchDragStart + touchDrag.length, "lifting after a drag must not synthesize a click");
      await tap('textarea[aria-label="远程输入文字"]');
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), "远程输入文字", "the auxiliary field can open a phone keyboard");
      await until(
        `!document.querySelector('.remote-text button').disabled||document.querySelector('.browser-image img').naturalWidth===900`,
      );
      const typedBeforeSend = inputs.length;
      await fill('textarea[aria-label="远程输入文字"]', "即时输入：你好");
      await sleep(80);
      assert.equal(inputs.length, typedBeforeSend, "composition and draft edits must not type into the remote page before Send");
      await until(`!document.querySelector('.remote-text button').disabled`);
      await tap(".remote-text button");
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.text === "即时输入：你好");
        i++
      )
        await sleep(10);
      assert(inputs.some((m) => m.action.text === "即时输入：你好"));
      assert.equal(inputs.some((m) => m.action.key === "Enter"), false, "sending text does not submit the remote form");
      await sleep(140);
      await tap('[aria-label="远程按键 回车"]');
      for (
        let i = 0;
        i < 100 && !inputs.some((m) => m.action.key === "Enter");
        i++
      )
        await sleep(10);
      assert(inputs.some((m) => m.action.key === "Enter"));
      await tap(".remote-input summary");
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
      const p = await evaluate(
        `(()=>{const e=document.querySelector('.browser-image');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width*.75,y:Math.min(innerHeight-10,Math.max(10,r.y+r.height/2))}})()`,
      );
      const mouseDragStart = inputs.length;
      const clicksBeforeDrag = inputs.filter(
        (m) => m.action.action === "click_at",
      ).length;
      await command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: p.x,
        y: p.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (let n = 1; n <= 100; n++) {
        if (n % 10 === 0) await sleep(30);
        await command("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x - n * 1.2,
          y: p.y,
          button: "left",
          buttons: 1,
        });
      }
      await command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: p.x - 120,
        y: p.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      for (
        let i = 0;
        i < 100 && !inputs.slice(mouseDragStart).some((m) => m.action.phase === "up");
        i++
      )
        await sleep(10);
      assert(inputs.slice(mouseDragStart).some((m) => m.action.phase === "down"));
      const dragInputs = inputs.slice(mouseDragStart).filter(m => m.action.action === "pointer");
      assert(dragInputs.every(m => m.frameId === dragInputs[0].frameId), "repaints must not relabel an ongoing mouse gesture");
      assert(dragInputs.some((m) => m.action.phase === "move"));
      assert(
        dragInputs.some((m) => m.action.phase === "up"),
        "stream repaint must not remove pointer capture during drag",
      );
      await sleep(400);
      assert.equal(
        inputs.filter((m) => m.action.action === "click_at").length,
        clicksBeforeDrag,
        "a drag must not also send a click",
      );
      inputDelay = 600;
      for (let attempt = 0; attempt < 2; attempt++) {
        await until(`!document.querySelector('[aria-label="远程按键 回车"]').disabled`);
        const start = inputs.length;
        const point = await evaluate(`(()=>{const e=document.querySelector('.browser-image');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:Math.min(innerHeight-40,Math.max(40,r.y+r.height/2))}})()`);
        await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, ...point }] });
        await sleep(600);
        await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: point.x - 10, y: point.y }] });
        await sleep(650);
        for (let n = 1; n <= 10; n++) {
          await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: point.x - 10 - n * 4, y: point.y }] });
          await sleep(25);
        }
        const beforeRelease: number = inputs.length;
        await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        for (let i = 0; i < 20 && !inputs.slice(start).some(m => m.action.phase === "up"); i++) await sleep(10);
        const drag = inputs.slice(start);
        assert.equal(drag.filter(m => m.action.phase === "down").length, 1, "each repeated touch starts its own gesture");
        assert(drag.filter(m => m.action.phase === "move").length >= 2, "slow acknowledgements must not serialize every movement round trip");
        assert.equal(drag.at(-1)?.action.phase, "up", "release is sent ahead of the delayed movement acknowledgements");
        assert.equal(inputs.length, beforeRelease + 1);
        assert(drag.every(m => m.action.action === "pointer" && m.frameId === drag[0].frameId));
        await until(`!document.querySelector('[aria-label="远程按键 回车"]').disabled`);
        assert.equal(await evaluate(`document.querySelector('.browser-view [role=alert]')?.textContent||''`), "");
      }
      inputDelay = 100;
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
      const desktopControl = await geometry();
      assert(desktopControl.controlsHeight > 0, "desktop control shows the auxiliary controls");
      await tap(".browser-address .remote-toggle");
      await until(`document.querySelector('.browser-address .remote-toggle').textContent.trim()==='开始操作'`);
      const noControls = await geometry();
      assert.equal(noControls.controlsHeight, 0, "exiting desktop control returns the panel to the view layout");
      assert.equal(noControls.imageWidth, desktopControl.imageWidth, "exiting control must not change the image width");
      await tap(".browser-address .remote-toggle");
      await until(`document.querySelector('[aria-label="远程按键 回车"]').disabled===false`);
      assert.equal((await geometry()).controlsHeight, desktopControl.controlsHeight, "re-entering desktop control restores the same auxiliary controls");
      await evaluate(`document.querySelector('.browser-image').focus()`);
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
      await tap(".browser-address .remote-toggle");
      await until(`document.querySelector('.browser-address .remote-toggle').textContent.trim()==='开始操作'`);
      const afterExit = inputs.length;
      await tap(".browser-image");
      await sleep(100);
      assert.equal(inputs.length, afterExit, "exit returns to view-only mode immediately");
      assert.equal(modes.at(-1)?.mode, "view");
      await tap(".browser-address .remote-toggle");
      await until(`document.querySelector('.browser-address .remote-toggle').textContent.trim()==='退出操作'`);
      await until(`document.querySelector('[aria-label="远程按键 回车"]')?.disabled===false`);
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
      // 页面丢掉这条通道后不应该再占着下行连接（车道 0 和数据车道都断开）。
      for (let i = 0; i < 100 && streams.size; i++) await sleep(20);
      assert.equal(streams.size, 0);
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
      for (const session of live.values()) abort(session);
      for (const lane of streams) lane.destroy();
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
