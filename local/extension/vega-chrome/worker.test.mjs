import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const timers = new Set();
const setTimeout = (fn, ms, ...args) => {
  const timer = globalThis.setTimeout(fn, ms, ...args);
  timers.add(timer);
  return timer;
};
const clearTimeout = timer => {
  timers.delete(timer);
  globalThis.clearTimeout(timer);
};
const setInterval = (fn, ms, ...args) => {
  const timer = globalThis.setInterval(fn, ms, ...args);
  timers.add(timer);
  return timer;
};
const clearInterval = timer => {
  timers.delete(timer);
  globalThis.clearInterval(timer);
};
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  for (const timer of timers) {
    globalThis.clearTimeout(timer);
    globalThis.clearInterval(timer);
  }
  timers.clear();
});

const settleProbe = params => String(params?.expression || '').includes("addEventListener('resize'");
const event = () => ({
  listeners: [],
  addListener(fn) { this.listeners.push(fn); },
  emit(...args) { for (const fn of this.listeners) fn(...args); },
});

function createHarness(overrides = {}) {
  const cdpCalls = [];
  let tab = { id: 11, windowId: 5, url: 'https://example.com', title: 'Example', active: true, status: 'complete', groupId: -1, incognito: false };
  let win = { id: 5, state: 'normal', incognito: false };
  const chrome = {
    downloads: { search: async () => [] },
    extension: { isAllowedIncognitoAccess: async () => true },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      query: async () => [tab],
      get: async () => ({ ...tab }),
      update: async (_id, props) => { Object.assign(tab, props); return { ...tab }; },
      create: async props => ({ ...tab, id: 12, url: props.url || 'about:blank' }),
      remove: async () => {},
      group: async () => 1,
      ungroup: async () => {},
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event(),
      ...overrides.tabs,
    },
    tabGroups: { query: async () => [], update: async () => {} },
    windows: {
      get: async () => ({ ...win }),
      getAll: async () => [{ ...win }],
      update: async (_id, props) => { win = { ...win, ...props }; return { ...win }; },
      create: async props => ({ id: 6, incognito: !!props.incognito, tabs: [{ ...tab, id: 13, url: props.url }] }),
      ...overrides.windows,
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method, params) => {
        cdpCalls.push([method, params]);
        if (overrides.onCdp) {
          const out = await overrides.onCdp(method, params, chrome);
          if (out !== undefined) return out;
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Page.captureScreenshot') return { data: 'jpegdata' };
        if (method === 'Runtime.evaluate') {
          const expr = String(params?.expression || '');
          if (expr.includes('__novaBrowser.resolve(')) return { result: { value: { x: 240, y: 120, rect: [200, 100, 80, 40], name: 'Search', editable: true } } };
          if (expr.includes('__novaBrowser.observe(')) return { result: { value: { url: tab.url, title: tab.title, readyState: 'complete', viewport: [1280, 800, 1], scroll: [0, 0, 1280, 800], cursor: [240, 120], items: [], text: 'hello', observeMs: 3 } } };
          if (expr.includes('document.readyState')) return { result: { value: 'complete' } };
          return { result: { value: true } };
        }
        return {};
      },
      onEvent: event(),
      onDetach: event(),
    },
    webNavigation: { onCreatedNavigationTarget: event() },
    runtime: {
      id: 'ext-id',
      getManifest: () => ({ version: '0.2.5' }),
      getPlatformInfo: async () => ({ os: 'win' }),
      reload: () => {},
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    alarms: { onAlarm: event(), create: async () => {} },
  };
  class DummyWS {
    constructor() { this.readyState = 3; }
    close() {}
  }
  const scope = {
    chrome,
    crypto: webcrypto,
    URL,
    AbortController,
    AbortSignal,
    WebSocket: overrides.WebSocket || DummyWS,
    fetch: overrides.fetch || (async () => { throw Error('offline'); }),
    navigator: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  return { scope, chrome, cdpCalls, setTab: p => Object.assign(tab, p), setWin: p => Object.assign(win, p) };
}

test('worker executes pointer-driven click + type(focus, clear, submit) + JPEG view in one atomic command', async () => {
  const { scope, cdpCalls } = createHarness();
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(src + '\nglobalThis.__exec = executeCommand;', scope);
  const { tabs } = await scope.__exec('tabs', {});
  const tag = tabs[0].tag;

  const res = await scope.__exec('act', {
    tabTag: tag,
    steps: [{ op: 'type', id: 1, text: 'vega', clear: true, submit: true }],
    viewOpts: { screenshot: true },
  });

  assert.equal(res.ok, true);
  assert.equal(res.completed, 1);
  assert.equal(res.view.screenshotB64, 'jpegdata');
  const methods = cdpCalls.map(([m, p]) => m === 'Input.dispatchMouseEvent' ? `${m}:${p.type}` : m === 'Input.dispatchKeyEvent' ? `${m}:${p.type}:${p.key}` : m);
  assert.ok(methods.includes('Input.dispatchMouseEvent:mouseMoved'), 'must move mouse pointer');
  assert.ok(methods.includes('Input.dispatchMouseEvent:mousePressed'), 'type with target must click to focus');
  assert.ok(methods.includes('Input.dispatchMouseEvent:mouseReleased'), 'must release click');
  assert.ok(methods.includes('Input.insertText'), 'must insert text');
  assert.ok(methods.includes('Input.dispatchKeyEvent:keyDown:Enter'), 'submit=true must press Enter');
  assert.ok(cdpCalls.some(([m, p]) => m === 'Page.captureScreenshot' && p.format === 'jpeg'), 'captures fast JPEG');
});

test('worker dismiss clicks safe blank outsidePoint and hides cursor cleanly on cursor_hide & screenshots', async () => {
  let overlayOpen = true;
  const { scope, cdpCalls } = createHarness({
    onCdp: async (method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression || '').includes('__novaBrowser.overlayState()')) {
        const res = overlayOpen ? { open: true, kind: 'popover', outsidePoint: [420, 90] } : { open: false };
        return { result: { value: res } };
      }
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && params.x === 420 && params.y === 90) {
        overlayOpen = false;
      }
      return undefined;
    },
  });
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(src + '\nglobalThis.__exec = executeCommand;', scope);
  const { tabs } = await scope.__exec('tabs', {});
  const tag = tabs[0].tag;

  const res = await scope.__exec('act', { tabTag: tag, steps: [{ op: 'dismiss' }], viewOpts: { screenshot: true } });
  assert.equal(res.ok, true);
  assert.equal(res.completed, 1);
  assert.equal(overlayOpen, false, 'dismiss must close overlay by clicking outsidePoint');
  assert.ok(cdpCalls.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed' && p.x === 420 && p.y === 90));
  assert.ok(cdpCalls.some(([m, p]) => m === 'Runtime.evaluate' && String(p?.expression || '').includes('cursor?.show?.(')), 'cursor is shown continuously while session operates');
  assert.ok(!cdpCalls.some(([m, p]) => m === 'Runtime.evaluate' && String(p?.expression || '').includes('setShotHidden?.(true)')), 'cursor never blinks off during screenshots');

  await scope.__exec('cursor_hide', { tabTag: tag });
  assert.ok(cdpCalls.some(([m, p]) => m === 'Runtime.evaluate' && String(p?.expression || '').includes('cursor?.dismiss?.(false)')));

  cdpCalls.length = 0;
  await scope.__exec('view', { tabTag: tag, viewOpts: { screenshot: true, clean: true } });
  const evalExprs = cdpCalls.filter(([m]) => m === 'Runtime.evaluate').map(([, p]) => String(p?.expression || ''));
  assert.ok(evalExprs.some(e => e.includes('cursor?.dismiss?.(true)')), 'clean=true temporarily hides virtual cursor for evidence shot');
  assert.ok(evalExprs.some(e => e.includes('cursor?.show?.(')), 'clean=true restores virtual cursor after shot');
});

