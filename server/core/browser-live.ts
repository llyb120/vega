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
  "({stamp:__novaWebview.stamp(),focus:__novaWebview.inputState(),width:innerWidth,height:innerHeight,url:location.href,title:document.title})";

// shortcut: JPEG snapshot stream (at most 10 fps); use screencast/WebRTC for video-grade motion.
// Frames are ephemeral and acknowledged one at a time; video must never fill SQLite or an input queue.
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
      this.auth.resolveHash(principal.hash)?.user.role === "admin",
      "仅管理员可查看和操作浏览器",
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
  authorize(request: Socket["request"], consume = false) {
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
    const principal = this.auth.authenticate(token),
      id = url.searchParams.get("ticket") || "",
      ticket = this.tickets.get(id);
    assert(
      principal?.user.role === "admin" &&
        ticket &&
        ticket.hash === principal.hash &&
        ticket.until >= Date.now(),
      "连接已过期，请重新连接浏览器",
    );
    if (consume) this.tickets.delete(id);
    return { principal, ticket };
  }
  open(socket: Socket) {
    const { principal, ticket } = this.authorize(socket.request, true);
    assert(this.sessions.size < 4, "实时浏览器连接过多");
    for (const session of this.sessions.values())
      if (session.principal.hash === principal.hash)
        void session.close(1000, "已在新窗口连接");
    const session = new LiveSession(this, socket, principal, ticket.tabTag);
    this.sessions.set(socket.id, session);
    void session.run();
  }
  message(socket: Socket, raw: string) {
    const session = this.sessions.get(socket.id);
    if (!session) return;
    try {
      assert(Buffer.byteLength(raw) <= 65536, "消息过大");
      session.message(JSON.parse(raw));
    } catch {
      void session.close(4400, "实时操作消息无效，请重新连接");
    }
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
  release?: () => void;
  io = new Mutex();
  observation?: Awaited<ReturnType<Chrome["observe"]>>;
  presented?: Frame;
  acknowledged = new Map<number, Frame>();
  pendingFrame?: Frame;
  frameNumber = 0;
  sequence = 0;
  inputPending = false;
  lastMessage = Date.now();
  lastInput = Date.now();
  mouse?: { x: number; y: number; button: string };
  constructor(
    public hub: BrowserLive,
    public socket: Socket,
    public principal: Principal,
    public tabTag: string,
  ) {}
  send(value: Obj) {
    if (this.active) this.socket.send(JSON.stringify(value));
  }
  valid() {
    return (
      this.active &&
      this.hub.auth.resolveHash(this.principal.hash)?.user.role === "admin"
    );
  }
  async run() {
    try {
      this.send({ type: "ready", tabTag: this.tabTag, mode: "view" });
      while (this.active) {
        assert(this.valid(), "登录已失效");
        assert(Date.now() - this.lastMessage < 20000, "连接已中断，请重新连接");
        if (this.wantsControl && Date.now() - this.lastInput > 30000)
          this.releaseControl("闲置已退出远程操作");
        if (this.pendingFrame) {
          assert(
            Date.now() - this.pendingFrame.at < 10000,
            "画面传输超时，请重新连接",
          );
        } else if (!this.stopping && (!this.wantsControl || this.locked)) {
          const capture = () => this.io.run(() => this.capture());
          if (this.locked) await capture();
          else
            await this.hub.chrome.tabGate(this.tabTag).run(async () => {
              if (this.active && !this.wantsControl) await capture();
            });
        }
        await sleep(100);
      }
    } catch (e: any) {
      this.send({ type: "error", reason: e.message });
      await this.close(1011, "实时浏览器连接已停止");
    }
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
    let before: Obj;
    try {
      before = await this.pageState();
    } catch {
      before = await this.pageState();
    }
    const shot = await chrome.cdp(this.tabTag, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const after = await this.pageState();
    if (before.stamp !== after.stamp || before.document !== after.document)
      return;
    const { data, info } = await sharp(Buffer.from(shot.data, "base64"), {
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
    if (!this.active) return;
    const frame: Frame = {
      id: ++this.frameNumber,
      at: Date.now(),
      width: info.width,
      height: info.height,
      state: after,
      observation: this.observation!,
    };
    this.pendingFrame = frame;
    this.send({
      type: "frame",
      frameId: frame.id,
      capturedAt: frame.at,
      tabTag: this.tabTag,
      title: after.title,
      url: after.url,
      editable: after.focus.editable,
      width: frame.width,
      height: frame.height,
      data: data.toString("base64"),
    });
  }
  message(message: Obj) {
    assert(this.valid(), "登录已失效");
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
      if (this.pendingFrame && this.pendingFrame.id === message.frameId) {
        this.presented = this.pendingFrame;
        this.acknowledged.set(this.presented.id, this.presented);
        for (const [id, frame] of this.acknowledged)
          if (this.acknowledged.size > 3 || Date.now() - frame.at > 3000)
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
      message.type === "input" &&
        Number.isSafeInteger(message.seq) &&
        message.seq > this.sequence,
      "不能重复发送操作",
    );
    this.sequence = message.seq;
    assert(this.locked && !this.inputPending, "请等待操作完成后再输入");
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
          ...mouse,
          clickCount: 1,
        })
        .catch(() => {});
  }
  async input(message: Obj) {
    let attempted = false;
    try {
      assert(
        this.valid() && this.locked && this.wantsControl,
        "远程控制已停止",
      );
      const frame = this.acknowledged.get(message.frameId);
      assert(
        frame && frame.id === message.frameId && Date.now() - frame.at < 3000,
        "画面已过期，请等待实时画面更新",
      );
      const state = await this.pageState();
      assert(
        frame.state.document === state.document &&
          frame.state.stamp === state.stamp,
        "网页或视口已变化，请等待实时画面更新",
      );
      const chrome = this.hub.chrome,
        raw = message.action;
      assert(raw && typeof raw === "object" && !Array.isArray(raw), "操作无效");
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
        this.mouse = { x, y, button: "left" };
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
      this.send({ type: "input_result", seq: message.seq, status: "executed" });
    } catch (e: any) {
      await this.releaseMouse();
      this.send({
        type: "input_result",
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
