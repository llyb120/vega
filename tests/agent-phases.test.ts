import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPhases, phaseIndex } from '../web/src/agent-phases.js';
import { codexActivity } from '../server/core/coding-cli';
import { classifyPhaseStatus, cliEvidence, extractPhaseEvidence } from '../server/core/agent-phase';
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
      images: [{ mime: 'image/webp', url: '/api/files/employees/e/t/shot1.webp', path: '/data/shot1.webp' }],
      text: JSON.stringify({
        tabTag: 'C1-abc',
        tabs: [{ tag: 'C1-abc', url: 'https://cursor.com/pricing', title: 'cursor.com', active: true }],
        documentPath: '/data/doc1.json',
        pages: [{ headings: [{ level: 'H1', text: 'This site can’t be reached' }], stamp: '["chrome-error://chromewebdata/"]' }],
      }) },
  ];
  const browser = extractPhaseEvidence('browser_agent', browserRows, redact);
  assert.equal((browser.evidence as any).tabs[0].tabTag, 'C1-abc');
  assert.equal((browser.evidence as any).screenshots[0].url, '/api/files/employees/e/t/shot1.webp');
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