test('worker scroll targets SPA primary scroll container and verifies/falls back scroll delta', async () => {
  const { scope, cdpCalls } = createHarness({
    onCdp: async (method, params) => {
      const expr = String(params?.expression || '');
      if (method === 'Runtime.evaluate' && expr.includes('__novaBrowser.scrollTarget(')) {
        return { result: { value: { x: 897, y: 408, top: 0, left: 0, maxY: 1850 } } };
      }
      if (method === 'Runtime.evaluate' && expr.includes('__novaBrowser.verifyOrFallbackScroll(')) {
        return { result: { value: { beforeTop: 0, afterTop: 600, beforeLeft: 0, afterLeft: 0, maxY: 1850 } } };
      }
      return undefined;
    },
  });
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(src + '\nglobalThis.__exec = executeCommand;', scope);
  const { tabs } = await scope.__exec('tabs', {});
  const res = await scope.__exec('act', {
    tabTag: tabs[0].tag,
    steps: [{ op: 'scroll', dy: 600 }],
    viewOpts: { screenshot: false },
  });
  assert.equal(res.ok, true);
  assert.equal(res.actions[0], 'scrolled y: 0 -> 600/1850');
  assert.ok(cdpCalls.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mouseWheel' && p.x === 897 && p.y === 408 && p.deltaY === 600));
});

test('worker promotes iframe overlay & scrollInfo and routes dismiss/scroll into child iframe', async () => {
  let iframeOverlayOpen = true;
  const { scope, cdpCalls } = createHarness({
    onCdp: async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main-frame' }, childFrames: [{ frame: { id: 'child-frame' } }] } };
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: params.frameId === 'child-frame' ? 9 : 7 };
      }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'iframe-obj' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: [200, 100, 1, 1] } };
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression || '');
        const isChild = params?.contextId === 9;
        if (expr.includes('__novaBrowser.observe(')) {
          if (!isChild) {
            return { result: { value: { url: 'https://example.com', title: 'Host', readyState: 'complete', viewport: [1280, 800, 1], scroll: [0, 0, 1280, 800], scrollInfo: { y: 0, maxY: 0, viewH: 800, totalH: 800, moreBelow: 0 }, hasIframes: true, items: [], text: '' } } };
          }
          return { result: { value: { url: 'https://app.example.com', title: 'App', readyState: 'complete', viewport: [900, 600, 1], scroll: [0, 0, 900, 1800], scrollInfo: { y: 0, maxY: 1200, viewH: 600, totalH: 1800, moreBelow: 1200, containerId: 2 }, overlay: { kind: 'popover', rect: [100, 80, 300, 200], hasConfirm: false, outsidePoint: [50, 40] }, items: [{ id: 1, role: 'checkbox', name: 'US', x: 150, y: 120, rect: [140, 110, 20, 20], inView: true, inOverlay: true }], text: 'inside' } } };
        }
        if (expr.includes('__novaBrowser.overlayState()')) {
          if (!isChild) return { result: { value: { open: false } } };
          return { result: { value: iframeOverlayOpen ? { open: true, outsidePoint: [50, 40] } : { open: false } } };
        }
        if (expr.includes('__novaBrowser.scrollTarget(') && isChild) {
          return { result: { value: { x: 400, y: 300, top: 0, left: 0, maxY: 1200 } } };
        }
        if (expr.includes('__novaBrowser.verifyOrFallbackScroll(') && isChild) {
          return { result: { value: { beforeTop: 0, afterTop: 500, beforeLeft: 0, afterLeft: 0, maxY: 1200 } } };
        }
      }
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && params.x === 250 && params.y === 140) {
        iframeOverlayOpen = false;
      }
      return undefined;
    },
  });
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(src + '\nglobalThis.__exec = executeCommand;', scope);
  const { tabs } = await scope.__exec('tabs', {});
  const tag = tabs[0].tag;

  const view = await scope.__exec('view', { tabTag: tag, viewOpts: { screenshot: false } });
  assert.equal(JSON.stringify(view.overlay.outsidePoint), JSON.stringify([250, 140]), 'iframe overlay outsidePoint transformed to top-level');
  assert.equal(view.scrollInfo.moreBelow, 1200, 'iframe scrollInfo promoted when top frame does not scroll');

  const act = await scope.__exec('act', { tabTag: tag, steps: [{ op: 'dismiss' }, { op: 'scroll', dy: 500 }], viewOpts: { screenshot: false } });
  assert.equal(act.ok, true);
  assert.equal(iframeOverlayOpen, false, 'dismiss clicked top-level transformed point (250,140) to close iframe overlay');
  assert.equal(act.actions[1], 'scrolled y: 0 -> 500/1200', 'scroll routed into child iframe');
  assert.ok(cdpCalls.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mouseWheel' && p.x === 600 && p.y === 400 && p.deltaY === 500));
});

