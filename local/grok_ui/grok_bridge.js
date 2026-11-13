// Grok Bot UI Bridge for Vega WebView2 Desktop Client
(function () {
  console.log("[Vega Grok Bridge] Starting initialization...");

  const basePrefix = window.location.pathname.replace(/\/grok\/?.*$/, "") + "/";
  const apiPath = (endpoint) => `${basePrefix}api/${endpoint}`;

  let currentSelectedAgentId = null;
  let activeTranscriptWatcher = null;

  // 1. 本地存储代理 (模拟 Electron 主进程的 ClientPersistence)
  const persistenceKey = (k) => `sand_client_p_${k}`;

  // 2. 双向通信 MessageChannel (模拟 CoordinatorPort)
  let coordinatorPortHandler = null;
  const channel = new MessageChannel();
  const clientPort = channel.port1;
  const serverPort = channel.port2;

  serverPort.onmessage = async function (e) {
    const data = e.data;
    if (!data) return;
    // console.log("[Grok Bridge Port Server Recv]", data);

    if (data.kind === "lifecycle") {
      if (data.phase === "hello") {
        serverPort.postMessage({
          kind: "lifecycle",
          phase: "ready",
          protocolVersion: 3,
        });
      }
      return;
    }

    if (data.kind === "request") {
      const { requestId, method, args } = data;
      try {
        const result = await dispatchCoordinatorRequest(method, args);
        serverPort.postMessage({
          kind: "reply",
          requestId,
          outcome: { status: "ok", value: result },
        });
      } catch (err) {
        console.error(`[Grok Bridge] Request ${method} failed:`, err);
        serverPort.postMessage({
          kind: "reply",
          requestId,
          outcome: { status: "error", failure: { code: "internal", detail: String(err) } },
        });
      }
      return;
    }
  };

  // 3. 核心请求分发
  async function dispatchCoordinatorRequest(method, args) {
    // 获取 Agent 花名册（侧边栏列表）
    if (method === "getServerAgentRoster" || method === "listTeamAgents" || method === "getMainAgent") {
      const res = await fetch(apiPath("threads"), { method: "POST", body: "{}" }).catch(() => null);
      if (!res || !res.ok) return { agents: [] };
      const data = await res.json();
      const employees = data.employees || [];
      const grokAgents = employees.map((emp) => ({
        id: emp.id,
        name: emp.name,
        description: `Vega 牛马 · ${emp.running ? "工作中" : "空闲"}`,
        avatarShape: "sparkle",
        avatarColor: emp.running ? "green" : "blue",
        title: emp.runningTasks > 0 ? `${emp.runningTasks} 任务进行中` : "在线",
        origin: "server",
        unreadCount: emp.unread || 0,
        attentionCount: emp.attention || 0,
        threadId: emp.thread,
      }));
      return { agents: grokAgents };
    }

    // 获取当前 Agent 的消息流尾部 (打开会话)
    if (method === "openAgentTail" || method === "getAgentTranscriptTail") {
      const agentId = args?.agentId || currentSelectedAgentId;
      currentSelectedAgentId = agentId;
      if (!agentId) return { entries: [], nextBeforeSeq: null };

      const thread = `employee:${agentId}`;
      const res = await fetch(apiPath("messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread, limit: 100 }),
      }).catch(() => null);

      if (!res || !res.ok) return { entries: [], nextBeforeSeq: null };
      const data = await res.json();
      const vegaMsgs = data.messages || [];

      // 转换为 Grok 前端期望的 entries 格式
      const entries = vegaMsgs.map((m, idx) => {
        const isUser = m.role === "user";
        return {
          id: `entry-${m.id || idx}`,
          seq: idx + 1,
          createdAt: m.at || Date.now(),
          kind: isUser ? "user" : "assistant",
          author: isUser ? { kind: "user", id: "user-me", name: "我" } : { kind: "bot", agentId: agentId },
          content: [{ kind: "text", text: m.text || "" }],
          tasks: m.tasks || [],
        };
      });

      return {
        entries: entries,
        nextBeforeSeq: null,
      };
    }

    // 发送消息
    if (method === "sendPrompt") {
      const agentId = args?.agentId || currentSelectedAgentId;
      const text = args?.text || args?.prompt || "";
      if (!agentId || !text) return { outcome: "error", detail: "Missing agent or text" };

      const thread = `employee:${agentId}`;
      const res = await fetch(apiPath("send"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread, text }),
      }).catch(() => null);

      if (!res || !res.ok) {
        return { outcome: "failed" };
      }
      return { outcome: "sent", text };
    }

    // 审批任务控制（如点击待确认卡片中的允许/拒绝）
    if (method === "resolveAutoReviewApproval" || method === "resolveLocalToolPermission") {
      const agentId = args?.agentId || currentSelectedAgentId;
      const thread = `employee:${agentId}`;
      await fetch(apiPath("control"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread,
          id: args?.taskId || args?.id,
          action: args?.approved ? "approve" : "answer",
          approved: args?.approved,
          text: args?.text || "",
        }),
      }).catch(() => null);
      return {};
    }

    // 默认空对象
    return {};
  }

  // 4. 构建 window.desktop (Electron 兼容层)
  const desktop = {
    boot: {
      theme: { theme: "dark", resolvedTheme: "dark" },
      language: { language: "zh-CN", preference: "zh-CN" },
      isAssistiveTechEnabled: false,
      isEgressTunnelEnabled: false,
      isWebauthnProxyEnabled: false,
      isBotColorInChatEnabled: true,
      egressTunnelStatus: "inactive",
      mainEdge: "served",
      rosterPhotos: null,
      computerUseHelperName: null,
      experiments: null,
    },
    environment: {
      platform: "win32",
      isDev: false,
      isWaylandClient: false,
      usesProductionBackend: false,
      devVoiceHarness: "package",
    },
    local: {
      getZoomFactor: () => 1,
      noteRendererAlive: () => {},
      noteBootGateLanded: () => {},
      noteBootGateOpened: () => {},
      stageAttachmentFile: async () => null,
    },
    main: new Proxy(
      {},
      {
        get: function (target, prop) {
          return async function (args) {
            if (prop === "readClientPersistence") {
              return localStorage.getItem(persistenceKey(args?.key));
            }
            if (prop === "writeClientPersistence") {
              localStorage.setItem(persistenceKey(args?.key), args?.value || "");
              return;
            }
            if (prop === "removeClientPersistence") {
              localStorage.removeItem(persistenceKey(args?.key));
              return;
            }
            if (prop === "listClientPersistenceKeys") {
              const prefix = args?.prefix || "";
              const keys = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith("sand_client_p_" + prefix)) {
                  keys.push(k.replace("sand_client_p_", ""));
                }
              }
              return keys;
            }
            if (prop === "getGrokBotUserProfile") {
              return {
                id: "user-1",
                username: "Vega User",
                name: "Vega User",
                avatarUrl: null,
              };
            }
            if (prop === "getHostPinnedAgents" || prop === "listGrokBotTeamAgents") {
              return [];
            }
            if (prop === "getCredentialsState") {
              return { hasValidCredentials: true };
            }
            if (prop === "getMcpState") {
              return { servers: [] };
            }
            if (prop === "getUpdateStatus") {
              return { status: "up-to-date" };
            }
            return null;
          };
        },
      }
    ),
  };

  // 5. 构建 window.coordinatorPort
  const coordinatorPort = {
    claim: function (handler) {
      coordinatorPortHandler = handler;
      setTimeout(() => {
        if (coordinatorPortHandler && coordinatorPortHandler.onPort) {
          coordinatorPortHandler.onPort({
            accountSlot: "slot-0",
            postMessage: (msg) => clientPort.postMessage(msg),
            close: () => clientPort.close(),
            start: () => clientPort.start(),
            addEventListener: (type, listener) => clientPort.addEventListener(type, listener),
          });
        }
      }, 0);
      return {
        request: () => {},
        release: () => {},
      };
    },
  };

  // 注入全局对象
  window.desktop = desktop;
  window.coordinatorPort = coordinatorPort;
  window.sandPopout = { agentId: null };
  window.sandSpotlight = { isSpotlight: false };
  window.desktopMount = {};
  window.spotlight = {};

  console.log("[Vega Grok Bridge] Injected successfully.");
})();
