import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, createRouter, defineWebSocketHandler } from 'h3';
import nodeAdapter from 'crossws/adapters/node';
import ts from 'typescript';
import { Store } from '../server/core/store';
import { Auth } from '../server/core/auth';
import { ClientSockets } from '../server/core/client-socket';
import { LocalAgents } from '../server/core/local-agent';
import { NetworkRelay } from '../server/core/network-relay';

const execute = promisify(execFile), dir = await mkdtemp(join(tmpdir(), 'vega-relay-probe-'));
const hostIP = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
assert(hostIP, 'a non-loopback test address is needed by the client address policy');
const payload = 'actual-relay-response\n'.repeat(5000);
let received = 0;
const target = createServer((request, response) => { received++; response.end(payload); });
const dns = createSocket('udp4');
dns.on('message', (query, remote) => {
  let end = 12;
  while (query[end]) end += query[end] + 1;
  end += 5;
  const answer = query.readUInt16BE(end - 4) === 1;
  const header = Buffer.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, Number(answer), 0, 0, 0, 0]);
  const record = Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4]), Buffer.from(hostIP!.split('.').map(Number))]);
  dns.send(Buffer.concat([header, query.subarray(12, end), ...(answer ? [record] : [])]), remote.port, remote.address);
});
const store = await Store.open(':memory:'), auth = new Auth(store, 'relay-probe-setup');
const login = await auth.setup({ setupToken: 'relay-probe-setup', username: 'admin', password: 'Isolated relay probe password' });
const hub = new LocalAgents(), relay = new NetworkRelay(store, hub);
const clientSockets = new ClientSockets(store, auth, hub, () => false, relay);
const application = { engine: { relay }, clientSockets }, h3App = createApp(), router = createRouter();
for (const name of ['socket', 'relay']) {
  const source = await readFile(`server/routes/api/local-agent/${name}.get.ts`, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((path: string) => {
    if (path === 'h3') return { defineWebSocketHandler };
    if (path === '../../../core/application') return { app: () => application };
    throw Error('Unexpected import ' + path);
  }, module, module.exports);
  router.get('/api/local-agent/' + name, module.exports.default);
}
h3App.use(router);
const adapter = nodeAdapter(h3App.websocket), server = createServer();
server.on('upgrade', adapter.handleUpgrade);
let client: ReturnType<typeof spawn> | undefined, clientOutput = '';
try {
  target.listen(0, hostIP); await once(target, 'listening');
  dns.bind(0, '127.0.0.1'); await once(dns, 'listening');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clientId = 'd'.repeat(32), userId = login.principal.user.id;
  const paired = await clientSockets.pair({ ticket: hub.ticket(login.principal, 'a'.repeat(32)).ticket, clientId });
  const binary = join(dir, process.platform === 'win32' ? 'relay-client.test.exe' : 'relay-client.test');
  await execute('go', ['-C', 'local', 'test', '-c', '-o', binary], { timeout: 60000 });
  const port = (target.address() as any).port;
  client = spawn(binary, ['-test.run=^TestRelayProbeClient$'], { stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    VEGA_RELAY_PROBE: JSON.stringify({ Origin: `http://127.0.0.1:${(server.address() as any).port}`, UserID: userId, ClientID: clientId,
      Token: paired.deviceToken, Rule: `relay-probe.invalid:${port}`, DNS: `127.0.0.1:${(dns.address() as any).port}` })
  } });
  client.stdout?.on('data', data => clientOutput += data);
  client.stderr?.on('data', data => clientOutput += data);
  const deadline = Date.now() + 15000;
  while (!hub.active(userId, clientId)?.transport && Date.now() < deadline) await delay(20);
  assert(hub.active(userId, clientId)?.transport, 'actual Go control channel did not connect: ' + clientOutput);
  console.log('actual Go client control channel connected');
  const proxy = await relay.proxy(userId);
  const result = await execute(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--noproxy', '', '--proxy', proxy.replace('socks5:', 'socks5h:'), '--fail', '--silent', '--show-error', '--max-time', '20', `http://relay-probe.invalid:${port}/`], { timeout: 25000, maxBuffer: 2 << 20 });
  assert.equal(result.stdout, payload);
  assert.equal(received, 1);
  console.log('PASS: SOCKS → real authenticated Go control/tunnel → client DNS → TCP HTTP target; 105000 response bytes');
} finally {
  if (client) { client.stdin?.end(); await Promise.race([once(client, 'exit'), delay(1000)]); if (client.exitCode === null) client.kill(); }
  clientSockets.closeAll(); hub.close(); await relay.close(); adapter.closeAll(1000, 'cleanup', true);
  await new Promise<void>(resolve => server.close(() => resolve()));
  target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
  dns.close(); await store.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