test('worker probes /health then /pair and only opens authenticated WebSocket to live Vega ports without duplicate probes', async () => {
  const probed = [];
  const paired = [];
  const wsUrls = [];
  class RecordingWS {
    constructor(url) {
      wsUrls.push(url);
      this.readyState = 1;
    }
    close() {}
  }
  const { scope } = createHarness({
    WebSocket: RecordingWS,
    fetch: async (url, opts) => {
      if (url.endsWith('/health')) {
        probed.push([url, opts.method]);
        if (url === 'http://127.0.0.1:47753/health') {
          if (opts.method === 'GET') return { ok: false, status: 403 };
          return { ok: true, json: async () => ({ ok: true, app: 'vega', version: '0.2.5' }) };
        }
        if (url === 'http://127.0.0.1:47754/health') {
          return { ok: true, json: async () => ({ ok: true, app: 'other-service' }) };
        }
        if (url === 'http://127.0.0.1:47755/health') return { ok: false, status: opts.method === 'GET' ? 403 : 405 };
        throw new TypeError('Failed to fetch');
      }
      if (url.endsWith('/pair')) {
        paired.push(url);
        return { ok: true, json: async () => ({ token: 't'.repeat(32), app: 'vega' }) };
      }
      throw Error('unexpected request');
    },
  });
  const src = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(src + '\nglobalThis.__loop = loop;', scope);
  scope.__loop();
  await new Promise(resolve => globalThis.setTimeout(resolve, 40));

  assert.equal(probed.filter(([, method]) => method === 'GET').length, 10);
  assert.deepEqual(probed.filter(([, method]) => method === 'POST').map(([url]) => url).sort(), ['http://127.0.0.1:47753/health', 'http://127.0.0.1:47755/health']);
  assert.deepEqual(paired, ['http://127.0.0.1:47753/pair'], 'only live Vega port pairs');
  assert.equal(wsUrls.length, 1, 'only live Vega port opens a WebSocket');
  assert.ok(wsUrls[0].startsWith('ws://127.0.0.1:47753/ws?clientId='));
  assert.ok(wsUrls[0].includes('token=' + 't'.repeat(32)));
});

