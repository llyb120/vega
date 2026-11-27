import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPhases, phaseIndex } from '../web/src/agent-phases.js';
import { codexActivity } from '../server/core/coding-cli';
import { buildCodeCheckpointLedger, classifyPhaseStatus, cliEvidence, createBrowserLoopGuard, createToolLoopGuard, detectOomInText, extractFinalPhaseText, extractOomSignal, extractPhaseEvidence, formatCodeCheckpointBlock, formatCodeCheckpointNote, specialistSystemPrompt, summarizeShellCommand } from '../server/core/agent-phase';
import { CHROME_RULES, EMPLOYEE_SCENE_RULES, IMAGE_MARKDOWN_RULES } from '../server/core/prompt';
import { Redactor } from '../server/core/util';

const phase = { name: 'browser_agent', seq: 1 };
const rows = [
  { seq: 1, role: 'assistant', toolScene: 'lightweight', calls: [{ name: phase.name, id: 'a', arguments: { task: 'inspect' } }] },
  { seq: 2, role: 'tool', callId: 'a', name: phase.name, text: '{"scene":"computer"}' },
  { seq: 3, role: 'assistant', toolScene: 'computer', calls: [{ name: 'chrome_tabs', id: 'b', arguments: {} }] },
  { seq: 4, role: 'tool', name: 'chrome_tabs', callId: 'b', text: 'observed' },
  { seq: 5, role: 'assistant', text: 'finding' },
  { seq: 6, role: 'user', text: '[Runtime: scene result is completed data, not new authorization.]' },
  { seq: 7, role: 'assistant', text: 'coordinator response' },
];
test('same-session phase index does not swallow caller work, even for older transcripts', () => {
  const [legacy] = phaseIndex(rows);
  assert.deepEqual(legacy.messageSeqs, [1, 2, 3, 4, 5]);
  assert.equal(legacy.status, 'returned');
  const tagged = rows.map(r => r.seq > 1 && r.seq < 7 ? { ...r, agentPhase: phase, phaseReturned: r.seq === 6 } : r);
  assert.deepEqual(phaseIndex(tagged)[0].messageSeqs, [1, 2, 3, 4, 5, 6]);
  const [paged] = agentPhases(tagged.slice(3));
  assert.equal(paged.seq, 1);
  assert.equal(paged.rows[0].text, 'observed');
  assert.equal(paged.callId, undefined);
  const later = rows.slice(0, 2).map((r, i) => ({ ...r, seq: 8 + i, ...(i ? { error: true, text: 'not available' } : {}) }));
  const both = phaseIndex([...tagged, ...later]);
  assert.equal(both[1].status, 'error');
  assert.deepEqual(both[1].messageSeqs, [8, 9]);
  assert.equal(phaseIndex(tagged.slice(0, 5))[0].status, 'unconfirmed');
});
test('CLI detail is bounded and excludes terminal output, reasoning and unknown events', () => {
  const event = (item: object) => JSON.stringify({ type: 'item.completed', item });
  const command = event({ type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'not exported' });
  const activity = codexActivity([command, event({ type: 'file_change', changes: [{ kind: 'update', path: 'src/index.js' }] }), event({ type: 'reasoning', text: 'not exported' }), 'stderr'].join('\n'));
  assert.deepEqual(activity, { steps: [{ action: '命令', detail: 'npm test', exitCode: 1 }, { action: '文件变更', detail: 'src/index.js' }], omitted: 0 });
  assert.equal(codexActivity(Array(83).fill(command).join('\n')).omitted, 3);
});
test('isolated phase evidence extraction captures host-verified code/browser proof and redacts secrets', () => {
  const redact = new Redactor();
  redact.add('super-secret-token');
  const codeRows: any[] = [
    { seq: 1, role: 'assistant', calls: [
      { id: 'e1', name: 'edit', arguments: { path: '/repo/src/app.ts' } },
      { id: 'b1', name: 'bash', arguments: { command: 'cd /repo && npm test # super-secret-token' } },
      { id: 'b2', name: 'bash', arguments: { command: 'cd /repo && npm run lint' } },
    ] },
    { seq: 2, role: 'tool', callId: 'e1', name: 'edit', text: JSON.stringify({ path: '/repo/src/app.ts', bytes: 120 }) },
    { seq: 3, role: 'tool', callId: 'b1', name: 'bash', text: JSON.stringify({ exitCode: 0, output: 'ok' }) },
    { seq: 4, role: 'tool', callId: 'b2', name: 'bash', error: true, text: JSON.stringify({ exitCode: 1, error: 'lint failed' }) },
  ];
  const code = extractPhaseEvidence('code_agent', codeRows, redact);
  assert.deepEqual(code.evidence, {
    filesChanged: ['/repo/src/app.ts'],
    commands: [
      { command: 'cd /repo && npm test # [credential redacted]', exitCode: 0 },
      { command: 'cd /repo && npm run lint', exitCode: 1, error: 'lint failed' },
    ],
    failedCommands: 1,
  });
  assert.equal(code.activity.steps.length, 3);
  assert.equal(cliEvidence(code.activity).failedCommands, 1);

  const browserRows: any[] = [
    { seq: 1, role: 'assistant', calls: [{ id: 'n1', name: 'chrome_navigate', arguments: { url: 'https://cursor.com/pricing' } }] },
    { seq: 2, role: 'tool', callId: 'n1', name: 'chrome_navigate',
      images: [{ mime: 'image/jpeg', url: '/api/files/employees/e/t/shot1-som.jpg', path: '/data/shot1-som.jpg' }],
      text: JSON.stringify({
        tabTag: 'C1-abc',
        tabs: [{ tag: 'C1-abc', url: 'https://cursor.com/pricing', title: 'cursor.com', active: true }],
        images: [{ mime: 'image/jpeg', url: '/api/files/employees/e/t/shot1.jpg', path: '/data/shot1.jpg' }],
        documentPath: '/data/doc1.json',
        pages: [{ headings: [{ level: 'H1', text: 'This site can’t be reached' }], stamp: '["chrome-error://chromewebdata/"]' }],
      }) },
  ];
  const browser = extractPhaseEvidence('browser_agent', browserRows, redact);
  assert.equal((browser.evidence as any).tabs[0].tabTag, 'C1-abc');
  assert.equal((browser.evidence as any).screenshots.length, 1);
  assert.equal((browser.evidence as any).screenshots[0].url, '/api/files/employees/e/t/shot1.jpg');
  assert.equal((browser.evidence as any).documentPaths[0], '/data/doc1.json');
  assert((browser.evidence as any).errors.some((e: string) => /This site can/.test(e)));
  assert.equal(classifyPhaseStatus('browser_agent', '[BLOCKED] 代理无法打开 cursor.com', browser.evidence), 'blocked');
  assert.equal(classifyPhaseStatus('browser_agent', '', browser.evidence, { steered: true }), 'interrupted_by_steer');

  const parentRows: any[] = [
    { seq: 4, role: 'assistant', toolScene: 'lightweight', calls: [{ id: 'p1', name: 'browser_agent', arguments: { task: 'open pricing' } }] },
    { seq: 5, role: 'tool', callId: 'p1', name: 'browser_agent', agentPhase: { seq: 4, name: 'browser_agent' },
      text: JSON.stringify({ status: 'blocked', executor: 'model/p/vision', phaseSession: 'child-1', result: '[BLOCKED] unreachable', evidence: browser.evidence }) },
  ];
  const [indexed] = phaseIndex(parentRows);
  assert.equal(indexed.status, 'blocked');
  assert.equal(indexed.phaseSession, 'child-1');
  assert.equal(indexed.executor, 'model/p/vision');
  assert.deepEqual(indexed.messageSeqs, [4, 5]);
});

