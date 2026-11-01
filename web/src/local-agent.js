// Only relays requests for the current login and bridge instance; reconnect never replays a job.
export class LocalAgentBridge {
  constructor(api, userId, status = (_online) => {}) {
    this.api = api;
    this.userId = userId;
    this.status = status;
    this.pending = new Set();
    this.closed = false;
    this.generation = 0;
  }
  async connect() {
    const generation = ++this.generation;
    this.instance = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const instance = this.instance;
    try {
      const { ticket } = await this.api("/local-agent/ticket", "POST", { instance });
      if (this.closed || generation !== this.generation) return;
      const ws = new WebSocket("ws://127.0.0.1:47673/agent");
      this.socket = ws;
      const lost = () => {
        if (generation !== this.generation) return;
        this.generation++;
        clearTimeout(this.timeout);
        clearInterval(this.heartbeat);
        this.ready = false;
        this.pending.clear();
        this.status(false);
        ws.close();
        void this.api("/local-agent/disconnect", "POST", { instance }).catch(() => {});
        if (!this.closed) this.retry = setTimeout(() => void this.connect(), 5000);
      };
      this.timeout = setTimeout(lost, 10000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", ticket }));
      ws.onerror = lost;
      ws.onclose = lost;
      ws.onmessage = async ({ data }) => {
        if (this.closed || generation !== this.generation) return;
        try {
          if (typeof data !== "string" || data.length > 48 * 1024 * 1024) throw Error("Invalid local response");
          const message = JSON.parse(data);
          if (message.type === "ready" && !this.ready) {
            if (message.instance !== instance || message.userId !== this.userId) throw Error("Local login mismatch");
            const details = { instance, cwd: message.cwd, platform: message.platform };
            await this.api("/local-agent/connect", "POST", details);
            if (this.closed || generation !== this.generation) return;
            clearTimeout(this.timeout);
            this.ready = true;
            this.status(true);
            this.heartbeat = setInterval(() => {
              void this.api("/local-agent/connect", "POST", details).catch(lost);
            }, 5000);
          } else if (this.pending.delete(message.id)) {
            await this.api("/local-agent/result", "POST", { instance, id: message.id, result: message.result });
          }
        } catch { lost(); }
      };
    } catch {
      if (!this.closed && generation === this.generation)
        this.retry = setTimeout(() => void this.connect(), 5000);
    }
  }
  forward(job) {
    if (!this.ready || this.closed || job.instance !== this.instance) return;
    if (job.op !== "cancel") {
      if (this.pending.has(job.id)) return;
      this.pending.add(job.id);
    }
    try { this.socket.send(JSON.stringify({ id: job.id, op: job.op, args: job.args })); }
    catch { this.socket.close(); }
  }
  close() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    clearInterval(this.heartbeat);
    this.pending.clear();
    this.socket?.close();
    this.status(false);
    if (this.instance) void this.api("/local-agent/disconnect", "POST", { instance: this.instance }).catch(() => {});
  }
}