test('native downloads expose progress, interruption and completion without tab guesses or replay', async () => {
  let query, calls = 0;
  let item = { id: 42, url: 'blob:https://example.com/export', filename: 'C:/Downloads/报告.csv', state: 'in_progress', bytesReceived: 0, totalBytes: -1, incognito: false };
  const chrome = {
    downloads: { search: async q => { query = q; calls++; return [item]; } },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [], onRemoved: event(), onReplaced: event(), onUpdated: event() },
    debugger: { onEvent: event(), onDetach: event() },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { onAlarm: event() },
  };
  const scope = { chrome, crypto: webcrypto, URL, AbortSignal, AbortController, setTimeout, clearTimeout, fetch: async () => { throw Error('offline'); } };
  runInNewContext(await readFile(new URL('./worker.js', import.meta.url), 'utf8') + '\nglobalThis.run=args=>execute({operation:"downloads",args,expiresAt:Date.now()+3000});', scope);
  const first = await scope.run({ since: 0 });
  assert.equal(first.scope, 'browser');
  assert.equal(first.downloads[0].state, 'in_progress');
  assert.equal(first.downloads[0].totalBytes, -1);
  assert.equal(query.startedAfter, '1970-01-01T00:00:00.000Z');
  assert.equal(query.limit, 100);
  item = { ...item, state: 'interrupted', bytesReceived: 512, error: 'NETWORK_FAILED', canResume: true };
  const failed = await scope.run({ downloadId: '42', since: -1 });
  assert.equal(query.id, 42);
  assert.equal(query.startedAfter, undefined);
  assert.equal(failed.downloads[0].error, 'NETWORK_FAILED');
  item = { ...item, state: 'complete', bytesReceived: 1024, totalBytes: 1024, error: undefined, exists: true };
  const done = await scope.run({ downloadId: '42' });
  assert.equal(done.downloads[0].state, 'complete');
  assert.equal(done.downloads[0].path, item.filename);
  assert.equal(done.downloads[0].error, null);
  assert.equal((await scope.run({ incognito: true })).downloads.length, 0);
  for (const args of [{ since: -1 }, { since: '1' }, { since: 8640000000000001 }, { downloadId: 'oops' }, { downloadId: '9007199254740992' }, { incognito: 'true' }]) {
    await assert.rejects(scope.run(args));
  }
  assert.equal(calls, 4, 'invalid inputs must not query or trigger downloads');
  delete chrome.downloads;
  await assert.rejects(scope.run({}), /Vega Chrome/);
  assert.match(done.notice, /state=complete/);
});