test('transient tab errors clear after recovery, service worker noise is skipped, extractFinalPhaseText ignores opening fillers, and concurrent phases index separately', () => {
  const rows: any[] = [
    { seq: 1, role: 'assistant', text: '我先查找标签。', calls: [{ id: 'n1', name: 'chrome_navigate', arguments: { url: 'https://cursor.com/pricing' } }] },
    { seq: 2, role: 'tool', callId: 'n1', name: 'chrome_navigate', text: JSON.stringify({
      tabTag: 'C2',
      tabs: [{ tag: 'C2', url: 'chrome-error://chromewebdata/', active: true }],
      pages: [{ url: 'chrome-error://chromewebdata/', headings: [{ text: 'This site can’t be reached' }] }],
    }) },
    { seq: 3, role: 'assistant', calls: [{ id: 'n2', name: 'chrome_tab_control', arguments: { tabTag: 'C2', command: 'reload' } }] },
    { seq: 4, role: 'tool', callId: 'n2', name: 'chrome_tab_control', text: JSON.stringify({
      tabTag: 'C2',
      tabs: [{ tag: 'C2', url: 'https://cursor.com/pricing', title: 'Cursor · Pricing', active: true }],
      pages: [
        { url: 'https://cursor.com/pricing', title: 'Cursor · Pricing', headings: [{ text: 'Pricing' }] },
        { url: 'https://cursor.com/metrics/_/service_worker/6b40/sw_iframe.html', isSubframe: true, headings: [{ text: 'This site can’t be reached' }] },
      ],
    }) },
  ];
  const { evidence } = extractPhaseEvidence('browser_agent', rows);
  assert.deepEqual((evidence as any).errors, [], 'recovered transient error and subframe noise must not stay in errors');
  assert.deepEqual((evidence as any).visitedUrls, [{ url: 'https://cursor.com/pricing', title: 'Cursor · Pricing' }]);
  assert.equal(extractFinalPhaseText(rows), '', 'opening filler attached to a tool call must not be returned as final text');

  const concurrentParent: any[] = [
    { seq: 10, role: 'assistant', toolScene: 'lightweight', calls: [
      { id: 'c-code', name: 'code_agent', arguments: { task: 'check config' } },
      { id: 'c-browser', name: 'browser_agent', arguments: { task: 'check page' } },
    ] },
    { seq: 11, role: 'tool', callId: 'c-code', name: 'code_agent', agentPhase: { seq: 10, name: 'code_agent', callId: 'c-code' },
      text: JSON.stringify({ status: 'completed', executor: 'model/p/code', phaseSession: 'stage-code', result: 'code ok', evidence: { filesChanged: [], commands: [], failedCommands: 0 } }) },
    { seq: 12, role: 'tool', callId: 'c-browser', name: 'browser_agent', agentPhase: { seq: 10, name: 'browser_agent', callId: 'c-browser' },
      text: JSON.stringify({ status: 'completed', executor: 'model/p/vision', phaseSession: 'stage-browser', result: 'page ok', evidence: { visitedUrls: [], tabs: [], screenshots: [], documentPaths: [], errors: [] } }) },
  ];
  const indexed = phaseIndex(concurrentParent);
  assert.equal(indexed.length, 2, 'concurrent phases on the same seq must produce two distinct phase cards');
  assert.equal(indexed[0].callId, 'c-code');
  assert.equal(indexed[0].phaseSession, 'stage-code');
  assert.deepEqual(indexed[0].messageSeqs, [10, 11]);
  assert.equal(indexed[1].callId, 'c-browser');
  assert.equal(indexed[1].phaseSession, 'stage-browser');
  assert.deepEqual(indexed[1].messageSeqs, [10, 12]);

  const mixedParent: any[] = [
    { seq: 20, role: 'assistant', toolScene: 'lightweight', calls: [
      { id: 'm-plan', name: 'task_progress', arguments: { message: 'start' } },
      { id: 'm-browser', name: 'browser_agent', arguments: { task: 'check page' } },
    ] },
    { seq: 21, role: 'tool', callId: 'm-plan', name: 'task_progress', text: JSON.stringify({ ok: true }) },
    { seq: 22, role: 'tool', callId: 'm-browser', name: 'browser_agent', agentPhase: { seq: 20, name: 'browser_agent' },
      text: JSON.stringify({ status: 'completed', executor: 'model/p/vision', phaseSession: 'stage-mixed', result: 'ok', evidence: { visitedUrls: [], tabs: [], screenshots: [], documentPaths: [], errors: [] } }) },
  ];
  const mixedIndexed = phaseIndex(mixedParent);
  assert.equal(mixedIndexed.length, 1, 'mixed coordinator+phase turn indexes only the specialist phase');
  assert.equal(mixedIndexed[0].name, 'browser_agent');
  assert.equal(mixedIndexed[0].phaseSession, 'stage-mixed');
  assert.deepEqual(mixedIndexed[0].messageSeqs, [20, 22]);
});

