// Only the Electron/Coordinator boundary is adapted. Grok's renderer owns every component and DOM node.
(() => {
  const base = new URL('./', location.href);
  const desktopListeners = new Set(), ports = new Set(), watched = new Map(), attempts = new Map(), staged = new Map();
  let roster = [], selected = null, host = null, polling = false;
  const key = name => 'vega.grok.' + base.pathname + ':' + name;
  const read = (name, fallback = null) => { try { const value = localStorage.getItem(key(name)); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } };
  const write = (name, value) => localStorage.setItem(key(name), JSON.stringify(value));
  const theme = () => { const preference = read('theme', 'system'); return { preference, resolved: preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference }; };
  const language = () => ({ preference: 'en', resolved: 'en', systemLanguage: navigator.language });
  const experiments = { isInitialized: true, hasAuthenticatedBootstrap: true, featureGates: { grok_bot_multiplayer: false }, dynamicConfigs: {} };
  const unsupported = method => { const error = new Error('Vega 尚未接入此功能：' + method); error.code = 'source/capability-unavailable'; throw error; };
  async function api(op, body = {}) {
    const response = await fetch(new URL('api/' + op, base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }
  const boot = api('host').then(value => (host = value));
  const emitDesktop = (name, value) => { for (const listeners of desktopListeners) listeners[name]?.(value); };
  const event = (family, payload) => { for (const port of ports) port.postMessage({ kind: 'event', family, payload }); };
  function agentOf(item) {
    return { id: item.thread, name: item.name, description: item.instruction || '', title: '', harness: 'temporal', origin: 'server',
      avatarShape: 'sparkle', avatarColor: 'blue', isGroup: item.kind === 'group', memberIds: [],
      createdAt: item.lastAt || 0, updatedAt: item.lastAt || 0, lastActivityAt: item.lastAt || 0,
      isRunning: !!item.running, hasUnread: !!item.unread, unreadCount: item.unread || 0, awaitingUserResponse: null,
      viewerIsOwner: item.mine !== false, visibility: 'owner', isActive: item.thread === selected };
  }
  async function refreshRoster() {
    const data = await api('threads');
    roster = [...(data.employees || []), ...(data.groups || [])];
    return roster.map(agentOf);
  }
  const filePath = file => '/vega-blob/' + file.blobId + '/' + encodeURIComponent(file.name || 'image.png');
  const clipText = (value, max = 4000) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max) + '\n\n…（已截断，完整内容仍在服务端）' : text; };
  const secretKey = /key|token|secret|password|authorization|cookie|credential/i;
  const statusText = status => ({ approval: '待确认', waiting: '待补充', running: '进行中', queued: '排队', done: '已完成', failed: '失败', stopped: '已停止', cancelled: '已取消', sealed: '已封存', deferred: '已挂起', recovering: '恢复中' })[status] || String(status || '未知');
  const taskIdOf = entryId => { const mark = ':ask:', at = String(entryId || '').indexOf(mark); return at < 0 ? '' : entryId.slice(at + mark.length); };
  function redactValue(value, depth) {
    if (depth > 4) return '…';
    if (Array.isArray(value)) return value.slice(0, 20).map(item => redactValue(item, depth + 1));
    if (!value || typeof value !== 'object') return typeof value === 'string' && value.length > 500 ? value.slice(0, 500) + '…' : value;
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = secretKey.test(key) ? '［已隐藏］' : redactValue(item, depth + 1);
    return out;
  }
  const shownText = message => message.role === 'user' ? (message.displayText || message.text || '') : (message.text || '');
  function bodyOf(message) {
    const parts = [];
    if (message.quote?.text) parts.push('> ' + String(message.quote.text).replace(/\n/g, '\n> '));
    if (message.author?.name) parts.push('**' + message.author.name + '**');
    const text = shownText(message);
    if (text) parts.push(text);
    if (message.thinking) parts.push('**思考**\n\n' + clipText(message.thinking));
    if (message.stepOutput && typeof message.stepOutput === 'object' && message.stepOutput.text) parts.push(String(message.stepOutput.text));
    if (message.tasks?.length) parts.push(message.tasks.map(task => '- ' + (task.title || task.id) + '（' + statusText(task.status) + '）').join('\n'));
    if (message.error && message.role !== 'user') parts.unshift('**错误**');
    return parts.filter(Boolean).join('\n\n');
  }
  function streamingEntry(messages, agentId, live) {
    if (!live || typeof live !== 'object') return null;
    let text = String(live.text || '');
    const latest = [...(messages || [])].reverse().find(message => message.role === 'assistant' && message.text);
    if (latest && text && String(latest.text).startsWith(text)) text = '';
    const parts = [];
    if (live.thinking) parts.push('**思考**\n\n' + clipText(live.thinking));
    if (text) parts.push(text);
    for (const tool of live.tools || []) {
      const mark = tool.status === 'error' ? '失败' : tool.status === 'done' ? '完成' : '进行中';
      parts.push('**工具** ' + (tool.name || 'tool') + '（' + mark + '）');
    }
    if (live.progress) parts.push(clipText(live.progress, 500));
    if (!parts.length) return null;
    return { id: agentId + ':live', kind: 'message', role: 'assistant', isStreaming: true, content: parts.join('\n\n'), timestampMs: live.at || 0 };
  }
  function entriesOf(messages, agentId, live) {
    const entries = [], employeeThread = String(agentId || '').startsWith('employee:');
    for (const message of messages || []) {
      const common = { seq: message.seq, timestampMs: message.at || 0, ...(message.clientMessageId ? { clientNonce: message.clientMessageId } : {}) };
      const files = [...(message.images || []), ...(message.files || []), ...(message.stepOutput && typeof message.stepOutput === 'object' ? message.stepOutput.files || [] : [])];
      files.filter(file => file?.blobId).forEach((file, index) => entries.push({ ...common, id: agentId + ':' + message.seq + ':file' + index, kind: 'user-attachment', file_path: filePath(file), file_name: file.name || 'image.png', ...(file.size === undefined ? {} : { byteSize: file.size }) }));
      if (message.role === 'tool') {
        entries.push({ ...common, id: agentId + ':' + message.seq, kind: 'message', role: 'assistant', isStreaming: false, content: ['**工具结果** ' + (message.name || 'tool') + (message.error ? '（失败）' : ''), clipText(message.text || '（无文本结果）')].join('\n\n') });
        continue;
      }
      if (message.notice || message.newSession || message.role === 'system') {
        entries.push({ ...common, id: agentId + ':' + message.seq, kind: 'notice', text: clipText(message.text || (message.newSession ? '新会话' : '通知'), 2000), ...(message.error ? { tone: 'error' } : {}) });
        continue;
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        entries.push({ ...common, id: agentId + ':' + message.seq, kind: 'notice', text: '未识别的消息（' + String(message.role || 'unknown').slice(0, 40) + '）' + (message.text ? '\n' + clipText(message.text, 500) : '') });
        continue;
      }
      const content = bodyOf(message) || (files.some(file => file && !file.blobId) ? '有附件无法在客户端预览' : '');
      if (content) entries.push({ ...common, id: agentId + ':' + message.seq, kind: 'message', role: message.role === 'user' ? 'user' : 'assistant', isStreaming: false, content });
      for (const call of message.calls || []) {
        let args = '';
        try { args = JSON.stringify(redactValue(call.arguments || {}, 0), null, 2); } catch { args = ''; }
        entries.push({ ...common, id: agentId + ':' + message.seq + ':call:' + (call.id || call.name || 'call'), kind: 'message', role: 'assistant', isStreaming: false, content: ['**工具** ' + (call.name || 'tool'), args ? '```json\n' + clipText(args, 2000) + '\n```' : ''].filter(Boolean).join('\n\n') });
      }
      if (!employeeThread) continue;
      for (const task of message.tasks || []) {
        if (!task?.id || (!message.delivery && task.status !== 'approval' && task.status !== 'waiting')) continue;
        const pending = task.status === 'approval' || task.status === 'waiting';
        const widget = {
          prompt: (task.status === 'waiting' ? '需要补充：' : task.status === 'approval' ? '需要确认：' : '任务：') + (task.title || task.id),
          helpText: clipText(shownText(message) || task.title || '', 280),
          options: task.status === 'waiting' ? [{ label: '在输入框写下回复', value: '\u0000custom' }] : task.status === 'approval' ? [{ label: '批准', value: 'vega:approve' }, { label: '拒绝', value: 'vega:reject' }] : [{ label: statusText(task.status), value: 'vega:status' }],
          ...(task.status === 'waiting' ? { allowCustom: true } : {}),
        };
        entries.push({ ...common, id: agentId + ':' + message.seq + ':ask:' + task.id, kind: 'send-message', message: { type: 'widget', widget }, ...(pending ? {} : { respondedValue: statusText(task.status) }) });
      }
    }
    const streaming = streamingEntry(messages, agentId, live);
    if (streaming) entries.push(streaming);
    return entries;
  }
  const sameEntry = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  function applyEntries(id, state, entries) {
    const liveIds = new Set(entries.filter(entry => String(entry.id).endsWith(':live')).map(entry => entry.id));
    for (const entry of entries) {
      const index = state.entries.findIndex(old => old.id === entry.id);
      if (index >= 0) {
        if (sameEntry(state.entries[index], entry)) continue;
        state.entries[index] = entry;
        event('transcript', { agentId: id, type: 'updated', entry });
      } else {
        state.entries.push(entry);
        event('transcript', { agentId: id, type: 'appended', entry });
      }
    }
    state.entries = state.entries.filter(old => {
      if (!String(old.id).endsWith(':live') || liveIds.has(old.id)) return true;
      event('transcript', { agentId: id, type: 'removed', id: old.id });
      return false;
    });
  }
  function refreshTasks(id, state, taskStatus) {
    if (!taskStatus || typeof taskStatus !== 'object') return;
    for (let index = 0; index < state.entries.length; index++) {
      const entry = state.entries[index], taskId = taskIdOf(entry.id);
      if (!taskId || entry.kind !== 'send-message' || !Object.prototype.hasOwnProperty.call(taskStatus, taskId)) continue;
      const status = taskStatus[taskId], pending = status === 'approval' || status === 'waiting', next = { ...entry };
      if (pending) delete next.respondedValue; else next.respondedValue = statusText(status);
      if (sameEntry(next, entry)) continue;
      state.entries[index] = next;
      event('transcript', { agentId: id, type: 'updated', entry: next });
    }
  }
  const dataURL = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
  async function attachment(path) {
    if (staged.has(path)) return staged.get(path);
    const match = /^\/vega-blob\/(blob-[a-f\d]{32})\/([^/]+)$/.exec(path);
    if (!match) throw new Error('Unknown attachment');
    const value = await api('file', { blobId: match[1] });
    return { name: decodeURIComponent(match[2]), file: new Blob([Uint8Array.from(atob(value.data), c => c.charCodeAt(0))], { type: value.mime || 'application/octet-stream' }) };
  }
  async function stage(filename, file) {
    if (!(file instanceof Blob) || file.size > 25 * 1024 * 1024) return { ok: false, reason: 'too-large' };
    if (staged.size >= 16 || [...staged.values()].reduce((sum, item) => sum + item.file.size, file.size) > 64 * 1024 * 1024) return { ok: false, reason: 'store-full' };
    const name = String(filename).split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    const path = '/vega-staged/' + crypto.randomUUID() + '/' + encodeURIComponent(name);
    staged.set(path, { name, file });
    return { ok: true, path };
  }
  async function send(args) {
    const files = await Promise.all((args.attachmentPaths || []).map(async path => { const { name, file } = await attachment(path); return { name, mime: file.type, data: (await dataURL(file)).split(',')[1] }; }));
    const images = files.filter(file => /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mime));
    await api('send', { thread: args.agentId, text: args.prompt, clientMessageId: args.clientNonce, images, files: files.filter(file => !images.includes(file)) });
    return { accepted: true };
  }
  async function tail(args) {
    const id = args.id || args.agentId;
    if (!id || !/^(employee|group):.+/.test(id)) throw new Error('Invalid conversation');
    const data = await api('messages', { thread: id, limit: Math.min(200, args.limit || 100), ...(args.beforeSeq ? { before: args.beforeSeq } : {}) });
    const entries = entriesOf(data.messages || [], id, data.live);
    if (!args.beforeSeq) watched.set(id, { lastSeq: data.lastSeq ?? Math.max(0, ...(data.messages || []).map(message => message.seq)), entries });
    return { entries, nextBeforeSeq: data.hasMore && entries.length ? entries[0].seq : null, unreadBoundaryAt: null };
  }
  async function coordinator(method, args = {}) {
    switch (method) {
      case 'resolveAgentCreation': return { kind: 'box' };
      case 'getServerAgentRoster': return { status: 'ready', agents: await refreshRoster(), boxAgentCount: 0 };
      case 'listAgents': return [];
      case 'countAgents': return (await refreshRoster()).length;
      case 'getMainAgent': { if (!roster.length) await refreshRoster(); return { agentId: read('mainAgent', roster[0]?.thread || null) }; }
      case 'setMainAgent': write('mainAgent', args.agentId); return { agentId: args.agentId };
      case 'openAgentTail': case 'getAgentTranscriptTail': return tail(args);
      case 'noteMountedAgent': case 'noteTranscriptOpened': return;
      case 'clearGeneratedRoomNameStamps': return {};
      case 'getHostStatus': return { hostVersion: host?.version || null, latestHostVersion: null, hostUpdateAvailable: false, isBusy: false, capabilities: [] };
      case 'sendPrompt': {
        if (!args.clientNonce) throw new Error('Message nonce required');
        if (attempts.has(args.clientNonce)) return attempts.get(args.clientNonce);
        // A failed request may have reached the server: never automatically replay a send.
        const attempt = send(args);
        attempts.set(args.clientNonce, attempt);
        return attempt;
      }
      case 'promptAcceptanceStatus': return { outcome: 'unknown' };
      case 'createAgent': {
        const result = await api('create', { name: args.name || 'New Bot', instruction: args.description || '' });
        const agents = await refreshRoster(); event('server-roster-changed', { kind: 'resync' });
        return { agent: agents.find(agent => agent.id === 'employee:' + result.id), transcript: [] };
      }
      case 'setAgentUnread': if (!args.isUnread) await api('read', { thread: args.id }); else return unsupported(method); return null;
      case 'resolveAutoReviewApproval': case 'resolveLocalToolPermission':
        await api('control', { thread: args.agentId, id: args.taskId || args.id, action: 'approve', approved: args.approved }); return;
      case 'respondToWidget': {
        const taskId = taskIdOf(args.entryId);
        if (!taskId || !String(args.agentId || '').startsWith('employee:')) throw new Error('这条卡片不能在这里提交');
        const values = Array.isArray(args.value) ? args.value.map(item => String(item)) : [String(args.value ?? '')];
        const choice = values.map(item => item.trim()).filter(item => item && item !== '\u0000custom').join('\n');
        if (choice === 'vega:approve' || choice === 'vega:reject') {
          await api('control', { thread: args.agentId, id: taskId, action: 'approve', approved: choice === 'vega:approve' });
          return { accepted: true };
        }
        if (!choice || choice === 'vega:status') throw new Error('请先在输入框写下回复');
        await api('control', { thread: args.agentId, id: taskId, action: 'answer', text: choice });
        return { accepted: true };
      }
      case 'dismissWidget': return unsupported('dismissWidget');
      case 'getAgentTasks': return { tasks: [], tags: [] };
      case 'getTrays': case 'getAsyncTasks': case 'getSubagents': case 'getAgentAutomations': case 'takeTeachLearningPrompts': case 'getWorkflows': return [];
      case 'getForeverBoxStatus': case 'getBotTemplateForSourceAgent': return null;
      case 'getTeachRecordingStatus': return { state: 'idle' };
      case 'isEgressTunnelAvailable': return false;
      default: return unsupported(method);
    }
  }
  async function native(action, value = {}) {
    if (window.chrome?.webview) { window.chrome.webview.postMessage(JSON.stringify({ action, ...value })); return; }
    return unsupported('native window: ' + action);
  }
  function captionColors() {
    if (!window.chrome?.webview) return;
    requestAnimationFrame(() => {
      let element = document.elementFromPoint(innerWidth - 150, 25), background = 'rgb(255, 255, 255)';
      const foreground = element ? getComputedStyle(element).color : 'rgb(32, 32, 32)';
      for (; element; element = element.parentElement) {
        const color = getComputedStyle(element).backgroundColor;
        if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break; }
      }
      const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
      void native('caption', { colors: { background: rgb(background), foreground: rgb(foreground) } });
    });
  }
  const updateStatus = { state: { type: 'disabled', reason: 'not-packaged' }, delivery: 'in-app', currentVersion: 'Vega', currentTrack: 'stable', trackOverride: null, buildDefaultTrack: null, availableTracks: ['stable'], isTrackManagedByPolicy: false, isBelowMinimumVersion: false, autoUpdateWhenIdle: false };
  const methods = {
    subscribe(listeners) { desktopListeners.add(listeners); return () => desktopListeners.delete(listeners); },
    async getCursorAuthStatus() { const value = await boot; return value.paired ? { kind: 'logged-in', authId: value.account, displayName: 'Vega', profileReady: true } : { kind: 'logged-out' }; },
    getCursorLoginFlight: async () => ({ kind: 'idle' }),
    async loginCursor() { const value = await boot; location.assign(value.configURL); },
    getCursorAvatar: async () => null,
    getOnboardingSeen: async () => true,
    getSandAccess: async () => ({ state: 'granted' }), getSandAccessFresh: async () => ({ state: 'granted' }),
    getGrokBotTermsRecord: async () => ({ seenAtMs: 0 }),
    getCursorSelectedTeam: async () => ({ selectedTeamId: null, fallback: null }), listCursorTeamMemberships: async () => [],
    getThemeState: async () => theme(), async setThemePreference({ preference }) { if (!['system','light','dark'].includes(preference)) throw new Error('Invalid theme'); write('theme', preference); emitDesktop('theme-changed', theme()); captionColors(); return theme(); },
    getLanguageState: async () => language(),
    getExperimentsSnapshot: async () => experiments,
    getBotColorInChatEnabled: async () => true,
    getEgressTunnelEnabled: async () => false, getEgressTunnelForcedByAdmin: async () => false, getEgressTunnelStatus: async () => 'inactive', getWebauthnProxyEnabled: async () => false,
    setTitleBarOverlayTone: async () => captionColors(),
    getWindowState: async () => window.__vegaWindowState || { isFullscreen: false, isMaximized: false }, isWindowShown: async () => document.visibilityState === 'visible',
    minimizeWindow: () => native('minimize'), toggleMaximizeWindow: () => native('maximize'), closeWindow: () => native('close'), focusWindow: () => native('focus'),
    getHostSidebarSections: async () => read('sections', []), async setHostSidebarSections(args) { write('sections', args.sections); return args.sections; },
    getHostPinnedAgents: async () => read('pins', []), getServerPinnedAgents: async () => [], async setHostPinnedAgents(args) { write('pins', args.pinnedAgentIds); return args.pinnedAgentIds; },
    listGrokBotTeamAgents: async () => [], listGrokBotAgentSessions: async () => [],
    listSecrets: async () => ({ keys: [] }), getBoxHostPhase: async () => 'settled', getCursorTrainingSetting: async () => 'disallowed',
    getCredentialsState: async () => ({ hasValidCredentials: false }), getMcpState: async () => ({ servers: [] }),
    getUpdateStatus: async () => ({ ...updateStatus, currentVersion: (await boot).version }),
    getLocalToolPermission: async () => null, getTeamMemberPolicy: async () => null, getPendingRestartToUpdate: async () => null,
    getHardwareAcceleration: async () => ({ enabled: true }), getSpellCheckEnabled: async () => true,
    getTimeZone: async () => ({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, override: null }),
    getAutoReviewInstructions: async () => ({ isEnabled: false, allowInstructions: [], blockInstructions: [] }),
    hasMigratedClientPersistence: async () => true,
    readClientPersistence: async ({ key: name }) => read('persist:' + name),
    writeClientPersistence: async ({ key: name, value }) => write('persist:' + name, value),
    removeClientPersistence: async ({ key: name }) => localStorage.removeItem(key('persist:' + name)),
    listClientPersistenceKeys: async ({ prefix }) => Object.keys(localStorage).filter(name => name.startsWith(key('persist:' + prefix))).map(name => name.slice(key('persist:').length)),
    async readManyClientPersistence({ include, exclude }) {
      const length = (name, prefixes) => Math.max(-1, ...prefixes.filter(prefix => name.startsWith(prefix)).map(prefix => prefix.length));
      return Object.fromEntries(Object.keys(localStorage).filter(name => name.startsWith(key('persist:'))).map(name => [name.slice(key('persist:').length), JSON.parse(localStorage.getItem(name))]).filter(([name]) => length(name, include) >= 0 && length(name, include) >= length(name, exclude)));
    },
    stageAttachmentBytes: ({ filename, bytes }) => stage(filename, new Blob([bytes])),
    async commitStagedAttachments({ paths }) { if (!paths.every(path => staged.has(path))) throw new Error('附件已失效，请重新选择'); return paths; },
    async discardStagedAttachment({ path }) { staged.delete(path); },
    precaptionStagedAttachment: async () => null,
    async readAttachmentBytes({ path, maxBytes = 25 * 1024 * 1024 }) { const { name, file } = await attachment(path); return file.size > maxBytes ? { kind: 'too-large', size: file.size, resolvedName: name } : { kind: 'bytes', size: file.size, bytes: new Uint8Array(await file.arrayBuffer()), resolvedName: name }; },
    async readAttachmentText({ path }) { const { file } = await attachment(path); return file.type.startsWith('image/') ? { kind: 'binary', bytes: file.size } : { kind: 'text', text: await file.text(), bytes: file.size }; },
    async resolveAttachmentMedia({ source }) { const { file } = await attachment(source); return /^(image|video|audio)\//.test(file.type) ? { kind: file.type.split('/')[0], src: await dataURL(file), width: null, height: null } : null; },
    async downloadAttachment({ path, suggestedName }) { const { name, file } = await attachment(path); const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = suggestedName || name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); },
    async setViewingAgent({ agentId }) { selected = agentId; if (agentId) await api('read', { thread: agentId }); },
    async openExternal({ url }) { if (!/^https?:\/\//.test(url)) throw new Error('Only HTTP(S) links are allowed'); await api('external', { url }); },
    async updateGrokBotAgent(args) {
      if (args?.avatarPngBase64) throw Object.assign(new Error('Vega 的头像使用内置样式，不能从这里上传图片'), { code: 'source/capability-unavailable' });
      const changed = args?.changed || {};
      const serverId = String(args?.serverId || '');
      const employeeId = serverId.startsWith('employee:') ? serverId.slice('employee:'.length) : serverId;
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(employeeId)) throw new Error('Invalid employee');
      if (typeof changed.publicDescription === 'string' && changed.publicDescription.trim() && changed.publicDescription !== changed.description)
        throw new Error('没有单独的公开工作原则；请写在工作原则里');
      const body = { action: 'employee', employeeId };
      if (typeof changed.name === 'string') body.name = changed.name;
      if (typeof changed.description === 'string') body.instruction = changed.description;
      if (body.name === undefined && body.instruction === undefined) {
        if (changed.publicDescription !== undefined || changed.title !== undefined) throw new Error('客户端只保存姓名和工作原则');
        return {};
      }
      const saved = await api('settings', body);
      await refreshRoster();
      event('server-roster-changed', { kind: 'resync' });
      return { updatedAtMs: Date.now(), name: saved.employee?.name, description: saved.employee?.instruction || '' };
    },
  };
  // Populate enumerable methods from the bundled preload contract: the renderer deliberately ignores Proxy-only properties.
  const housekeeping = new Set(['setOnboardingSeen','setTitleBarOverlayTone','setComposingAgent','setComputerViewOpen','setUnreadFilterMenuChecked','signalBoxIntent','markDeepLinksReady','clearLocalToolApprovals','claimEgressTunnel']);
  for (const name of window.__vegaDesktopMethods || []) {
    if (!Object.hasOwn(methods, name)) methods[name] = (...args) => name.startsWith('report') || name.startsWith('note') || name.startsWith('expose') || name.startsWith('log') || housekeeping.has(name) ? Promise.resolve() : Promise.reject(Object.assign(new Error('Vega 尚未接入此功能：' + name), { code: 'source/capability-unavailable' }));
  }
  window.desktop = { main: methods, boot: { theme: theme(), language: language(), isAssistiveTechEnabled: false, isEgressTunnelEnabled: false, isWebauthnProxyEnabled: false, isBotColorInChatEnabled: true, egressTunnelStatus: 'inactive', rosterPhotos: null, computerUseHelperName: null, experiments },
    environment: { platform: 'win32', isDev: false, isWaylandClient: false, usesProductionBackend: false, devVoiceHarness: 'package' },
    local: { getZoomFactor: () => 1, noteRendererAlive() {}, noteBootGateLanded() {}, noteBootGateOpened() {}, stageAttachmentFile: stage } };
  window.coordinatorPort = { claim(handler) {
    let channel = null;
    const request = () => {
      if (channel) return;
      channel = new MessageChannel(); const server = channel.port2; ports.add(server);
      server.onmessage = async ({ data }) => {
        if (data.kind === 'lifecycle' && data.phase === 'hello') { server.postMessage({ kind: 'lifecycle', phase: 'ready', protocolVersion: 3 }); server.postMessage({ kind: 'event', family: 'coordinator-transport-state', payload: { state: 'connected' } }); return; }
        if (data.kind !== 'request') return;
        let outcome;
        try { outcome = { status: 'ok', value: await coordinator(data.method, data.args) }; }
        catch (error) { outcome = { status: 'failed', failure: { code: error.code || 'internal', message: error.message } }; }
        server.postMessage({ kind: 'reply', requestId: data.requestId, outcome });
      };
      boot.then(value => handler.onPort({ accountSlot: value.account, postMessage: message => channel?.port1.postMessage(message), start: () => channel?.port1.start(), close() { ports.delete(server); channel?.port1.close(); server.close(); channel = null; }, addEventListener: (name, callback) => channel?.port1.addEventListener(name, callback) }));
    };
    return { request, release() { if (channel) { ports.delete(channel.port2); channel.port1.close(); channel.port2.close(); channel = null; } } };
  } };
  window.sandPopout = { agentId: null }; window.sandSpotlight = { isSpotlight: false };
  async function poll() {
    if (polling || document.visibilityState === 'hidden' || !host?.paired) return;
    polling = true;
    try {
      const previous = JSON.stringify(roster); await refreshRoster();
      if (previous !== JSON.stringify(roster)) event('server-roster-changed', { kind: 'resync' });
      for (const [id, state] of watched) {
        if (id !== selected) continue;
        const data = await api('messages', { thread: id, after: state.lastSeq });
        if ((data.lastSeq || 0) < state.lastSeq) { watched.delete(id); event('transcript', { agentId: id, type: 'cleared' }); continue; }
        applyEntries(id, state, entriesOf(data.messages || [], id, data.live));
        refreshTasks(id, state, data.taskStatus);
        state.lastSeq = data.lastSeq || 0;
      }
    } catch (error) { console.warn('[Vega bridge]', error.message); }
    finally { polling = false; }
  }
  window.__vegaWindowChanged = state => { window.__vegaWindowState = state; emitDesktop('window-state', state); };
  setInterval(poll, 1500);
  addEventListener('focus', () => { emitDesktop('window-focus', {}); void poll(); });
  document.addEventListener('visibilitychange', () => emitDesktop('window-visibility', { visible: document.visibilityState === 'visible' }));
  function resizeEdge(x, y, width, height) {
    if (window.__vegaWindowState?.isMaximized) return 0;
    const left = x < 6, right = x >= width - 6, top = y < 6, bottom = y >= height - 6;
    return top && left ? 13 : top && right ? 14 : bottom && left ? 16 : bottom && right ? 17 : left ? 10 : right ? 11 : top ? 12 : bottom ? 15 : 0;
  }
  document.addEventListener('pointermove', e => {
    if (!window.chrome?.webview) return;
    const cursor = { 10: 'ew-resize', 11: 'ew-resize', 12: 'ns-resize', 13: 'nwse-resize', 14: 'nesw-resize', 15: 'ns-resize', 16: 'nesw-resize', 17: 'nwse-resize' }[resizeEdge(e.clientX, e.clientY, innerWidth, innerHeight)];
    if (cursor) document.documentElement.style.cursor = cursor; else document.documentElement.style.removeProperty('cursor');
  });
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !window.chrome?.webview) return;
    const edge = resizeEdge(e.clientX, e.clientY, innerWidth, innerHeight);
    if (edge) { e.preventDefault(); e.stopPropagation(); void native('resize', { edge }); return; }
    for (let element = e.target; element instanceof Element; element = element.parentElement) {
      const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
      if (region === 'no-drag') return;
      if (region === 'drag') { void native(e.detail === 2 ? 'maximize' : 'drag'); return; }
    }
  }, true);
})();