test('screenshots reveal a minimized window or background tab instead of hanging', async () => {
  const calls = [];
  let win = { id: 5, state: 'minimized' };
  const tab = { id: 11, windowId: 5, url: 'https://example.com', active: false };
  const chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [tab], get: async () => ({ ...tab }), update: async (id, props) => { calls.push(['tab', id, props]); Object.assign(tab, props); }, onRemoved: event(), onReplaced: event(), onUpdated: event() },
    windows: { get: async () => ({ ...win }), update: async (id, props) => { calls.push(['window', id, props]); win = { ...win, ...props }; } },
    debugger: { attach: async () => {}, sendCommand: async (_t, method, params) => { if (settleProbe(params)) return {}; calls.push(['cdp', method]); return { data: 'png' }; }, onEvent: event(), onDetach: event() },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { onAlarm: event() },
  };
  const scope = { chrome, crypto: webcrypto, URL, AbortSignal, AbortController, setTimeout, clearTimeout, fetch: async () => { throw Error('offline'); } };
  runInNewContext(await readFile(new URL('./worker.js', import.meta.url), 'utf8') +
    '\nglobalThis.run=async method=>execute({operation:"cdp",args:{tabTag:(await inventory())[0].tag,method},expiresAt:Date.now()+3000});', scope);
  assert.equal((await scope.run('Page.captureScreenshot')).data, 'png');
  assert.equal(
    JSON.stringify(calls.filter(([k, v]) => k !== 'cdp' || v === 'Page.captureScreenshot' || v === 'Runtime.evaluate')),
    JSON.stringify([['window', 5, { state: 'normal' }], ['tab', 11, { active: true }], ['cdp', 'Page.captureScreenshot']]),
  );
  calls.length = 0;
  await scope.run('Page.captureScreenshot');
  await scope.run('Runtime.evaluate');
  assert.equal(JSON.stringify(calls), JSON.stringify([['cdp', 'Page.captureScreenshot'], ['cdp', 'Runtime.evaluate']]), 'visible tabs and other commands are left alone');
});

