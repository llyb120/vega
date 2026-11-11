// 一条 SSE 响应是一条严格有序的字节流：大载荷挡住后面所有事件，所以服务端把大帧分到其它车道（lane），
// 每条车道各开一条读流。对外用法与 WebSocket 相同：send(text) 走 POST 上行，onmessage 收到 { data, value }。

/**
 * 读一条 text/event-stream：按空行切帧，只取 `data:` 行；注释行（`: keepalive`）自然被忽略。
 * onMessage 返回 true 表示读够了，立刻取消读流；onByte 在每个 chunk 到达时回调（用于「收到过响应字节」）。
 */
export async function readEvents(response, onMessage, { onByte, signal } = {}) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onByte?.(value.byteLength);
      pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      for (let cut; (cut = pending.indexOf("\n\n")) >= 0; ) {
        const block = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data && onMessage(data) === true) return;
      }
      // shortcut: 单条事件整块留在内存里；服务端不会发这么大的单条事件，超限即当作坏流断开。
      if (pending.length > (32 << 20)) throw Error("SSE 事件过大");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

// HTTP 状态在被代理或网关挡下时代替 closed 帧：映射回原来的关闭码语义。
const codeOf = (status) => status === 401 ? 4401 : status === 403 ? 4403 : status === 429 ? 4429 : 1006;

export class SseSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /**
   * @param {string | URL} url 车道 0 的地址（http/https），车道 ≥1 在同一地址上加 channel/lane 参数。
   * @param {{ method?: string, headers?: Record<string, string>, body?: BodyInit, post?: boolean | Function, csrf?: string, uplink?: string | URL }} options
   *   post: false 表示这条通道没有上行；传函数则用它发送上行消息，默认 POST {channel, message}。
   *   uplink：上行地址，缺省与开流地址相同（浏览器实时画面的上行是另一个路径）。
   */
  constructor(url, { method = "GET", headers, body, post = true, csrf, uplink } = {}) {
    this.url = new URL(url, globalThis.location?.href);
    this.uplinkURL = uplink ? new URL(uplink, globalThis.location?.href) : this.url;
    this.method = method;
    this.headers = headers || {};
    this.body = body;
    this.uplinkMode = post;
    this.csrf = csrf || "";
    this.readyState = SseSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this.channel = "";
    this.channelWait = null;
    this.channelReady = null;
    this.lanes = new Map();
    this.queue = Promise.resolve();
    this.primary = new AbortController();
    this.started = false;
    this.finished = false;
    this.read(0, this.primary, this.url);
  }

  async read(lane, controller, url) {
    if (lane) this.lanes.set(lane, controller);
    try {
      const response = await fetch(url, {
        method: this.method,
        headers: { Accept: "text/event-stream", ...this.headers },
        // 车道用 channel + cookie 重新验证同一个身份，不重发一次性票据的 body。
        ...(lane || this.method === "GET" ? {} : { body: this.body }),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw Object.assign(Error(`实时通道 HTTP ${response.status}`), { status: response.status });
      if (!this.started) {
        this.started = true;
        this.readyState = SseSocket.OPEN;
        this.onopen?.({});
      }
      // 没有 closed 帧就断流，等同于 1006：整条通道结束，由调用方决定重连。
      await readEvents(response, (data) => this.receive(data), { signal: controller.signal });
      if (this.finished || controller.signal.aborted) return;
      this.finish(1006, "");
    } catch (error) {
      if (this.finished || controller.signal.aborted) return;
      // 先把关闭码定下来再喊 onerror：调用方在 onerror 里 close() 也不会把 4401 变成 1000。
      this.finish(codeOf(error?.status), String(error?.message || ""));
      this.onerror?.({ message: String(error?.message || "实时连接失败") });
    }
  }

  receive(data) {
    if (this.finished) return;
    let value;
    try { value = JSON.parse(data); } catch { value = undefined; }
    if (value && typeof value === "object") {
      if (value.type === "channel" && typeof value.channel === "string") {
        this.channel = value.channel;
        this.channelReady?.();
        this.channelReady = null;
        return;
      }
      if (value.type === "lane") {
        if (Number.isInteger(value.open)) this.openLane(value.open);
        if (Number.isInteger(value.close)) this.closeLane(value.close);
        return;
      }
      if (value.type === "closed") { this.finish(Number.isInteger(value.code) ? value.code : 1000, String(value.reason || "")); return; }
    }
    // 调用方回调自己的异常不应拖断读流。
    try { this.onmessage?.({ data, value }); } catch {}
  }

  openLane(lane) {
    if (!this.channel || lane < 1 || this.lanes.has(lane) || this.finished) return;
    const url = new URL(this.url);
    // 车道 ≥1 用 channel + cookie 重新验证同一个身份，不带只用一次的开流票据。
    url.searchParams.delete("ticket");
    url.searchParams.set("channel", this.channel);
    url.searchParams.set("lane", String(lane));
    this.read(lane, new AbortController(), url);
  }

  closeLane(lane) {
    const controller = this.lanes.get(lane);
    if (!controller) return;
    this.lanes.delete(lane);
    controller.abort();
  }

  send(text) {
    if (this.uplinkMode === false || this.finished || this.readyState !== SseSocket.OPEN) return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    // shortcut: bufferedAmount 估算排队中的字符数而不是压缩后的字节数，只用于拥堵判断。
    const bytes = String(text).length;
    this.bufferedAmount += bytes;
    // 通道 id 还没到（流刚开）时先压住：上行不能因为早了一帧就被丢掉。
    const ready = this.channel ? undefined : (this.channelWait ||= new Promise((yes) => { this.channelReady = yes; }));
    const run = () => Promise.resolve(ready)
      .then(() => this.uplink(message))
      .catch((error) => this.fail(error))
      .finally(() => { this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes); });
    // 同一通道的上行必须串行，顺序就是调用顺序。
    this.queue = this.queue.then(run);
  }

  async uplink(message) {
    if (typeof this.uplinkMode === "function") { await this.uplinkMode(message); return; }
    const response = await fetch(this.uplinkURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}), ...this.headers },
      body: JSON.stringify({ channel: this.channel, message }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw Object.assign(Error(`上行被拒绝（HTTP ${response.status}）`), { status: response.status });
  }

  fail(error) {
    const status = Number.isInteger(error?.status) ? error.status : 0;
    this.finish(codeOf(status), String(error?.message || ""));
    this.onerror?.({ message: String(error?.message || "上行失败") });
  }

  close() {
    if (this.finished) return;
    this.readyState = SseSocket.CLOSING;
    this.finish(1000, "");
  }

  /** 结束整条通道：先取消读流，再一次性交出 onclose（异步，和浏览器的事件时序一致）。 */
  finish(code, reason) {
    if (this.finished) return;
    this.finished = true;
    this.readyState = SseSocket.CLOSED;
    this.primary.abort();
    for (const controller of this.lanes.values()) controller.abort();
    this.lanes.clear();
    queueMicrotask(() => { if (this.onclose) this.onclose({ code, reason }); });
  }
}
