import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { Store } from "../server/core/store";
import { Experiences } from "../server/core/experiences";
import { sleep } from "../server/core/util";

test(
  "mobile production UI: touch navigation, every page, keyboard resize, IME, attachments, provider return and desktop regression",
  {
    timeout: 120000,
    skip:
      process.env.VEGA_TEST_CHROME !== "1" ||
      process.env.VEGA_TEST_DEPLOYED !== "1",
  },
  async (t) => {
    const binary =
      process.env.VEGA_CHROME_PATH ||
      [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].find(existsSync);
    assert(binary, "Set VEGA_CHROME_PATH");
    const dir = await mkdtemp(join(tmpdir(), "vega-mobile-")),
      profile = join(dir, "profile"),
      db = join(dir, "mobile.db"),
      token = randomBytes(32).toString("base64url");
    const png = await sharp({
      create: { width: 1568, height: 6000, channels: 3, background: "#b7dfcc" },
    })
      .png()
      .toBuffer();
    const photo = join(dir, "photo.png"),
      skill = join(dir, "skill.zip");
    await writeFile(photo, png);
    await writeFile(
      skill,
      zipSync({
        "SKILL.md": strToU8(
          "---\nname: mobile-upload\ndescription: phone upload fixture\n---\nA test skill.",
        ),
      }),
    );
    const requests: any[] = [];
    const mock = createServer(async (req, res) => {
      if (req.url === "/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            data: [
              {
                id: "phone-model",
                name: "手机测试模型",
                context_length: 128000,
                max_output_tokens: 4096,
                architecture: { input_modalities: ["text", "image"] },
              },
            ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "移动端回归回复" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((yes) => mock.listen(0, "127.0.0.1", yes));
    const config = {
      model: "fixture/phone-model",
      provider: {
        fixture: {
          name: "长服务商名称" + "测试".repeat(30),
          api: "openai-completions",
          options: {
            baseURL: `http://127.0.0.1:${(mock.address() as any).port}`,
            apiKey: "fixture-only-key",
          },
          models: {
            "phone-model": {
              name: "长模型名称" + "model-".repeat(35),
              limit: { context: 128000, output: 4096 },
              modalities: { input: ["text", "image"] },
              variants: { low: { reasoningEffort: "low" } },
            },
          },
        },
      },
      scenes: {
        lightweight: ["fixture/phone-model"],
        coding: ["fixture/phone-model"],
        computer: ["fixture/phone-model"],
      },
      mcp: {
        ["long-service-".repeat(12)]: { url: "https://example.test/mcp" },
      },
    };
    const store = new Store(db),
      session = store.newSession({
        title: "非常长的会话标题" + "long-title-".repeat(40),
        cwd: dir,
        model: config.model,
      });
    store.put("config", config);
    const inlineBlob = store.blob("image/png", png);
    store.grantBlob(inlineBlob, session.id);
    store.append(session.id, {
      role: "user",
      at: 1000,
      text: "https://example.test/" + "a".repeat(2000),
    });
    store.append(session.id, {
      role: "assistant",
      at: 2000,
      text: "过程说明",
      thinking: "分析上下文",
      usage: { input: 100, output: 20, totalTokens: 120 },
    });
    store.append(session.id, {
      role: "tool",
      at: 3000,
      name: "read",
      callId: "fixture-read",
      text: "工具结果",
    });
    store.append(session.id, {
      role: "assistant",
      at: 4000,
      text: "已有历史正文\n".repeat(300) + "\n| **项目** | 数量 | 状态 | 说明 | 路径 | 备注 |\n| :--- | :---: | ---: | --- | --- | --- |\n| `read` | 12 | 完成 | 表格内容 | example.txt | 可横向滚动 |\n\n![Markdown 图片](</api/blobs/" + inlineBlob + ">)\n",
      usage: { input: 50, output: 10, totalTokens: 60 },
    });
    new Experiences(store).execute(
      "fixture",
      {
        operation: "experience_save",
        snapshotId: "fixture",
        experience: {
          scope: "https://example.test",
          task: "经验任务" + "word-".repeat(50),
          conditions: ["已登录"],
          steps: ["打开列表", "选择记录" + "long-".repeat(80)],
          checks: ["完成"],
          outcome: "success",
          evidence: "fixture passed",
          redacted: true,
        },
      },
      { id: "fixture", origin: "https://example.test" },
    );
    const worker = store.newSession({
        title: "员工专属主会话",
        cwd: dir,
        taskId: "seeded-worker",
      }),
      computer = store.newSession({
        title: "员工专属电脑会话",
        cwd: dir,
        taskId: "seeded-worker",
        scene: "computer",
      });
    store.append(worker.id, {
      role: "assistant",
      text: "employee-only work record",
    });
    store.append(computer.id, {
      role: "assistant",
      text: "employee-only browser record",
    });
    store.put("employee", {
      enabled: false,
      public: false,
      workStart: "09:00",
      workEnd: "18:00",
      idleMinutes: 10,
      takeoverSeconds: 15,
      desktopAskAfter: 0,
      cwd: dir,
      duties: [],
      tasks: [
        {
          id: "seeded-worker",
          text: "seeded employee task",
          status: "done",
          createdAt: Date.now(),
          profile: "lightweight",
          cwd: dir,
          owner: { token: "", name: "" },
          workSession: worker.id,
          computerSession: computer.id,
        },
      ],
      memories: [],
      runs: [],
      orbit: [],
      links: [],
    });
    store.close();
    const reserve = createServer();
    await new Promise<void>((yes) => reserve.listen(0, "127.0.0.1", yes));
    const port = (reserve.address() as any).port;
    await new Promise<void>((yes) => reserve.close(() => yes()));
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(
      process.execPath,
      [resolve(".output/server/index.mjs")],
      {
        env: {
          ...process.env,
          VEGA_DB: db,
          VEGA_TOKEN: token,
          VEGA_PUBLIC_URL: base,
          VEGA_SKILL_CACHE: join(dir, "skills"),
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: String(port),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    server.stdout!.on("data", (c) => (logs += c));
    server.stderr!.on("data", (c) => (logs += c));
    const browser = spawn(
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
    let ws: WebSocket | undefined,
      nextId = 0,
      sessionId = "",
      loginComplete = false,
      imports = 0,
      acceptDialog = false,
      employeeLoads = 0,
      blockEmployee = true,
      browserCapture = 0,
      failRemote = false;
    const remoteInputs: any[] = [];
    const liveTickets = new Map<string, string>();
    const liveServer = new WebSocketServer({
      server: mock,
      path: "/browser-live",
    });
    const liveImage = (
      await sharp(png).jpeg({ quality: 70 }).toBuffer()
    ).toString("base64");
    liveServer.on("connection", (socket, req) => {
      const ticket = new URL(req.url!, "http://localhost").searchParams.get(
          "ticket",
        )!,
        tabTag = liveTickets.get(ticket)!;
      liveTickets.delete(ticket);
      let frameId = 0,
        inputSeq = 0,
        pending = false,
        editable = false,
        pageURL = "https://example.test/" + "long/".repeat(1000);
      const frame = () => {
        if (pending || socket.readyState !== WebSocket.OPEN) return;
        pending = true;
        socket.send(
          JSON.stringify({
            type: "frame",
            frameId: ++frameId,
            inputSeq,
            tabTag,
            title: tabTag,
            url: pageURL,
            capturedAt: Date.now(),
            editable,
            width: 1568,
            height: 6000,
            data: liveImage,
          }),
        );
      };
      const timer = setInterval(frame, 100);
      socket.send(JSON.stringify({ type: "ready", tabTag, mode: "view" }));
      frame();
      socket.on("close", () => clearInterval(timer));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "frame_ack") {
          pending = false;
          return;
        }
        if (message.type === "mode") {
          socket.send(JSON.stringify(message));
          return;
        }
        if (!["input", "pointer"].includes(message.type)) return;
        remoteInputs.push(message);
        if (failRemote) {
          socket.terminate();
          return;
        }
        editable = true;
        if (message.action.action === "goto") pageURL = message.action.url;
        setTimeout(() => {
          inputSeq = message.seq;
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: message.type === "pointer" ? "pointer_result" : "input_result",
                dragSeq: message.dragSeq,
                seq: message.seq,
                status: "executed",
              }),
            );
        }, 80);
      });
    });
    const dialogs: { message: string; type: string }[] = [];
    const waiting = new Map<
        number,
        {
          yes: (v: any) => void;
          no: (e: any) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >(),
      errors: string[] = [];
    const command = (method: string, params: any = {}, target = sessionId) =>
      new Promise<any>((yes, no) => {
        const id = ++nextId,
          timer = setTimeout(() => {
            waiting.delete(id);
            no(Error("CDP timeout: " + method));
          }, 8000);
        waiting.set(id, { yes, no, timer });
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
      const value = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      assert(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const until = async (expression: string, label = expression) => {
      for (let i = 0; i < 80; i++) {
        if (await evaluate(expression)) return;
        await sleep(50);
      }
      throw Error(
        "UI timed out: " +
          label +
          "\n" +
          (await evaluate("document.body.innerText")).slice(0, 1600) +
          "\n" +
          logs,
      );
    };
    const tap = async (selector: string) => {
      const p = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();if(!r.width||!r.height||e.closest('[inert]'))throw Error('Not reachable '+${JSON.stringify(selector)});const candidates=[{x:r.x+r.width/2,y:r.y+r.height/2},{x:Math.min(innerWidth-8,r.right-8),y:r.y+r.height/2}];const p=candidates.find(p=>document.elementFromPoint(p.x,p.y)?.closest(${JSON.stringify(selector)}));if(!p)throw Error('Occluded '+${JSON.stringify(selector)});return p;})()`,
      );
      const hit = await evaluate(
        `!!document.elementFromPoint(${p.x},${p.y})?.closest(${JSON.stringify(selector)})`,
      );
      assert(
        hit,
        "touch must start inside " + selector + " " + JSON.stringify(p),
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
    const dragMouse = async (selector: string) => {
      const p = await evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);return {x:left+(right-left)*0.75,y:(top+bottom)/2}})()`,
      );
      await command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: p.x,
        y: p.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (let n = 1; n <= 6; n++) {
        await evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        await command("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x - n * 20,
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
    };
    const swipe = async (selector: string, horizontal = false) => {
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const p = await evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);if(right-left<60||bottom-top<${horizontal ? 24 : 60})throw Error('Swipe area not visible');return {x: ${horizontal} ? right-24:(left+right)/2,y:${horizontal} ? (top+bottom)/2:bottom-24,to:${horizontal} ? left+24:top+24}})()`,
      );
      assert(
        await evaluate(
          `!!document.elementFromPoint(${p.x},${p.y})?.closest(${JSON.stringify(selector)})`,
        ),
        "swipe must hit " + selector + " " + JSON.stringify(p),
      );
      await command("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: p.x, y: p.y }],
      });
      for (let step = 1; step <= 10; step++) {
        await command("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: horizontal ? p.x + ((p.to - p.x) * step) / 10 : p.x,
              y: horizontal ? p.y : p.y + ((p.to - p.y) * step) / 10,
            },
          ],
        });
        await sleep(20);
      }
      await sleep(180);
      await command("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      return Math.abs((horizontal ? p.x : p.y) - p.to);
    };
    const byText = async (
      text: string,
      within = ".workspace",
      tag = "button",
    ) => {
      const selector = await evaluate(
        `(()=>{const list=[...document.querySelector(${JSON.stringify(within)}).querySelectorAll(${JSON.stringify(tag)})].filter(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getClientRects().length);if(list.length!==1)throw Error('Ambiguous '+${JSON.stringify(text)}+': '+list.length);list[0].dataset.mobileTest='target';return '[data-mobile-test="target"]'})()`,
      );
      await tap(selector);
      await evaluate(
        `document.querySelectorAll('[data-mobile-test]').forEach(e=>delete e.dataset.mobileTest)`,
      );
    };
    const fill = async (selector: string, value: string) =>
      evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    const resize = async (width: number, height: number, mobile = true) => {
      await command("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
        screenWidth: width,
        screenHeight: height,
      });
      await command("Emulation.setTouchEmulationEnabled", {
        enabled: mobile,
        maxTouchPoints: 5,
      });
      await until(
        `Math.abs(document.querySelector('#app').getBoundingClientRect().height-${height})<2`,
        "visible viewport resize",
      );
    };
    const nav = async (label: string) => {
      if (await evaluate(`matchMedia('(max-width:760px)').matches`)) {
        await tap('[aria-label="打开导航与会话"]');
        await until(
          `document.querySelector('.sidebar').classList.contains('mobile-open')&&Math.abs(document.querySelector('.sidebar').getBoundingClientRect().left)<1`,
          "navigation drawer finishes opening",
        );
      }
      const target = await evaluate(
        `(()=>{const e=[...document.querySelector('nav').querySelectorAll('button')].find(e=>e.querySelector('.nav-icon + span')?.textContent===${JSON.stringify(label)});if(!e)throw Error('Missing navigation: '+document.body.innerText);e.dataset.mobileTest='nav';return '[data-mobile-test="nav"]'})()`,
      );
      await tap(target);
      await evaluate(
        `document.querySelectorAll('[data-mobile-test]').forEach(e=>delete e.dataset.mobileTest)`,
      );
      await until(
        `!document.querySelector('.workspace').inert&&(${JSON.stringify(label)}==='对话'?!!document.querySelector('.composer'):document.querySelector('.topbar h2')?.textContent.includes(${JSON.stringify(label === "账号" ? "账号与权限" : label)}))`,
      );
    };
    const layout = async (label: string) => {
      const problems = await evaluate(
        `(()=>{const bad=[];for(const e of document.querySelectorAll('.workspace,.page-scroll,.transcript,.browser-view,.experience-page,.login')){if(e.clientWidth&&e.scrollWidth>e.clientWidth+2)bad.push(e.className+': '+e.scrollWidth+' > '+e.clientWidth)}if(document.documentElement.scrollWidth>innerWidth+2)bad.push('root overflow');for(const e of document.querySelectorAll('input:not([type=checkbox]):not([hidden]),textarea,select')){if(e.getClientRects().length&&parseFloat(getComputedStyle(e).fontSize)<16&&matchMedia('(pointer:coarse)').matches)bad.push('small input '+e.outerHTML.slice(0,80))}return bad})()`,
      );
      if (problems.length) {
        problems.push(
          await evaluate(
            `JSON.stringify([...document.querySelectorAll('.workspace *')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().right>innerWidth+2).slice(0,8).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,80),width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})))`,
          ),
        );
      }
      if (await evaluate(`matchMedia('(pointer:coarse)').matches`)) {
        const small = await evaluate(
          `JSON.stringify([...document.querySelectorAll('button,summary')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.height<43.5}).map(e=>({text:e.textContent.trim().slice(0,30),height:e.getBoundingClientRect().height,minHeight:getComputedStyle(e).minHeight})))`,
        );
        assert.equal(small, "[]", label + " touch targets");
      }
      assert.deepEqual(problems, [], label);
    };
    const upload = async (selector: string, path: string) => {
      const { root } = await command("DOM.getDocument");
      const { nodeId } = await command("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
      assert(nodeId);
      await command("DOM.setFileInputFiles", { nodeId, files: [path] });
    };
    try {
      let endpoint = "";
      for (let i = 0; i < 100; i++) {
        try {
          const [p, path] = (
            await readFile(join(profile, "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split("\n");
          endpoint = `ws://127.0.0.1:${p}${path}`;
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
          pending = waiting.get(m.id);
        if (pending) {
          clearTimeout(pending.timer);
          waiting.delete(m.id);
          m.error
            ? pending.no(Error(JSON.stringify(m.error)))
            : pending.yes(m.result);
          return;
        }
        if (m.method === "Runtime.exceptionThrown")
          errors.push(
            m.params.exceptionDetails.text +
              ": " +
              m.params.exceptionDetails.exception?.description,
          );
        if (m.method === "Page.javascriptDialogOpening") {
          dialogs.push({ message: m.params.message, type: m.params.type });
          void command(
            "Page.handleJavaScriptDialog",
            { accept: acceptDialog },
            m.sessionId,
          ).catch((e) => errors.push(e.message));
        }
        if (m.method === "Fetch.requestPaused") {
          void (async () => {
            const { requestId, request } = m.params;
            let value: any,
              responseCode = 200;
            if (
              request.url === base + "/api/employee" &&
              request.method === "GET"
            ) {
              employeeLoads++;
              if (blockEmployee) {
                responseCode = 503;
                value = { message: "Employee is unavailable in this test" };
              }
            } else if (request.url.endsWith("/api/chrome/tabs"))
              value = {
                connected: true,
                browser: "fixture",
                tabs: Array.from({ length: 40 }, (_, index) => index + 1).map(
                  (n) => ({
                    tag: "tab-" + n,
                    title:
                      n % 2 ? "触屏标签" + n + "-" + "long".repeat(50) : "",
                    url:
                      "https://example.test/" +
                      n +
                      "?query=" +
                      "very-long-url-".repeat(200),
                    active: n === 1,
                    controllable: true,
                  }),
                ),
              };
            else if (request.url.endsWith("/api/chrome/live")) {
              const { tabTag } = JSON.parse(request.postData),
                ticket = String(++browserCapture);
              liveTickets.set(ticket, tabTag);
              value = { ticket };
            } else if (request.url.endsWith("/api/chrome/control")) {
              const input = JSON.parse(request.postData);
              remoteInputs.push(input);
              if (failRemote) {
                await command(
                  "Fetch.failRequest",
                  { requestId, errorReason: "ConnectionReset" },
                  m.sessionId,
                );
                return;
              }
              await sleep(80);
              value = {
                status: "executed",
                inputAttempted: true,
                tabTag: input.tabTag,
                title: input.tabTag,
                url:
                  input.action.action === "goto"
                    ? input.action.url
                    : "https://example.test/remote",
                capturedAt: Date.now(),
                snapshotId: "control-" + ++browserCapture,
                editable: true,
                image: {
                  url: base + "/api/blobs/mobile-shot",
                  width: 1568,
                  height: 6000,
                },
              };
            } else if (request.url.endsWith("/api/chrome/screenshot")) {
              const { tabTag } = JSON.parse(request.postData);
              value = {
                title: tabTag,
                url: "https://example.test/" + "long/".repeat(1000),
                capturedAt: Date.now(),
                snapshotId: tabTag + "-" + ++browserCapture,
                editable: false,
                image: {
                  url: base + "/api/blobs/mobile-shot",
                  width: 1568,
                  height: 6000,
                },
              };
            } else if (request.url.includes("/api/blobs/mobile-shot")) {
              await command(
                "Fetch.fulfillRequest",
                {
                  requestId,
                  responseCode: 200,
                  responseHeaders: [
                    { name: "Content-Type", value: "image/png" },
                  ],
                  body: png.toString("base64"),
                },
                m.sessionId,
              );
              return;
            } else if (request.url.endsWith("/api/providers/login")) {
              const body = JSON.parse(request.postData);
              value =
                body.action === "start"
                  ? {
                      state: "mobile-state-fixture",
                      url: "https://www.codebuddy.ai/login?state=mobile-state-fixture",
                    }
                  : { complete: loginComplete };
            } else if (request.url.endsWith("/api/providers/import")) {
              imports++;
              const { id, name } = JSON.parse(request.postData);
              value = {
                config: {
                  ...config,
                  provider: {
                    ...config.provider,
                    [id]: {
                      ...config.provider.fixture,
                      name,
                      preset: "codebuddy",
                    },
                  },
                },
              };
            }
            if (value !== undefined)
              await command(
                "Fetch.fulfillRequest",
                {
                  requestId,
                  responseCode,
                  responseHeaders: [
                    { name: "Content-Type", value: "application/json" },
                  ],
                  body: Buffer.from(JSON.stringify(value)).toString("base64"),
                },
                m.sessionId,
              );
            else
              await command(
                "Fetch.continueRequest",
                { requestId },
                m.sessionId,
              );
          })().catch((e) => errors.push(e.message));
        }
      });
      const { targetId } = await command(
        "Target.createTarget",
        { url: "about:blank" },
        "",
      );
      sessionId = (
        await command("Target.attachToTarget", { targetId, flatten: true }, "")
      ).sessionId;
      await command("Emulation.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        platform: "Android",
      });
      await command("Page.addScriptToEvaluateOnNewDocument", {
        source: `(()=>{window.__localClientAttempts=0;const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(url,protocols){const u=new URL(url);if(u.port==='47673')window.__localClientAttempts++;if(u.pathname==='/api/chrome/live'){u.protocol='ws:';u.host='127.0.0.1:${(mock.address() as any).port}';u.pathname='/browser-live';}super(u.href,protocols);}send(data){const u=new URL(this.url),value=JSON.parse(data);if(u.pathname==='/api/events'&&value.type==='request'&&(value.path.startsWith('/chrome/')||['/providers/login','/providers/import'].includes(value.path))){void fetch('/api'+value.path,{method:value.method||'GET',headers:value.data===undefined?{}:{'Content-Type':'application/json'},body:value.data===undefined?undefined:JSON.stringify(value.data)}).then(async response=>{this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'response',id:value.id,status:response.status,statusText:response.statusText,contentType:response.headers.get('content-type')||'',body:await response.text()})}));}).catch(error=>{this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'response',id:value.id,status:0,error:error.message})}));});return;}super.send(data);}};})()`,
      });
      await command("Runtime.enable");
      await command("Page.enable");
      await command("Fetch.enable", {
        patterns: [
          { urlPattern: base + "/api/employee" },
          { urlPattern: base + "/api/chrome/*" },
          { urlPattern: base + "/api/blobs/mobile-shot" },
          { urlPattern: base + "/api/providers/login" },
          { urlPattern: base + "/api/providers/import" },
        ],
      });
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/auth/me")).ok) break;
        } catch {}
        await sleep(50);
      }
      await command("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 568,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await command("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      await command("Page.navigate", { url: base });
      await until(`document.querySelector('#setup-token')`);
      await layout("320px signup");
      await fill("#setup-token", token);
      await fill("#username", "phone-admin");
      await fill("#password", "Phone-regression-password-2026");
      await tap(".login-card .primary");
      await until(`document.querySelector('.shell')`);
      await until(`document.querySelector('.message-fold')`);
      assert(
        (await evaluate(`document.querySelector('.message-text').textContent`)).length <
          1000,
        "long prompt starts folded",
      );
      await tap(".message-fold");
      assert(
        (await evaluate(`document.querySelector('.message-text').textContent`)).length >
          2000,
        "long prompt expands on demand",
      );
      await tap(".message-fold");
      assert.equal(
        await evaluate(`getComputedStyle(document.querySelector('.turn-process')).display`),
        "none",
        "completed turn starts folded",
      );
      assert.equal(
        await evaluate(`document.querySelector('.turn-fold > span:first-child').textContent`),
        "已处理 3s · 180 tokens · 平均输出 10 tok/s",
        "completed turn uses Nova duration and token summary",
      );
      await tap(".turn-fold");
      await until(`document.querySelector('.tool-step')`);
      assert(
        await evaluate(`[...document.querySelectorAll('.tool-steps-summary')].some(e => e.textContent.includes('读取文件 ×1'))`),
        "process segment summarizes actions instead of a generic step count",
      );
      await evaluate(`(()=>{const e=[...document.querySelectorAll('.tool-steps-summary')].find(e=>e.textContent.includes('读取文件 ×1'));e.dataset.mobileTest='process-summary';return !!e})()`);
      await tap('[data-mobile-test="process-summary"]');
      await tap(".tool-step summary");
      assert(
        await evaluate(`document.querySelector('.tool-step pre').textContent.includes('工具结果')`),
      );
      await tap(".turn-fold");
      await layout("folded conversation");
      assert.equal(
        employeeLoads,
        0,
        "opening ordinary chat must not load or depend on the employee board",
      );
      assert(
        !(await evaluate(
          `(document.querySelector('.topbar')||document.querySelector('.mobile-header')).textContent.includes('员工专属')`,
        )),
        "newer employee records must not become the default chat",
      );
      assert(
        !(await evaluate(
          `document.querySelector('.session-list').textContent.includes('员工专属')`,
        )),
      );
      blockEmployee = false;
      await fill(
        'textarea[aria-label="消息"]',
        "ordinary draft stays in its own conversation",
      );
      await t.test("chat drafts restore text and images across real mobile session switches", async () => {
        await upload(".composer input[type=file]", photo);
        await until(`document.querySelector('.attachments')?.innerText.includes('图片 1')`);
        await evaluate(`document.querySelector('.session-row.active').dataset.draftTest='original'`);
        await tap('.mobile-header [aria-label="新建会话"]');
        await until(`document.querySelector('textarea[aria-label="消息"]')?.value===''&&!document.querySelector('.attachments')`);
        await fill('textarea[aria-label="消息"]', "另一个会话的未发送草稿");
        await tap('[aria-label="打开导航与会话"]');
        await until(`document.querySelector('.sidebar').classList.contains('mobile-open')&&Math.abs(document.querySelector('.sidebar').getBoundingClientRect().left)<1`);
        await tap('[data-draft-test="original"] > button:first-child');
        await until(`document.querySelector('textarea[aria-label="消息"]')?.value==='ordinary draft stays in its own conversation'`);
        await until(`!document.querySelector('.workspace').inert&&document.querySelector('.sidebar').getBoundingClientRect().right<=1`);
        assert(await evaluate(`document.querySelector('.attachments')?.innerText.includes('图片 1')`), "switching sessions must restore both text and images");
        assert.equal(requests.length, 0, "switching must not submit any draft");
        await tap(".attachments button");
      });
      await nav("数字员工");
      await until(
        `document.querySelector('.task-card')?.textContent.includes('seeded employee task')`,
      );
      await byText("主会话 ↗", ".task-card");
      await until(
        `document.querySelector('.employee-session')?.textContent.includes('employee-only work record')`,
      );
      assert.equal(
        await evaluate(`!!document.querySelector('.composer')`),
        false,
        "employee record must not expose ordinary sending/stop/Stage controls",
      );
      await byText("← 返回数字员工");
      await until(`document.querySelector('.task-card')`);
      await byText("Chrome 会话 ↗", ".task-card");
      await until(
        `document.querySelector('.employee-session')?.textContent.includes('employee-only browser record')`,
      );
      await nav("对话");
      assert.equal(
        await evaluate(
          `document.querySelector('textarea[aria-label="消息"]').value`,
        ),
        "ordinary draft stays in its own conversation",
      );
      await nav("数字员工");
      await until(`document.querySelector('.task-card')`);
      acceptDialog = true;
      await byText("删除记录", ".task-card");
      await until(`!document.querySelector('.task-card')`);
      acceptDialog = false;
      await nav("对话");
      await fill('textarea[aria-label="消息"]', "");
      await layout("initial chat");
      assert.equal(await evaluate("getComputedStyle(document.documentElement).touchAction"), "pan-x pan-y", "the mobile viewport permits scrolling, not browser gesture zoom");
      const pinchPoint = await evaluate(`(()=>{const r=document.querySelector('.transcript').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      await command("Input.synthesizePinchGesture", { ...pinchPoint, scaleFactor: 1.6, relativeSpeed: 800, gestureSourceType: "touch" });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      assert.equal(await evaluate("visualViewport.scale"), 1, "touch gestures must not zoom the entire application");
      await command("Input.synthesizeTapGesture", { ...pinchPoint, tapCount: 2, gestureSourceType: "touch" });
      assert.equal(await evaluate("visualViewport.scale"), 1, "double taps must not zoom the entire application");
      assert(await evaluate(`!/(?:user-scalable\\s*=\\s*no|maximum-scale\\s*=)/i.test(document.querySelector('meta[name=viewport]').content)`), "browser accessibility zoom must remain available");
      await layout("fixed mobile viewport after gestures");
      await until(`document.querySelector('.message.assistant .markdown-table th')?.textContent==='项目'`);
      assert.equal(await evaluate(`document.querySelectorAll('.markdown-table tbody td').length`), 6);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.markdown-table th:nth-child(2)')).textAlign`), "center");
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.markdown-table th:nth-child(3)')).textAlign`), "right");
      assert(await evaluate(`(()=>{const e=document.querySelector('.markdown-table');e.scrollLeft=40;return e.scrollWidth>e.clientWidth&&e.scrollLeft>0})()`), "wide markdown tables scroll independently on mobile");
      await evaluate(`document.querySelector('.markdown-body img[alt="Markdown 图片"]').scrollIntoView({block:'center'})`);
      await until(`document.querySelector('.markdown-body img[alt="Markdown 图片"]')?.naturalWidth===1568`);
      assert(await evaluate(`(()=>{const e=document.querySelector('.markdown-body img[alt="Markdown 图片"]'),r=e.getBoundingClientRect();return e.complete&&r.width>0&&r.width<=e.parentElement.clientWidth+1&&Math.abs(r.height/r.width-6000/1568)<0.01})()`), "authenticated Markdown images load and fit the mobile bubble without distortion");
      assert.equal(await evaluate(`document.querySelector('.markdown-body img[alt="Markdown 图片"]').referrerPolicy`), "no-referrer");
      assert.equal(await evaluate(`document.querySelector('.execution-switch').getAttribute('aria-checked')`), "false", "offline new sessions default to the server");
      assert.equal(await evaluate(`document.querySelector('.execution-switch').disabled`), true, "an offline client cannot be selected");
      assert.equal(await evaluate("window.__localClientAttempts"), 0, "mobile pages must not try their loopback client");
      const remoteLoginResponse = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "phone-admin", password: "Phone-regression-password-2026" }) });
      const remoteLogin = await remoteLoginResponse.json(), remoteCookie = remoteLoginResponse.headers.get("set-cookie")!.split(";")[0];
      const remoteApi = async (path: string, body: any) => {
        const response = await fetch(base + "/api" + path, { method: "POST", headers: { cookie: remoteCookie, "x-csrf-token": remoteLogin.csrfToken, "content-type": "application/json" }, body: JSON.stringify(body) });
        const value = await response.json();
        assert.equal(response.ok, true, JSON.stringify(value));
        return value;
      };
      const office = { clientId: "d".repeat(32), instance: "a".repeat(32), name: "Office PC", cwd: "C:\\office", platform: "windows" };
      const home = { clientId: "e".repeat(32), instance: "b".repeat(32), name: "Home PC", cwd: "/home/project", platform: "linux" };
      const nativePeers: WebSocket[] = [];
      const connectNative = async (details: any) => {
        const { ticket } = await remoteApi("/local-agent/ticket", { instance: details.instance });
        const { deviceToken } = await remoteApi("/local-agent/verify", { ticket, clientId: details.clientId });
        const native = new WebSocket(base.replace("http:", "ws:") + "/api/local-agent/socket", { headers: { authorization: "Bearer " + deviceToken } });
        nativePeers.push(native);
        await new Promise<void>((yes, no) => {
          native.once("error", no);
          native.once("open", () => native.send(JSON.stringify({ type: "hello", ...details })));
          native.on("message", (raw) => {
            const value = JSON.parse(raw.toString());
            if (value.type === "ready") yes();
            else if (value.op) native.send(JSON.stringify({ type: "result", id: value.id, result: { isDir: true, path: value.args.path } }));
          });
        });
        return native;
      };
      try {
        const officeSocket = await connectNative(office);
        const homeSocket = await connectNative(home);
        await until(`document.querySelector('.execution-switch')?.disabled===false`);
        assert.equal(await evaluate(`document.querySelector('.execution-switch').getAttribute('aria-checked')`), "false", "remote clients coming online must not migrate a server conversation");
        await tap(".execution-switch");
        await until(`document.querySelector('.execution-client')?.value===${JSON.stringify(office.clientId)}`);
        await fill('[aria-label="执行客户端"]', home.clientId);
        await until(`document.querySelector('.chat-topbar p')?.textContent.includes('/home/project')||document.querySelector('.notice')?.textContent.includes('/home/project')`);
        assert.equal(await evaluate(`document.querySelector('.execution-client').value`), home.clientId);
        await layout("mobile remote client selection");
        homeSocket.terminate();
        await until(`document.querySelector('.execution-warning')?.textContent.includes('已离线')`);
        assert.equal(await evaluate(`document.querySelector('.execution-client').value`), home.clientId);
        assert.equal(await evaluate(`document.querySelector('.composer .primary').disabled`), true, "offline selected client must not use another online computer");
        await tap(".execution-switch");
        await until(`document.querySelector('.execution-switch').getAttribute('aria-checked')==='false'`);
        officeSocket.terminate();
        await until(`document.querySelector('.execution-switch').disabled`);
        assert.equal(await evaluate("window.__localClientAttempts"), 0);
      } finally { for (const native of nativePeers) native.terminate(); }
      await tap('[aria-label="打开导航与会话"]');
      assert.equal(
        await evaluate(`document.querySelector('.workspace').inert`),
        true,
      );
      assert(
        await evaluate(
          `document.querySelector('.session-list').getClientRects().length>0&&document.querySelector('.sidebar footer button').getClientRects().length>0`,
        ),
      );
      await evaluate(
        `document.querySelector('.sidebar footer button').focus()`,
      );
      await command("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      assert.equal(
        await evaluate(`document.activeElement.getAttribute('aria-label')`),
        "关闭导航",
      );
      await command("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await until(`!document.querySelector('.workspace').inert`);
      await tap('[aria-label="打开导航与会话"]');
      await tap(".navigation-backdrop");
      await until(`!document.querySelector('.workspace').inert`);
      for (const [width, height] of [
        [320, 568],
        [360, 800],
        [390, 844],
        [430, 932],
        [768, 1024],
        [1024, 768],
        [844, 390],
      ]) {
        await resize(width, height);
        for (const page of [
          "对话",
          "数字员工",
          "浏览器",
          "经验图谱",
          "账号",
          "设置",
        ]) {
          await nav(page);
          await layout(width + "x" + height + " " + page);
          await evaluate(
            `document.querySelector('.page-scroll,.experience-page,.browser-view')?.scrollTo(0,100000)`,
          );
          await layout("bottom " + width + " " + page);
        }
      }
      await resize(360, 800);
      await nav("设置");
      await until(`document.querySelector('.provider-form')`);
      const advanced = await evaluate(
        `(()=>{const e=document.querySelector('.provider-form details');e.open=true;return !!e})()`,
      );
      assert(advanced);
      assert.equal(
        await evaluate(
          `[...document.querySelectorAll('.settings h3')].some(e=>e.textContent.includes('图片服务'))`,
        ),
        false,
      );
      await layout("advanced provider parameters");
      await byText("保存服务商");
      await until(
        `[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('服务商已保存'))`,
      );
      await tap(".scene-item:last-child > button");
      await fill(
        ".scene-item:last-child .scene-row:last-of-type select",
        "fixture/phone-model/variant/low",
      );
      await tap(
        ".scene-item:last-child .scene-row:last-of-type button:first-of-type",
      );
      assert.equal(
        await evaluate(
          `document.querySelector('.scene-item:last-child .scene-row select').value`,
        ),
        "fixture/phone-model/variant/low",
      );
      await byText("保存场景");
      await until(
        `[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('场景模型已保存'))`,
      );
      await upload('input[type=file][accept=".zip"]', skill);
      await byText("上传技能");
      await until(`document.body.innerText.includes('mobile-upload')`);
      await layout("uploaded skill");
      await byText("移除", ".skill-items");
      assert.equal(dialogs.at(-1)?.message, "移除这个技能？");
      assert(
        await evaluate(
          `document.querySelector('.skill-items').innerText.includes('mobile-upload')`,
        ),
        "cancelling must retain the skill",
      );
      await nav("数字员工");
      await fill(
        'input[placeholder="交给员工：一件有明确目标的事"]',
        "手机提交的独立任务",
      );
      await byText("交给员工");
      await until(
        `document.querySelector('.task-card')?.textContent.includes('手机提交的独立任务')`,
      );
      await byText("重新派发", ".task-card");
      assert(
        dialogs.at(-1)?.message.includes("重新派发"),
        "Vapor template must call the real confirmation dialog",
      );
      assert.equal(
        await evaluate(`document.querySelectorAll('.task-card').length`),
        1,
        "cancel must not redispatch",
      );
      acceptDialog = true;
      await byText("重新派发", ".task-card");
      await until(
        `document.querySelectorAll('.task-card').length===2`,
        "confirmed redispatch",
      );
      acceptDialog = false;
      await byText("职责", ".tabs");
      await evaluate(
        `(()=>{const e=[...document.querySelectorAll('.workspace button')].find(e=>e.textContent.includes('职责')&&!e.closest('.tabs'));if(!e)throw Error('Missing duty action');e.dataset.mobileTest='duty'})()`,
      );
      await tap('[data-mobile-test="duty"]');
      await until(`document.querySelector('form textarea')`);
      await layout("duty form");
      await byText("长期记忆", ".tabs");
      assert.equal(
        await evaluate(`document.querySelector('.tabs').textContent.includes('密码本')`),
        false,
        "vault management belongs in settings, not employee tabs",
      );
      assert.equal(
        await evaluate(`document.querySelector('.tabs').textContent.includes('团队员工')`),
        false,
      );
      await nav("设置");
      await until(`[...document.querySelectorAll('.settings h3')].some(e=>e.textContent==='密码本')`);
      await layout("vault settings");
      await nav("浏览器");
      await until(
        `document.querySelector('.browser-image img')?.naturalWidth===1568`,
      );
      await tap(".browser-tabstrip button:nth-child(4)");
      await until(
        `document.querySelector('.browser-address strong')?.textContent==='tab-4'`,
      );
      assert.equal(
        await evaluate(
          `document.querySelector('.browser-address a').getAttribute('target')`,
        ),
        "_blank",
      );
      await layout("browser screenshot on phone");
      for (const [width, height] of [
        [320, 568],
        [640, 800],
        [768, 1024],
        [844, 390],
      ]) {
        await resize(width, height);
        await evaluate(
          `document.querySelector('.browser-view').scrollTop=0;document.querySelector('.browser-tabstrip').scrollLeft=0`,
        );
        assert(
          await evaluate(
            `document.querySelector('.browser-address').getBoundingClientRect().height<190`,
          ),
          "the full URL must not fill the viewport",
        );
        assert.equal(
          await evaluate(`document.querySelector('.browser-url').open`),
          false,
        );
        assert(
          await evaluate(
            `document.querySelector('.browser-image img').getBoundingClientRect().top<innerHeight-40`,
          ),
          "screenshot must be visible before scrolling at " + width + "x" + height + " " +
            await evaluate(`JSON.stringify([...document.querySelectorAll('.topbar,.browser-tabstrip,.browser-address,.remote-controls,.browser-capture figcaption,.browser-image')].map(e=>({class:e.className,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height})))`),
        );
        assert(
          await evaluate(
            `document.querySelector('.browser-tabstrip').getBoundingClientRect().height<72`,
          ),
          "tabs must stay in one horizontal row",
        );
        const beforePan = await evaluate(`document.querySelector('.browser-image img').style.transform`);
        await swipe(".browser-image");
        assert.notEqual(await evaluate(`document.querySelector('.browser-image img').style.transform`), beforePan, "one-finger gestures pan the preview at " + width);
        assert.equal(await evaluate("visualViewport.scale"), 1, "preview gestures must not resize the app");
        await byText("还原视图 · 100%", ".browser-address");
        await evaluate(`document.querySelector('.browser-view').scrollTop=0`);
        await swipe(".browser-tabstrip", true);
        await until(
          `document.querySelector('.browser-tabstrip').scrollLeft>100`,
          "native touch tabstrip swipe at " +
            width +
            " " +
            (await evaluate(
              `JSON.stringify((()=>{const t=document.querySelector('.browser-tabstrip'),r=t.getBoundingClientRect();return {left:t.scrollLeft,width:t.clientWidth,scroll:t.scrollWidth,top:r.top,height:r.height,pageTop:document.querySelector('.browser-view').scrollTop,viewport:innerHeight,hit:document.elementFromPoint(innerWidth-34,r.y+r.height/2)?.outerHTML.slice(0,180),touch:getComputedStyle(t).touchAction}})())`,
            )),
        );
        await layout("scrolled browser " + width);
      }
      await resize(360, 800);
      await tap(".browser-url summary");
      assert(await evaluate(`document.querySelector('.browser-url').open`));
      assert(
        await evaluate(
          `document.querySelector('.browser-url p').clientHeight<=96`,
        ),
      );
      await tap(".browser-url summary");
      await until(
        `[...document.querySelectorAll('.browser-address .pill')].some(e=>e.textContent.trim()==="查看中")&&document.querySelector('.browser-image img')?.naturalWidth===1568`,
      );
      await tap(".browser-image");
      assert.equal(remoteInputs.length, 0, "viewing the preview must not operate the website");
      await byText("开始操作", ".browser-address");
      await until(`document.querySelector('.browser-address button')?.textContent.trim()==='退出操作'`);
      await tap(".browser-image");
      await until(
        `document.querySelector('.remote-controls')&&document.querySelector('.browser-image img')?.naturalWidth===1568`,
      );
      for (
        let i = 0;
        i < 100 &&
        !remoteInputs.some((input) => input.action.action === "click_at");
        i++
      )
        await sleep(20);
      assert.equal(remoteInputs.at(-1).action.action, "click_at");
      assert(
        Math.abs(remoteInputs.at(-1).action.x - 784) <= 2 &&
          Math.abs(remoteInputs.at(-1).action.y - 3000) <= 4,
        "displayed screenshot coordinates must map to its original image pixels: " + JSON.stringify(remoteInputs.at(-1)),
      );
      assert.equal(await evaluate(`document.querySelector('.remote-input').open`), false);
      await tap('textarea[aria-label="远程输入文字"]');
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), "远程输入文字");
      await fill('textarea[aria-label="远程输入文字"]', "远程输入：你好");
      await byText("发送文字", ".remote-text");
      await until(
        `document.querySelector('[aria-label="远程按键 回车"]')?.disabled===false`,
      );
      assert(
        remoteInputs.some(
          (input) =>
            input.action.action === "type" &&
            input.action.text === "远程输入：你好",
        ),
      );
      await tap('[aria-label="远程按键 回车"]');
      await until(
        `document.querySelector('[aria-label="远程按键 回车"]')?.disabled===false`,
      );
      assert(
        remoteInputs.some(
          (input) =>
            input.action.action === "press" && input.action.key === "Enter",
        ),
      );
      await byText("网页下滚", ".remote-toolbar");
      await until(
        `document.querySelector('.browser-image img')?.naturalWidth===1568&&document.querySelector('.remote-toolbar button')?.disabled===false`,
      );
      assert(
        remoteInputs.some(
          (input) =>
            input.action.action === "scroll_at" && input.action.delta === 600,
        ),
      );
      await tap(".remote-input summary");
      await fill(
        'input[aria-label="远程网页地址"]',
        "https://example.test/new",
      );
      await byText("前往", ".remote-url");
      await until(
        `document.querySelector('.browser-url').textContent.includes('/new')`,
      );
      assert.equal(remoteInputs.at(-1).action.action, "goto");
      await tap(".remote-input summary");
      await dragMouse(".browser-image");
      for (
        let i = 0;
        i < 150 && !remoteInputs.some((input) => input.action.phase === "up");
        i++
      )
        await sleep(20);
      assert.equal(remoteInputs.at(-1).action.action, "pointer");
      assert.equal(remoteInputs.at(-1).action.phase, "up");
      const moves = remoteInputs.filter(
        (input) => input.action.action === "pointer",
      );
      assert(moves.some((input) => input.action.phase === "down"));
      assert(moves.some((input) => input.action.phase === "move"));
      assert(moves.at(-1).action.x < moves[0].action.x);
      await layout("remote browser controls");
      await until(
        `[...document.querySelectorAll('.browser-address .pill')].every(e=>e.textContent.trim()!=="同步中…")`,
      );
      const wheelPoint = await evaluate(
        `(()=>{const e=document.querySelector('.browser-image img');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:Math.max(20,Math.min(innerHeight-20,r.y+r.height/2))}})()`,
      );
      const beforeWheel = remoteInputs.length;
      await command("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...wheelPoint,
        deltaX: 0,
        deltaY: 320,
      });
      await command("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...wheelPoint,
        deltaX: 0,
        deltaY: 320,
      });
      await until(
        `document.querySelector('.browser-image img')?.naturalWidth===1568&&document.querySelector('.remote-toolbar button')?.disabled===false`,
      );
      assert.equal(
        remoteInputs.length,
        beforeWheel + 1,
        "wheel events must not queue repeated inputs against a consumed screenshot",
      );
      assert.equal(remoteInputs.at(-1).action.action, "scroll_at");
      assert.equal(remoteInputs.at(-1).action.delta, 320);
      failRemote = true;
      const sentBefore = remoteInputs.length;
      await tap('[aria-label="远程按键 回车"]');
      await until(
        `document.querySelector('.browser-view [role=alert]')?.textContent.includes('不要重复提交')`,
      );
      assert.equal(
        remoteInputs.length,
        sentBefore + 1,
        "unconfirmed delivery must not retry",
      );
      assert.equal(
        await evaluate(
          `document.querySelector('.browser-image')?.getAttribute('tabindex')`,
        ),
        "-1",
      );
      failRemote = false;
      await nav("对话");
      await tap('.mobile-header [aria-label="新建会话"]');
      await until(`!document.querySelector('.message-text')`);
      await fill('textarea[aria-label="消息"]', "手机多行\n输入");
      assert.equal(
        await evaluate(
          `(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});document.querySelector('[aria-label="消息"]').dispatchEvent(e);return e.defaultPrevented})()`,
        ),
        false,
      );
      assert.equal(requests.length, 0);
      await upload(".composer input[type=file]", photo);
      await until(
        `document.querySelector('.attachments')?.innerText.includes('图片 1')`,
      );
      await tap(".composer .primary");
      await until(`document.body.innerText.includes('移动端回归回复')`);
      assert.equal(requests.length, 1);
      assert(
        requests[0].messages.some((m: any) =>
          JSON.stringify(m.content).includes("手机多行"),
        ),
      );
      assert(
        requests[0].messages.some((m: any) =>
          JSON.stringify(m.content).includes("data:image/png;base64,"),
        ),
      );
      await fill('textarea[aria-label="消息"]', "键盘缩小后的草稿");
      await evaluate(
        `document.querySelector('textarea[aria-label="消息"]').focus()`,
      );
      await resize(360, 340);
      await layout("keyboard-reduced viewport");
      assert(
        await evaluate(
          `(()=>{const r=document.querySelector('.composer .primary').getBoundingClientRect();return r.bottom<=visualViewport.height+visualViewport.offsetTop+1&&r.height>=44&&r.top>=0})()`,
        ),
      );
      assert.equal(
        await evaluate(`document.querySelector('[aria-label="消息"]').value`),
        "键盘缩小后的草稿",
      );
      await resize(390, 844);
      await nav("设置");
      await byText("＋ 添加服务商");
      await fill(".provider-form select", "codebuddy");
      await evaluate(`window.open=()=>null`);
      await byText("登录 CodeBuddy（本地 API）");
      await until(`document.querySelector('.login-progress a')`);
      assert(
        await evaluate(
          `Object.keys(sessionStorage).some(k=>k.startsWith('vega:provider-login:'))`,
        ),
      );
      await nav("对话");
      await command("Page.reload");
      await until(
        `document.querySelector('.login-progress a')`,
        "resume login after mobile tab reload",
      );
      loginComplete = true;
      await nav("设置");
      await until(`document.body.innerText.includes('登录成功，模型已就绪')`);
      assert.equal(imports, 1);
      assert.equal(
        await evaluate(
          `Object.keys(sessionStorage).some(k=>k.startsWith('vega:provider-login:'))`,
        ),
        false,
      );
      await nav("对话");
      await resize(1440, 900, false);
      await until(
        `getComputedStyle(document.querySelector('.mobile-header')).display==='none'`,
      );
      assert.equal(
        await evaluate(
          `getComputedStyle(document.querySelector('.sidebar')).display`,
        ),
        "flex",
      );
      await fill('textarea[aria-label="消息"]', "desktop IME");
      assert.equal(
        await evaluate(
          `(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});document.querySelector('[aria-label="消息"]').dispatchEvent(e);return e.defaultPrevented})()`,
        ),
        false,
      );
      assert.equal(requests.length, 1);
      assert.equal(
        await evaluate(
          `(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});document.querySelector('[aria-label="消息"]').dispatchEvent(e);return e.defaultPrevented})()`,
        ),
        true,
      );
      await until(
        `document.querySelectorAll('.message.assistant .markdown').length===2`,
      );
      for (let i = 0; i < 40 && requests.length < 2; i++) await sleep(50);
      assert.equal(requests.length, 2);
      for (const [width, height] of [[320, 568], [1440, 900]]) {
        await resize(width, height, width < 760);
        const bubble = await evaluate(`(()=>{const e=[...document.querySelectorAll('.message.user')].at(-1),text=e.querySelector('.message-text'),r=document.createRange();r.selectNodeContents(text);return{text:text.textContent,width:e.getBoundingClientRect().width,contentWidth:r.getBoundingClientRect().width,rightGap:Math.abs(e.getBoundingClientRect().right-e.parentElement.getBoundingClientRect().right)}})()`);
        assert.equal(bubble.text, "desktop IME");
        assert(bubble.width <= bubble.contentWidth + 34, "short user bubbles fit their contents at " + width + "px: " + JSON.stringify(bubble));
        assert(bubble.rightGap < 1, "user bubbles remain right-aligned");
        await layout("compact user bubble at " + width);
      }
      assert.equal(
        await evaluate(`document.querySelectorAll('.mobile-stage,.chat-topbar button:not(.topbar-new)').length`),
        0,
        "Stage is created by command, not a separate add button",
      );
      const sessionCount = await evaluate(
        `document.querySelectorAll('.session-row').length`,
      );
      await fill('textarea[aria-label="消息"]', "/stage 复核当前方案");
      await evaluate(
        `document.querySelector('[aria-label="消息"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
      );
      await until(`document.querySelector('.stage-switch')?.value!==document.querySelector('.stage-switch option')?.value`);
      assert.equal(
        await evaluate(`document.querySelectorAll('.session-row').length`),
        sessionCount,
        "Stage stays inside its source conversation",
      );
      await evaluate(
        `(()=>{const e=document.querySelector('.stage-switch');e.value=e.options[0].value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      );
      await until(`document.querySelector('.stage-switch').value===document.querySelector('.stage-switch option').value`);
      await layout("desktop remains usable");
      await resize(320, 568);
      await tap('[aria-label="打开导航与会话"]');
      await until(`document.querySelector('.sidebar').classList.contains('mobile-open')&&Math.abs(document.querySelector('.sidebar').getBoundingClientRect().left)<1`);
      await tap('.sidebar [aria-label="退出登录"]');
      await until(`document.querySelector('.login-card')`);
      await fill("#username", "phone-admin");
      await fill("#password", "Phone-regression-password-2026");
      await tap(".login-card .primary");
      await until(`document.querySelector('.shell')`);
      await layout("mobile login again");
      assert.deepEqual(errors, [], "runtime errors");
    } finally {
      if (ws?.readyState === WebSocket.OPEN)
        await command("Browser.close", {}, "").catch(() => {});
      ws?.terminate();
      for (const p of waiting.values()) {
        clearTimeout(p.timer);
        p.no(Error("test closed"));
      }
      waiting.clear();
      browser.kill();
      server.kill();
      for (const socket of liveServer.clients) socket.terminate();
      await new Promise<void>((yes) => liveServer.close(() => yes()));
      await new Promise<void>((yes) => mock.close(() => yes()));
      await sleep(300);
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  },
);