test('devtools and debug record console replay, exceptions and network, filter, fetch bodies and reset on detach', async () => {
  const tab = { id: 11, windowId: 5, url: 'https://example.com', active: true };
  const sent = [];
  const chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [tab], get: async () => ({ ...tab }), onRemoved: event(), onReplaced: event(), onUpdated: event() },
    debugger: {
      attach: async () => {},
      sendCommand: async (_target, method) => {
        sent.push(method);
        const emit = (m, p) => chrome.debugger.onEvent.emit({ tabId: 11 }, m, p);
        if (method === 'Runtime.enable') emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'old' }, { type: 'object', preview: { properties: [{ name: 'a', value: '1' }] } }], timestamp: 1 });
        if (method === 'Network.getResponseBody') return { body: '{"ok":1}', base64Encoded: false };
        return {};
      },
      onEvent: event(),
      onDetach: event(),
    },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { onAlarm: event() },
  };
  const scope = { chrome, crypto: webcrypto, URL, AbortSignal, AbortController, setTimeout, clearTimeout, fetch: async () => { throw Error('offline'); } };
  runInNewContext(await readFile(new URL('./worker.js', import.meta.url), 'utf8') +
    '\nglobalThis.run=async devtools=>execute({operation:"debug",args:{tabTag:(await inventory())[0].tag,...devtools},expiresAt:Date.now()+3000});', scope);
  const first = await scope.run();
  assert.equal(first.console.items[0].text, 'old {a: 1}', 'console history replayed by Runtime.enable');
  assert.equal(first.network.total, 0);
  const emit = (m, p, source = { tabId: 11 }) => chrome.debugger.onEvent.emit(source, m, p);
  emit('Runtime.exceptionThrown', { timestamp: 2, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x' }, url: 'https://example.com/a.js', lineNumber: 9 } });
  emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: 'https://example.com/api', postData: 'q=1' }, type: 'XHR', timestamp: 10, wallTime: 1000 });
  emit('Network.responseReceived', { requestId: 'r1', type: 'XHR', response: { status: 500, statusText: 'Err', mimeType: 'application/json' } });
  emit('Network.loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 7 });
  emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'GET', url: 'https://example.com/ok.png' }, type: 'Image', timestamp: 11, wallTime: 1001 });
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'iframe' }], timestamp: 3 }, { tabId: 11, sessionId: 'child' });
  const errors = await scope.run({ level: 'error' });
  assert.equal(errors.console.items.length, 1);
  assert.equal(errors.console.items[0].text, 'TypeError: x');
  assert.equal(errors.console.items[0].line, 10);
  assert.equal(errors.network.items.length, 1);
  assert.equal(errors.network.items[0].status, 500);
  assert.equal(errors.network.items[0].durationMs, 250);
  assert.equal(errors.network.items[0].postData, 'q=1');
  assert.equal((await scope.run({ kind: 'network', query: 'png' })).network.items[0].requestId, 'r2');
  assert.equal((await scope.run({ kind: 'network' })).console, undefined);
  assert.equal((await scope.run({ requestId: 'r1' })).body, '{"ok":1}');
  await assert.rejects(scope.run({ requestId: 'missing' }), /requestId/);
  for (const bad of [{ kind: 'dom' }, { limit: 0 }, { query: 1 }]) await assert.rejects(scope.run(bad));
  assert.equal(sent.filter(m => ['Runtime.enable', 'Log.enable', 'Network.enable'].includes(m)).length, 3, 'domains are enabled once per debugger session');
  assert.equal((await scope.run({ clear: true })).console.total, 2);
  assert.equal((await scope.run()).console.total, 0);
  chrome.debugger.onDetach.emit({ tabId: 11 });
  await scope.run();
  assert.equal(sent.filter(m => ['Runtime.enable', 'Log.enable', 'Network.enable'].includes(m)).length, 6, 're-enabled after detach');
});

test('a stuck debugger command times out, polling resumes and late results are not replayed', async () => {
  const replies = [];
  let polls = 0, calls = 0, finishCommand;
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => false },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [{ id: 11, url: 'https://example.com', active: true }], get: async () => ({ id: 11 }), onRemoved: event(), onReplaced: event(), onUpdated: event() },
    debugger: { attach: async () => {}, sendCommand: (_t, method, params) => { if (settleProbe(params) || method === 'Page.enable' || method === 'Page.getFrameTree') return Promise.resolve({}); calls++; return new Promise(resolve => { finishCommand = resolve; }); }, onDetach: event(), onEvent: event() },
    runtime: { id: 'test', onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { onAlarm: event() },
  };
  const scope = {
    chrome, crypto: webcrypto, URL, AbortSignal, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const endpoint = new URL(url);
      if (endpoint.port !== '47753') throw Error('offline');
      if (endpoint.pathname === '/health') return { ok: true, json: async () => ({ ok: true, app: 'vega' }) };
      if (endpoint.pathname === '/pair') return { ok: true, json: async () => ({ token: 't'.repeat(32), app: 'vega' }) };
      if (endpoint.pathname === '/reply') { replies.push(JSON.parse(options.body)); return { ok: true }; }
      if (polls++ >= 2) return new Promise(() => {});
      const [tab] = await scope.api.inventory();
      const command = polls === 1
        ? { id: 'stuck', operation: 'cdp', args: { tabTag: tab.tag, method: 'Runtime.evaluate' }, expiresAt: Date.now() + 50 }
        : { id: 'next', operation: 'tabs', args: {}, expiresAt: Date.now() + 3000 };
      return { ok: true, json: async () => ({ command }) };
    },
  };
  const source = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(source + '\nglobalThis.api={inventory,debuggerCall};', scope);
  for (let i = 0; i < 100 && replies.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replies.length, 2);
  assert.match(replies[0].error, /响应超时.*不要重放/);
  assert.equal(replies[1].result.tabs.length, 1);
  finishCommand({ late: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(replies.length, 2);
  let slowCalls = 0;
  assert.equal(await scope.api.debuggerCall({ expiresAt: Date.now() + 10000 }, async () => {
    slowCalls++; await new Promise(resolve => setTimeout(resolve, 100)); return 'ready';
  }), 'ready');
  assert.equal(slowCalls, 1);
});