test('browser_agent prompt enforces Markdown image embedding and IMAGE_MARKDOWN_RULES omits angle-bracket placeholders', () => {
  const prompt = specialistSystemPrompt('browser_agent');
  assert(prompt.includes('![说明](/api/files/...)'));
  assert(prompt.includes('禁止放进反引号/代码块'));
  assert(prompt.includes('禁止输出 /data/files/... 磁盘路径'));
  assert(prompt.includes('禁止用 .../ 或 …/ 省略前缀'));
  assert(prompt.includes('禁止自行猜测域名、协议或本地端口试探'));
  assert(!prompt.includes('截图路径'));
  assert(!prompt.includes('url/path'));
  assert(!IMAGE_MARKDOWN_RULES.includes('(<'));
  assert(!IMAGE_MARKDOWN_RULES.includes('>)'));
  const codePrompt = specialistSystemPrompt('code_agent');
  assert(codePrompt.includes('bash(detach=true)'));
  assert(codePrompt.includes('bash_poll(kill=true)'));
});

test('browser_agent prompt and CHROME_RULES allow filling user-provided OTP/verification codes while blocking when missing', () => {
  const prompt = specialistSystemPrompt('browser_agent');
  assert(prompt.includes('若主控已转交用户刚提供的验证码/访问码，应直接用 browser_act 填入当前验证页并提交'));
  assert(prompt.includes('出现短信/邮箱验证码、访问码或 2FA/OTP 且本次委派尚未提供该验证码'));
  assert(CHROME_RULES.includes('若主控已转交用户刚提供的验证码，直接用 browser_act 填入并提交'));
  assert(CHROME_RULES.includes('未获用户提供短信/邮箱验证码或 2FA/OTP 时才立刻报告主控问用户'));
});

