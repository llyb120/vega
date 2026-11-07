export function canBridgeLocal(device = globalThis.navigator) {
  return !device?.userAgentData?.mobile &&
    !/Android|iPhone|iPad|iPod|Mobile/i.test(device?.userAgent || "") &&
    !(device?.platform === "MacIntel" && device?.maxTouchPoints > 1);
}

const STATUS = {
  detecting: "正在检测本机客户端…",
  local_unavailable: "未检测到可连接的本机客户端。请启动客户端，并允许浏览器访问本地网络；若已运行，请检查托盘“连接授权”。",
  permission_required: "已检测到客户端，等待站点授权。请在弹出的“Vega 本机连接授权”页面点击“允许此站点”，然后回到此页。",
  ticket_failed: "无法取得网站的配对票据。请检查登录是否有效，以及 /api/local-agent/ticket 是否能访问。",
  authorizing: "站点已允许，客户端正在向网站验证登录…",
  login_network: "客户端无法访问网站的登录验证接口，请检查客户端网络、DNS 和 HTTPS 证书。",
  login_http: "网站拒绝了客户端的登录验证，请检查登录状态、服务端版本和 /api/local-agent/verify 的代理配置。",
  login_invalid: "配对响应不兼容或票据无效，请确认网站与客户端均为最新版本后重新检测。",
  credential_save: "客户端无法保存设备凭据，请检查当前用户配置目录的写入权限和系统凭据保护。",
  backend_connecting: "登录验证已通过，客户端正在直连后端…",
  backend_network: "站点已授权，但客户端无法建立后端连接，请检查客户端网络及反向代理的 WebSocket 转发。",
  backend_tls: "站点已授权，但后端 HTTPS 证书校验失败，请修复证书链或域名；不会跳过证书校验。",
  backend_http: "站点已授权，但后端拒绝了客户端 WebSocket，请检查 /api/local-agent/socket 的 Upgrade、Connection、Authorization 转发及设备授权。",
  backend_protocol: "客户端已接通 WebSocket，但未收到有效的后端 ready 确认，请检查前后端与客户端版本及代理配置。",
  client_outdated: "客户端版本低于本节点要求，请到「资源」页下载并安装新客户端。",
  backend_timeout: "登录验证已通过，但后端连接尚未就绪。客户端会独立重连，可稍后重新检测。",
  backend_disconnected: "客户端到后端的连接已中断，客户端会独立重连；不会重发已提交的任务。",
  backend_cwd: "客户端无法读取启动目录，请从仍然存在且有权限的目录重新启动客户端。",
  backend_internal: "客户端初始化连接失败，请重新启动客户端后检测。",
  legacy_client: "客户端已接受授权，但未确认后端直连。请用最新代码重新构建并退出旧客户端，再启动新版。",
  connected: "本机客户端已直连后端，关闭网页后仍可使用。",
};
export function pairingStatusText(status) {
  if (!status) return "";
  if (typeof status.message === "string" && status.message) return status.message;
  const text = STATUS[status.code] || STATUS.login_invalid;
  return text + (Number.isInteger(status.httpStatus) && status.httpStatus >= 100 && status.httpStatus <= 599 ? `（HTTP ${status.httpStatus}）` : "");
}

// The website hands off one login ticket and observes the first connection result, never credentials or jobs.
export class LocalAgentPairing {
  constructor(api, userId, status = (_status) => {}) {
    this.api = api;
    this.userId = userId;
    this.status = status;
    this.closed = false;
    this.generation = 0;
  }
  async connect() {
    if (this.closed || this.paired) return;
    const generation = ++this.generation;
    clearTimeout(this.retry);
    if (!this.lastStatus) this.report("detecting");
    this.instance = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const instance = this.instance;
    const retry = (code, httpStatus, message) => {
      if (this.closed || this.paired || generation !== this.generation) return;
      this.generation++;
      clearTimeout(this.timeout);
      this.report(code, httpStatus, message);
      this.socket?.close();
      const terminal = ["credential_save", "login_invalid"].includes(code) ||
        (code === "backend_http" && [401, 403].includes(httpStatus));
      if (!terminal) this.retry = setTimeout(() => void this.connect(), 5000);
    };
    try {
      const { ticket } = await this.api("/local-agent/ticket", "POST", { instance });
      if (this.closed || generation !== this.generation) return;
      const ws = new WebSocket("ws://127.0.0.1:47673/agent");
      this.socket = ws;
      this.timeout = setTimeout(() => retry("backend_timeout"), 30000);
      let opened = false;
      ws.onopen = () => {
        if (this.closed || generation !== this.generation) return;
        opened = true;
        ws.send(JSON.stringify({ type: "auth", ticket, userId: this.userId }));
      };
      ws.onerror = () => retry(opened ? "backend_disconnected" : "local_unavailable");
      ws.onclose = () => retry(opened ? "backend_disconnected" : "local_unavailable");
      ws.onmessage = ({ data }) => {
        if (this.closed || generation !== this.generation) return;
        try {
          if (typeof data !== "string" || data.length > 4096) throw Error("Invalid pairing response");
          const message = JSON.parse(data);
          if (message.type === "status" && (Object.hasOwn(STATUS, message.code) || typeof message.message === "string") && message.code !== "connected") {
            if (["authorizing", "backend_connecting"].includes(message.code)) this.report(message.code);
            else retry(message.code, message.httpStatus, message.message);
            return;
          }
          if (message.type !== "paired" || message.instance !== instance || message.userId !== this.userId || !/^[a-f0-9]{32}$/.test(message.clientId)) throw Error("Local pairing mismatch");
          this.paired = true;
          clearTimeout(this.timeout);
          clearTimeout(this.retry);
          this.report(message.connected === true ? "connected" : "legacy_client");
          ws.close();
        } catch { retry("login_invalid"); }
      };
    } catch { retry("ticket_failed"); }
  }
  report(code, httpStatus, message) {
    this.lastStatus = { code, ...(typeof message === "string" && message ? { message } : {}), ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) };
    this.status(this.lastStatus);
  }
  close() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    this.socket?.close();
  }
}