test('navigation target events, multiple instances, reconnect, miniapps and attach settle', async () => {
  const tabs = [{ id: 11, windowId: 5, url: 'https://example.com/source', active: true }];
  const sent = [], delays = [], posts = [];
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => false },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async filter => structuredClone(filter?.active ? tabs.filter(t => t.active) : tabs), get: async id => tabs.find(t => t.id === id), onRemoved: event(), onReplaced: event(), onUpdated: event() },
    webNavigation: { onCreatedNavigationTarget: event() },
    debugger: { attach: async () => { sent.push('attach'); }, sendCommand: async (_t, method, params) => { sent.push(settleProbe(params) ? 'settle' : method); return {}; }, onEvent: event(), onDetach: event() },
    runtime: { id: 'test', getURL: p => p, onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { onAlarm: event() },
  };
  const scope = {
    chrome, crypto: webcrypto, URL, AbortSignal, AbortController, clearTimeout,
    setTimeout: (fn, ms, ...args) => { delays.push(ms); return setTimeout(fn, ms, ...args); },
    fetch: async () => { throw Error('offline'); },
  };
  runInNewContext(await readFile(new URL('./worker.js', import.meta.url), 'utf8') + '\nglobalThis.api={inventory,execute,launchMiniapp,instances,globMatch,newer};', scope);

  const [source] = await scope.api.inventory();
  chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 22, sourceTabId: 11, sourceFrameId: 0, url: 'https://example.com/child' });
  tabs.push({ id: 22, windowId: 5, url: 'https://example.com/child', active: false });
  const child = (await scope.api.inventory()).find(t => t.tag !== source.tag);
  assert.equal(child.openerTag, source.tag);

  scope.api.instances.set('fixture', async (path, body) => { posts.push({ path, body }); return { ok: true }; });
  await scope.api.launchMiniapp({ origin: 'fixture', appId: 'app', tabTag: child.tag }, tabs[0]);
  assert.equal(posts[0].path, '/miniapp/launch');
  assert.equal(posts[0].body.tabTag, source.tag);

  assert.ok(scope.api.globMatch('https://github.com/*/pull/*', 'https://github.com/a/b/pull/1?x=1'));
  assert.equal(scope.api.newer('0.2.5', '0.2.0'), true);
  assert.equal(scope.api.newer('0.1.9', '0.2.5'), false);

  await scope.api.execute({ operation: 'cdp', args: { tabTag: source.tag, method: 'Runtime.evaluate' }, expiresAt: Date.now() + 3000 });
  await scope.api.execute({ operation: 'cdp', args: { tabTag: source.tag, method: 'Input.dispatchMouseEvent' }, expiresAt: Date.now() + 3000 });
  assert.equal(JSON.stringify(sent.filter(s => s !== 'Page.enable' && s !== 'Page.getFrameTree')), JSON.stringify(['attach', 'settle', 'Runtime.evaluate', 'Input.dispatchMouseEvent']));
  assert.ok(delays.includes(300000), 'idle detach after five minutes');
});