test('EMPLOYEE_SCENE_RULES and browser_agent prompt guide direct media downloads and anti-loop behavior', () => {
  assert(EMPLOYEE_SCENE_RULES.includes('拿到图片、附件或静态文件直链'));
  assert(EMPLOYEE_SCENE_RULES.includes('并发下载到 /tmp'));
  assert(EMPLOYEE_SCENE_RULES.includes('并发 read 本地原图'));
  assert(EMPLOYEE_SCENE_RULES.includes('仅当直链下载因鉴权'));
  const prompt = specialistSystemPrompt('browser_agent');
  assert(prompt.includes('打开纯图片或媒体直链时'));
  assert(prompt.includes('严禁对当前上下文里已可见的截图重复调用 read'));
  assert(prompt.includes('imagesOmitted'));
  assert(!prompt.includes('截图路径'));
  assert(!prompt.includes('url/path'));
});

test('createBrowserLoopGuard trips on stale navigation cycles, reloads, and wait-only loops while allowing genuine progress', () => {
  // 1. 3-URL cycle A -> B -> C repeated trips on the 4th visit to A.
  const cycleGuard = createBrowserLoopGuard(4);
  const urls = ['https://example.test/1', 'https://example.test/2', 'https://example.test/3'];
  for (let round = 0; round < 3; round++) {
    for (const url of urls) {
      assert.equal(cycleGuard.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url } }], [{ value: { url } }]), null);
    }
  }
  const cycleTripped = cycleGuard.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url: urls[0] } }], [{ value: { url: urls[0] } }]);
  assert.match(String(cycleTripped), /重复导航\/刷新同一目标 4 次/);

  // 2. Repeated reload on the same target trips on 4th reload.
  const reloadGuard = createBrowserLoopGuard(4);
  for (let i = 0; i < 3; i++) {
    assert.equal(reloadGuard.observe([{ name: 'browser_tabs', arguments: { action: 'reload', tab: 'C1' } }], [{ value: { url: 'https://example.test/img.png' } }]), null);
  }
  const reloadTripped = reloadGuard.observe([{ name: 'browser_tabs', arguments: { action: 'reload', tab: 'C1' } }], [{ value: { url: 'https://example.test/img.png' } }]);
  assert.match(String(reloadTripped), /重复导航\/刷新同一目标 4 次/);

  // 3. Consecutive wait-only turns trip on 4th wait-only turn.
  const waitGuard = createBrowserLoopGuard(4);
  for (let i = 0; i < 3; i++) {
    assert.equal(waitGuard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'wait', ms: 3000 }] } }], [{ value: { ok: true } }]), null);
  }
  const waitTripped = waitGuard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'wait', ms: 3000 }] } }], [{ value: { ok: true } }]);
  assert.match(String(waitTripped), /连续 4 轮仅等待/);

  // 4. Successful interactive browser_act or browser_eval resets stale navigation counts.
  const progressGuard = createBrowserLoopGuard(4);
  for (let i = 0; i < 3; i++) {
    assert.equal(progressGuard.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url: 'https://example.test/app' } }], [{ value: { url: 'https://example.test/app' } }]), null);
  }
  assert.equal(progressGuard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'click', id: 1 }] } }], [{ value: { ok: true } }]), null);
  assert.equal(progressGuard.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url: 'https://example.test/app' } }], [{ value: { url: 'https://example.test/app' } }]), null);

  assert.equal(progressGuard.observe([{ name: 'browser_eval', arguments: { code: 'document.title' } }], [{ value: { ok: true } }]), null);
  for (let i = 0; i < 3; i++) {
    assert.equal(progressGuard.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url: 'https://example.test/app' } }], [{ value: { url: 'https://example.test/app' } }]), null);
  }

  // 5. Repeated browser_view with evolving content never trips, while frozen identical browser_view trips at passive cap (24).
  const evolvingViewGuard = createBrowserLoopGuard(4);
  for (let i = 0; i < 30; i++) {
    assert.equal(evolvingViewGuard.observe([{ name: 'browser_view', arguments: { tab: 'C1', screenshot: false } }], [{ value: { url: 'https://example.test/app', text: `panel-${i}` } }]), null);
  }
  const frozenViewGuard = createBrowserLoopGuard(4);
  for (let i = 0; i < 23; i++) {
    assert.equal(frozenViewGuard.observe([{ name: 'browser_view', arguments: { tab: 'C1', screenshot: false } }], [{ value: { url: 'https://example.test/app', text: 'same' } }]), null);
  }
  assert.match(String(frozenViewGuard.observe([{ name: 'browser_view', arguments: { tab: 'C1', screenshot: false } }], [{ value: { url: 'https://example.test/app', text: 'same' } }])), /结果无变化/);
});

