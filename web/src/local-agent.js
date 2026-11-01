export function canBridgeLocal(device = globalThis.navigator) {
  return !device?.userAgentData?.mobile &&
    !/Android|iPhone|iPad|iPod|Mobile/i.test(device?.userAgent || "") &&
    !(device?.platform === "MacIntel" && device?.maxTouchPoints > 1);
}

// The website hands off a one-use login ticket; device credentials and jobs never enter the page.
export class LocalAgentPairing {
  constructor(api, userId, status = (_paired) => {}) {
    this.api = api;
    this.userId = userId;
    this.status = status;
    this.closed = false;
    this.generation = 0;
  }
  async connect() {
    const generation = ++this.generation;
    this.instance = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const instance = this.instance;
    const retry = () => {
      if (this.closed || this.paired || generation !== this.generation) return;
      this.generation++;
      clearTimeout(this.timeout);
      this.socket?.close();
      this.retry = setTimeout(() => void this.connect(), 5000);
    };
    try {
      const { ticket } = await this.api("/local-agent/ticket", "POST", { instance });
      if (this.closed || generation !== this.generation) return;
      const ws = new WebSocket("ws://127.0.0.1:47673/agent");
      this.socket = ws;
      this.timeout = setTimeout(retry, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", ticket, userId: this.userId }));
      ws.onerror = retry;
      ws.onclose = retry;
      ws.onmessage = ({ data }) => {
        if (this.closed || generation !== this.generation) return;
        try {
          if (typeof data !== "string" || data.length > 4096) throw Error("Invalid pairing response");
          const message = JSON.parse(data);
          if (message.type !== "paired" || message.instance !== instance || message.userId !== this.userId) throw Error("Local pairing mismatch");
          this.paired = true;
          clearTimeout(this.timeout);
          clearTimeout(this.retry);
          this.status(true);
          ws.close();
        } catch { retry(); }
      };
    } catch { retry(); }
  }
  close() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    this.socket?.close();
  }
}
