import sharp from "sharp";
import { randomBytes } from "node:crypto";
import type { Peer } from "crossws";
import type { Auth, Principal } from "./auth";
import type { Chrome } from "./chrome";
import { browserTarget, remoteKeys } from "./browser-preview";
import { normalizeAction } from "./browser-actions";
import { assert, httpURL, Mutex, sleep, type Obj } from "./util";

type Socket = Pick<Peer, "id" | "send" | "close" | "request">;
type Ticket = { hash: string; tabTag: string; until: number };
type Frame = {
  id: number;
  at: number;
  width: number;
  height: number;
  state: Obj;
  observation: Awaited<ReturnType<Chrome["observe"]>>;
};
const stateExpression =
  "({stamp:__novaWebview.stamp(),viewport:JSON.stringify([visualViewport?.scale,visualViewport?.offsetLeft,visualViewport?.offsetTop]),focus:__novaWebview.inputState(),width:innerWidth,height:innerHeight,url:location.href,title:document.title})";

// shortcut: JPEG snapshot stream (at most 10 fps); use screencast/WebRTC for video-grade motion.
// Frames are ephemeral and acknowledged one at a time; video must never fill SQLite or an input queue.
// An unchanged screen is sent as a tiny "same" frame (fresh state, no image), and a page that has been still
// for a while with no input is sampled at 2 fps instead of 10.
const ACTIVE_MS = 100, IDLE_MS = 500, IDLE_AFTER = 2000;
export class BrowserLive {
  tickets = new Map<string, Ticket>();
  sessions = new Map<string, LiveSession>();
  controllers = new Map<string, LiveSession>();
  controllerOf(tag: string) {
    return this.controllers.get(tag);
  }
  constructor(
    public chrome: Chrome,
    public auth: Auth,
    public canUse: (principal: Principal) => boolean | Promise<boolean> = (principal) => principal.user.role === "admin",
  ) {
    auth.events.on("logout", this.logout);
    auth.events.on("revoke", this.revoke);
  }
  private logout = (hash: string) => {
    for (const s of this.sessions.values())
      if (s.principal.hash === hash) void s.close(4401, "登录已失效");
  };
  private revoke = (userId: string) => {
    for (const s of this.sessions.values())
      if (s.principal.user.id === userId) void s.close(4401, "账号权限已变化");
  };
  async ticket(principal: Principal, tabTag: unknown) {
    assert(
      !!await this.auth.resolveHash(principal.hash) && await this.canUse((await this.auth.resolveHash(principal.hash))!),
      "无权查看和操作此浏览器",
    );
    const tab = await this.chrome
      .tabGate(String(tabTag))
      .run(() => browserTarget(this.chrome, tabTag));
    for (const [id, t] of this.tickets)
      if (t.until < Date.now()) this.tickets.delete(id);
    assert(this.tickets.size < 64, "实时浏览器连接过多");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, {
      hash: principal.hash,
      tabTag: tab.tag,
      until: Date.now() + 15000,
    });
    return { ticket };
  }
  async authorize(request: Socket["request"], consume = false) {
    const url = new URL(request.url),
      origin = process.env.VEGA_PUBLIC_URL
        ? new URL(process.env.VEGA_PUBLIC_URL).origin
        : url.origin;
    assert(
      request.headers.get("origin") === origin &&
        !["cross-site", "same-site"].includes(
          request.headers.get("sec-fetch-site") || "",
        ),
      "不允许跨站连接",
    );
    const token = (request.headers.get("cookie") || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("vega_session="))
      ?.slice("vega_session=".length);
    const principal = await this.auth.authenticate(token),
      id = url.searchParams.get("ticket") || "",
      ticket = this.tickets.get(id);
    assert(
      principal && (await this.canUse(principal)) &&
        ticket &&
        ticket.hash === principal.hash &&
        ticket.until >= Date.now(),
      "连接已过期，请重新连接浏览器",
    );
    if (consume) this.tickets.delete(id);
    return { principal, ticket };
  }
  async open(socket: Socket) {
    const { principal, ticket } = await this.authorize(socket.request, true);
    assert(this.sessions.size < 4, "实时浏览器连接过多");
    for (const session of this.sessions.values())
      if (session.principal.hash === principal.hash)
        void session.close(1000, "已在新窗口连接");
    const session = new LiveSession(this, socket, principal, ticket.tabTag);
    this.sessions.set(socket.id, session);
    void session.run();
  }
  async message(socket: Socket, raw: string) {
    const session = this.sessions.get(socket.id);
    if (!session) return;
    // Messages are handled one at a time in arrival order, even though each check awaits storage.
    const handle = async () => {
      try {
        assert(Buffer.byteLength(raw) <= 65536, "消息过大");
        await session.message(JSON.parse(raw));
      } catch {
        void session.close(4400, "实时操作消息无效，请重新连接");
      }
    };
    await (session.inbox = session.inbox.then(handle));
  }
  async close() {
    this.auth.events.off("logout", this.logout);
    this.auth.events.off("revoke", this.revoke);
    this.tickets.clear();
    await Promise.all(
      [...this.sessions.values()].map((s) => s.close(1001, "服务停止")),
    );
  }
}
class LiveSession {
  active = true;
  locked = false;
  wantsControl = false;
  stopping = false;
  claimTask?: Promise<void>;
  inbox = Promise.resolve();
  release?: () => void;
  io = new Mutex();
  observation?: Awaited<ReturnType<Chrome["observe"]>>;
  presented?: Frame;
  acknowledged = new Map<number, Frame>();
  pendingFrame?: Frame;
  frameNumber = 0;
  sequence = 0;
  completedInput = 0;
  pointerPending?: Obj;
  pointerTask = false;
  pointerReleasing = false;
  inputPending = false;
  lastMessage = Date.now();
  lastInput = Date.now();
  lastChange = Date.now();
  lastCapture = -Infinity;
  lastShot = "";
  lastSize?: { width: number; height: number };
  mouse?: { x: number; y: number; button: string; frame: Frame; seq: number };
  constructor(
    public hub: BrowserLive,
    public socket: Socket,
    public principal: Principal,
    public tabTag: string,
  ) {}
  send(value: Obj) {
    if (this.active) this.socket.send(JSON.stringify(value));
  }
  async valid() {
    return (
      this.active &&
      !!await this.hub.auth.resolveHash(this.principal.hash) &&
      await this.hub.canUse((await this.hub.auth.resolveHash(this.principal.hash))!)
    );
  }
  async run() {
    try {
      this.send({ type: "ready", tabTag: this.tabTag, mode: "view" });
      let captureFailedAt = 0;
      while (this.active) {
        assert(await this.valid(), "登录已失效");
        assert(Date.now() - this.lastMessage < 20000, "连接已中断，请重新连接");
        if (this.wantsControl && Date.now() - this.lastInput > 30000)
          this.releaseControl("闲置已退出远程操作");
        if (this.pendingFrame) {
          assert(
            Date.now() - this.pendingFrame.at < 10000,
            "画面传输超时，请重新连接",
          );
        } else if (!this.stopping && (!this.wantsControl || this.locked) && performance.now() - this.lastCapture >= this.interval()) {
          const capture = () => this.io.run(async () => {
            if (this.inputPending || this.pointerTask) return;
            this.lastCapture = performance.now(); // monotonic: pacing must not depend on wall-clock jumps
            try {
              await this.capture();
              captureFailedAt = 0;
            } catch (e: any) {
              // Navigation may destroy the context or surface; retry only these read-only captures.
              if (!/Cannot find (?:context with specified id|default execution context)|Execution context was destroyed|Inspected target navigated or closed|No frame for given id found|Unable to capture screenshot|Page not ready/i.test(e.message))
                throw e;
              captureFailedAt ||= Date.now();
              if (Date.now() - captureFailedAt >= 5000) throw e;
              this.observation = undefined;
            }
          });
          if (this.locked) await capture();
          else
            await this.hub.chrome.tabGate(this.tabTag).run(async () => {
              if (this.active && !this.wantsControl) await capture();
            });
        }
        await sleep(ACTIVE_MS);
      }
    } catch (e: any) {
      this.send({ type: "error", reason: e.message });
      await this.close(1011, "实时浏览器连接已停止");
    }
  }
  interval() {
    const now = Date.now();
    return now - this.lastChange > IDLE_AFTER && now - this.lastInput > IDLE_AFTER ? IDLE_MS : ACTIVE_MS;
  }
  async pageState() {
    const chrome = this.hub.chrome;
    if (!this.observation)
      this.observation = await chrome.observe(this.tabTag, "viewport");
    const o = this.observation;
    try {
      const state = await chrome.evaluate(
        this.tabTag,
        o.frames[0],
        stateExpression,
      );
      assert(
        /^(https?:\/\/|about:blank$)/i.test(state.url),
        "此页面不能远程控制",
      );
      state.document = o.pages[0].document;
      if (!state.focus.editable)
        for (let i = 1; i < o.frames.length; i++) {
          if (await chrome.frameFocused(o, i)) {
            const focus = await chrome.evaluate(
              this.tabTag,
              o.frames[i],
              "__novaWebview.inputState()",
            );
            if (focus.editable) {
              state.focus = { ...focus, frame: i };
              break;
            }
          }
        }
      return state as Obj;
    } catch (error) {
      this.observation = undefined;
      throw error;
    }
  }
  async capture() {
    if (!this.active || this.stopping) return;
    const chrome = this.hub.chrome;
    await browserTarget(chrome, this.tabTag);
    const before = await this.pageState();
    const shot = await chrome.cdp(this.tabTag, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const after = await this.pageState();
    if (before.stamp !== after.stamp || before.document !== after.document)
      return;
    // Identical capture bytes mean an identical picture: skip the re-encode and the image payload.
    const same = shot.data === this.lastShot && !!this.lastSize;
    let data: Buffer | undefined;
    if (!same) {
      const out = await sharp(Buffer.from(shot.data, "base64"), {
        limitInputPixels: 64000000,
      })
        .resize({
          width: 1568,
          height: 1200,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 70 })
        .toBuffer({ resolveWithObject: true });
      data = out.data;
      this.lastShot = shot.data;
      this.lastSize = { width: out.info.width, height: out.info.height };
      this.lastChange = Date.now();
    }
    if (!this.active) return;
    const frame: Frame = {
      id: ++this.frameNumber,
      at: Date.now(),
      width: this.lastSize!.width,
      height: this.lastSize!.height,
      state: after,
      observation: this.observation!,
    };
    this.pendingFrame = frame;
    this.send({
      type: "frame",
      frameId: frame.id,
      inputSeq: this.completedInput,
      capturedAt: frame.at,
      tabTag: this.tabTag,
      title: after.title,
      url: after.url,
      editable: after.focus.editable,
      width: frame.width,
      height: frame.height,
      ...(data ? { data: data.toString("base64") } : { same: true }),
    });
  }
  async message(message: Obj) {
    assert(await this.valid(), "登录已失效");
    this.lastMessage = Date.now();
    assert(
      message && typeof message === "object" && !Array.isArray(message),
      "消息无效",
    );
    if (message.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (message.type === "frame_ack") {
      // The viewer could not show its last image; the next frame carries a full picture again.
      if (message.resend === true) this.lastShot = "";
      if (this.pendingFrame && this.pendingFrame.id === message.frameId) {
        this.presented = this.pendingFrame;
        this.acknowledged.set(this.presented.id, this.presented);
        // Keep starting frames through a touch hold, within the existing three-second input window.
        for (const [id, frame] of this.acknowledged)
          if (this.acknowledged.size > 32 || Date.now() - frame.at > 3000)
            this.acknowledged.delete(id);
        this.pendingFrame = undefined;
      }
      return;
    }
    if (message.type === "mode") {
      assert(["view", "control"].includes(message.mode), "控制模式无效");
      if (message.mode === "view") this.releaseControl();
      else this.claim();
      return;
    }
    assert(
      ["input", "pointer"].includes(message.type) &&
        Number.isSafeInteger(message.seq) &&
        message.seq > this.sequence,
      "不能重复发送操作",
    );
    this.sequence = message.seq;
    if (message.type === "pointer") {
      const mouse = this.mouse, action = message.action;
      assert(this.locked && this.wantsControl && mouse && !this.pointerReleasing &&
        message.dragSeq === mouse.seq && message.frameId === mouse.frame.id &&
        action?.action === "pointer" && ["move", "up"].includes(action.phase) &&
        Object.keys(action).every(key => ["action", "phase", "x", "y"].includes(key)), "拖动状态已失效");
      this.point(mouse.frame, mouse.frame.state, action.x, action.y);
      this.pointerPending = message;
      this.pointerReleasing = action.phase === "up";
      this.lastInput = Date.now();
      if (!this.pointerTask) {
        this.pointerTask = true;
        void this.io.run(async () => {
          while (this.pointerPending) {
            const next = this.pointerPending;
            this.pointerPending = undefined;
            await this.input(next);
            if (!this.mouse) this.pointerPending = undefined;
          }
        }).finally(() => {
          this.pointerTask = false;
          this.pointerReleasing = false;
        });
      }
      return;
    }
    assert(this.locked && !this.inputPending && !this.pointerTask, "请等待操作完成后再输入");
    this.inputPending = true;
    this.lastInput = Date.now();
    void this.io
      .run(() => this.input(message))
      .finally(() => {
        this.inputPending = false;
      });
  }
  claim() {
    if (this.wantsControl) return;
    if (this.claimTask) {
      this.send({
        type: "mode",
        mode: "view",
        reason: "正在释放控制权，请稍后重试",
      });
      return;
    }
    const current = this.hub.controllers.get(this.tabTag);
    if (current && current !== this) {
      this.send({
        type: "mode",
        mode: "view",
        reason: "另一位管理员正在操作此标签页",
      });
      return;
    }
    this.hub.controllers.set(this.tabTag, this);
    this.wantsControl = true;
    this.lastInput = Date.now();
    this.send({ type: "mode", mode: "waiting" });
    this.claimTask = this.hub.chrome
      .tabGate(this.tabTag)
      .run(async () => {
        if (!this.active || !this.wantsControl) return;
        this.locked = true;
        const released = new Promise<void>((yes) => {
          this.release = yes;
        });
        this.send({ type: "mode", mode: "control" });
        await released;
        await this.io.run(() => this.releaseMouse());
        this.locked = false;
      })
      .catch(() => {
        void this.close(1011, "浏览器操作锁已释放");
      })
      .finally(() => {
        this.claimTask = undefined;
        this.stopping = false;
        if (this.hub.controllers.get(this.tabTag) === this)
          this.hub.controllers.delete(this.tabTag);
      });
  }
  releaseControl(reason?: string) {
    this.stopping = !!this.claimTask;
    this.wantsControl = false;
    this.pointerPending = undefined;
    this.release?.();
    this.release = undefined;
    if (this.hub.controllers.get(this.tabTag) === this && !this.locked)
      this.hub.controllers.delete(this.tabTag);
    this.send({ type: "mode", mode: "view", reason });
  }
  invalidate() {
    for (const [key, o] of this.hub.chrome.observations)
      if (o.tabTag === this.tabTag) this.hub.chrome.observations.delete(key);
  }
  async releaseMouse() {
    const mouse = this.mouse;
    this.mouse = undefined;
    if (mouse)
      await this.hub.chrome
        .cdp(this.tabTag, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: mouse.x,
          y: mouse.y,
          button: mouse.button,
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => {});
  }
  async input(message: Obj) {
    let attempted = false;
    try {
      assert(
        await this.valid() && this.locked && this.wantsControl,
        "远程控制已停止",
      );
      const chrome = this.hub.chrome,
        raw = message.action;
      assert(raw && typeof raw === "object" && !Array.isArray(raw), "操作无效");
      const drag =
        raw.action === "pointer" && ["move", "up"].includes(raw.phase)
          ? this.mouse
          : undefined;
      const frame = drag?.frame || this.acknowledged.get(message.frameId);
      assert(
        frame &&
          frame.id === message.frameId &&
          (drag || Date.now() - frame.at < 3000),
        "画面已过期，请等待实时画面更新",
      );
      const state = await this.pageState();
      // A held drag may scroll its own page; only new inputs require an unchanged, fresh frame.
      assert(
        frame.state.document === state.document &&
          (drag
            ? frame.state.url === state.url &&
              frame.state.width === state.width &&
              frame.state.height === state.height &&
              frame.state.viewport === state.viewport
            : frame.state.stamp === state.stamp),
        "网页或视口已变化，请等待实时画面更新",
      );
      if (raw.action === "pointer") {
        assert(
          Object.keys(raw).every((key) =>
            ["action", "phase", "x", "y"].includes(key),
          ) && ["down", "move", "up"].includes(raw.phase),
          "鼠标操作无效",
        );
        const { x, y } = this.point(frame, state, raw.x, raw.y);
        assert(
          (raw.phase === "down" && !this.mouse) ||
            (raw.phase !== "down" && this.mouse),
          "拖动状态已失效",
        );
        attempted = true;
        this.invalidate();
        this.mouse = { x, y, button: "left", frame, seq: this.mouse?.seq ?? message.seq };
        if (raw.phase === "up" && drag && (drag.x !== x || drag.y !== y))
          await chrome.cdp(this.tabTag, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        await chrome.cdp(this.tabTag, "Input.dispatchMouseEvent", {
          type:
            raw.phase === "down"
              ? "mousePressed"
              : raw.phase === "up"
                ? "mouseReleased"
                : "mouseMoved",
          x,
          y,
          button: "left",
          buttons: raw.phase === "up" ? 0 : 1,
          clickCount: 1,
        });
        if (raw.phase === "up") this.mouse = undefined;
      } else if (["goto", "back", "forward", "reload"].includes(raw.action)) {
        assert(
          Object.keys(raw).every((key) =>
            ["action", ...(raw.action === "goto" ? ["url"] : [])].includes(key),
          ),
          "导航参数无效",
        );
        const url =
          raw.action === "goto"
            ? (assert(
                typeof raw.url === "string" && raw.url.length <= 8192,
                "网址无效",
              ),
              httpURL(raw.url).href)
            : undefined;
        attempted = true;
        this.invalidate();
        await this.releaseMouse();
        await chrome.bridge.request(raw.action, {
          tabTag: this.tabTag,
          ...(url ? { url } : {}),
        });
        this.observation = undefined;
      } else {
        const action = normalizeAction(raw);
        assert(
          ["click_at", "scroll_at", "type", "press"].includes(action.action),
          "不支持的实时操作",
        );
        if (action.action === "press")
          assert(remoteKeys.includes(action.key), "不支持此按键");
        if (action.action === "type" || action.action === "press") {
          const now = await chrome.evaluate(
            this.tabTag,
            this.observation!.frames[state.focus.frame || 0],
            "__novaWebview.inputState()",
          );
          assert(
            now.identity === frame.state.focus.identity &&
              (state.focus.frame || 0) === (frame.state.focus.frame || 0),
            "焦点已变化，请重新点击网页输入框",
          );
          if (action.action === "type")
            assert(now.editable, "请先点击网页中的输入框");
          attempted = true;
          this.invalidate();
          if (action.action === "type")
            await chrome.cdp(this.tabTag, "Input.insertText", {
              text: action.text,
            });
          else await chrome.key(this.tabTag, action.key);
        } else {
          const { x, y } = this.point(frame, state, action.x, action.y);
          attempted = true;
          this.invalidate();
          if (action.action === "scroll_at")
            await chrome.cdp(this.tabTag, "Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x,
              y,
              deltaY: action.delta,
              deltaX: action.delta_x || 0,
            });
          else {
            await chrome.cdp(this.tabTag, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
            });
            await chrome.mouse(
              this.tabTag,
              { x, y },
              action.button || "left",
              action.click_count || 1,
            );
          }
        }
      }
      this.completedInput = message.seq;
      this.send({ type: message.type === "pointer" ? "pointer_result" : "input_result", seq: message.seq, dragSeq: message.dragSeq, status: "executed" });
    } catch (e: any) {
      await this.releaseMouse();
      this.completedInput = message.seq;
      this.send({
        type: message.type === "pointer" ? "pointer_result" : "input_result",
        dragSeq: message.dragSeq,
        seq: message.seq,
        status: attempted ? "needs_review" : "not_executed",
        reason: e.message,
      });
      if (attempted)
        this.releaseControl("结果不确定，已退出操作；请核对网页，勿重复提交");
    }
  }
  point(frame: Frame, state: Obj, x: unknown, y: unknown) {
    assert(
      typeof x === "number" &&
        typeof y === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        y >= 0 &&
        x < frame.width &&
        y < frame.height,
      "坐标超出画面",
    );
    return {
      x: (x * state.width) / frame.width,
      y: (y * state.height) / frame.height,
    };
  }
  async close(code = 1000, reason = "连接已关闭") {
    if (!this.active) return;
    this.active = false;
    this.releaseControl();
    this.hub.sessions.delete(this.socket.id);
    this.socket.close(code, reason);
  }
}