test('createToolLoopGuard catches goto+click cycles, non-nav periodic loops, repeated errors, and supports reset', () => {
  // 1. Period-2 goto -> click -> goto -> click bypasses staleNavCounts.clear() but is caught by periodic cycle detector.
  const gotoClick = createBrowserLoopGuard(4);
  for (let round = 0; round < 2; round++) {
    assert.equal(gotoClick.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url: 'https://example.test/a', tab: 'C1' } }], [{ value: { url: 'https://example.test/a', text: 'same-a' } }]), null);
    assert.equal(gotoClick.observe([{ name: 'browser_act', arguments: { tab: 'C1', steps: [{ op: 'click', id: 5 }] } }], [{ value: { ok: true, url: 'https://example.test/a', text: 'same-a' } }]), null);
  }
  assert.equal(gotoClick.observe([{ name: 'browser_tabs', arguments: { action: 'goto', url: 'https://example.test/a', tab: 'C1' } }], [{ value: { url: 'https://example.test/a', text: 'same-a' } }]), null);
  const p2Tripped = gotoClick.observe([{ name: 'browser_act', arguments: { tab: 'C1', steps: [{ op: 'click', id: 5 }] } }], [{ value: { ok: true, url: 'https://example.test/a', text: 'same-a' } }]);
  assert.match(String(p2Tripped), /陷入 2 步循环重复操作/);

  // 2. Period-3 non-nav cycle (e.g. click A -> click B -> click C) trips on 3rd cycle when outcomes repeat.
  const p3Guard = createToolLoopGuard({ threshold: 4 });
  const ids = [1, 2, 3];
  for (let round = 0; round < 2; round++) {
    for (const id of ids) {
      assert.equal(p3Guard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'click', id }] } }], [{ value: { ok: true, url: `https://example.test/${id}` } }]), null);
    }
  }
  assert.equal(p3Guard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'click', id: 1 }] } }], [{ value: { ok: true, url: 'https://example.test/1' } }]), null);
  assert.equal(p3Guard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'click', id: 2 }] } }], [{ value: { ok: true, url: 'https://example.test/2' } }]), null);
  const p3Tripped = p3Guard.observe([{ name: 'browser_act', arguments: { steps: [{ op: 'click', id: 3 }] } }], [{ value: { ok: true, url: 'https://example.test/3' } }]);
  assert.match(String(p3Tripped), /陷入 3 步循环重复操作/);

  // 3. Consecutive identical tool errors trip even when arguments vary slightly.
  const errGuard = createToolLoopGuard({ threshold: 4 });
  for (let i = 0; i < 3; i++) {
    assert.equal(errGuard.observe([{ name: 'bash', arguments: { command: `curl https://example.test/${i}` } }], [{ error: true, value: { error: 'Operation timed out' } }]), null);
  }
  const errTripped = errGuard.observe([{ name: 'bash', arguments: { command: 'curl https://example.test/3' } }], [{ error: true, value: { error: 'Operation timed out' } }]);
  assert.match(String(errTripped), /触发相同工具错误/);

  // 4. reset() clears rolling history cleanly.
  errGuard.reset();
  assert.equal(errGuard.observe([{ name: 'bash', arguments: { command: 'curl https://example.test/4' } }], [{ error: true, value: { error: 'Operation timed out' } }]), null);
});

test('OOM detection, shell command summarization, and code checkpoint ledger track edits, passed checks, and OOM blocks cleanly', () => {
  assert.equal(
    summarizeShellCommand('set -eu\ncd /repo/be || exit 1\nexport GOPROXY=off\ngo test -count=1 ./services ./services/game'),
    'go test -count=1 ./services ./services/game',
  );
  assert.equal(
    detectOomInText('ok\tdashboard-backend/services\ndashboard-backend/services/datamap: /usr/local/go/pkg/tool/linux_amd64/compile: signal: killed\nFAIL'),
    'dashboard-backend/services/datamap: /usr/local/go/pkg/tool/linux_amd64/compile: signal: killed',
  );
  assert.equal(extractOomSignal('bash', { error: true, value: { exitCode: 137, output: '' } }), 'exitCode=137 (SIGKILL/OOM)');
  assert.equal(extractOomSignal('bash', { error: true, value: { exitCode: 1, output: 'no matches' } }), null);
  assert.equal(
    extractOomSignal('bash_poll', { error: true, value: { exitCode: 1, output: 'fatal error: out of memory' } }),
    'fatal error: out of memory',
  );

  const redact = new Redactor();
  redact.add('secret-token-xyz');
  const rows: any[] = [
    { seq: 1, role: 'assistant', calls: [
      { id: 'e1', name: 'edit', arguments: { path: '/repo/be/services/mobile.go' } },
      { id: 'e2', name: 'edit', arguments: { path: '/repo/be/services/mobile.go' } },
      { id: 'w1', name: 'write', arguments: { path: '/repo/be/router/mobile_revenue.go' } },
      { id: 'rg1', name: 'bash', arguments: { command: 'set -eu\ncd /repo/be\nrg -n missing_sym .' } },
      { id: 'ok1', name: 'bash', arguments: { command: 'set -eu\ncd /repo/be\ngo test -vet=off ./services ./services/game' } },
      { id: 'oom1', name: 'bash', arguments: { command: 'set -eu\ncd /repo/be\ngo test -vet=off ./router # secret-token-xyz' } },
      { id: 'bg1', name: 'bash', arguments: { command: 'set -eu\ncd /repo/be\ngo test -p 1 ./router' } },
    ] },
    { seq: 2, role: 'tool', callId: 'e1', name: 'edit', text: JSON.stringify({ path: '/repo/be/services/mobile.go' }) },
    { seq: 3, role: 'tool', callId: 'e2', name: 'edit', text: JSON.stringify({ path: '/repo/be/services/mobile.go' }) },
    { seq: 4, role: 'tool', callId: 'w1', name: 'write', text: JSON.stringify({ path: '/repo/be/router/mobile_revenue.go' }) },
    { seq: 5, role: 'tool', callId: 'rg1', name: 'bash', error: true, text: JSON.stringify({ exitCode: 1, output: '' }) },
    { seq: 6, role: 'tool', callId: 'ok1', name: 'bash', text: JSON.stringify({ exitCode: 0, output: 'ok' }) },
    { seq: 7, role: 'tool', callId: 'oom1', name: 'bash', error: true, text: JSON.stringify({ exitCode: 1, output: 'services/datamap: compile: signal: killed' }) },
    { seq: 8, role: 'tool', callId: 'bg1', name: 'bash', text: JSON.stringify({ running: true, jobId: 7 }) },
    { seq: 9, role: 'assistant', calls: [{ id: 'poll1', name: 'bash_poll', arguments: { job_id: 7, wait: 1 } }] },
    { seq: 10, role: 'tool', callId: 'poll1', name: 'bash_poll', error: true, text: JSON.stringify({ jobId: 7, exitCode: 1, output: 'services/search: compile: signal: killed' }) },
  ];

  const ledger = buildCodeCheckpointLedger(rows, redact);
  assert.deepEqual(ledger.filesChanged, [
    { path: '/repo/be/services/mobile.go', edits: 2 },
    { path: '/repo/be/router/mobile_revenue.go', edits: 1 },
  ]);
  assert.deepEqual(ledger.passedChecks, ['go test -vet=off ./services ./services/game']);
  assert.deepEqual(ledger.failedChecks, [], 'read-only rg exit=1 must not pollute failedChecks');
  assert.equal(ledger.oomBlocked.length, 2);
  assert(!ledger.oomBlocked[0].includes('secret-token-xyz'));
  assert(ledger.oomBlocked[1].includes('go test -p 1 ./router'));

  const block = formatCodeCheckpointBlock(ledger);
  assert(block.includes('### 宿主核验代码还原点'));
  assert(block.includes('/repo/be/services/mobile.go (×2)'));
  assert(block.includes('已通过验证（无新改动勿重跑）'));
  assert(block.includes('已确认 OOM / signal: killed 禁区'));

  const note = formatCodeCheckpointNote(ledger);
  assert(note.startsWith('代码还原点：已改 2 个文件'));
  assert(note.includes('OOM禁区（勿重跑）'));
  assert([...note].length <= 450);

  const codePrompt = specialistSystemPrompt('code_agent');
  assert(codePrompt.includes('禁止开启 set -e'));
  assert(codePrompt.includes('signal: killed / OOM'));
  assert(EMPLOYEE_SCENE_RULES.includes('拆成 2–3 个小阶段'));
});
