import { timingSafeEqual, randomBytes } from "node:crypto";
import { Auth } from "./auth";
import { Store } from "./store";
import { Subscriptions } from "./subscriptions";
import { Catalog } from "./catalog";
import { ChromeBridge } from "./chrome-bridge";
import { Chrome } from "./chrome";
import { Engine } from "./engine";
import { HeadlessBrowser } from "./headless";
import { cloudEnabled } from "./cloud";
import { BrowserLive } from "./browser-live";
import { EventsSocket } from "./events-socket";
import { ClientSockets } from "./client-socket";
import { PreviewTokens } from "./previews";
export type Application = {
  store: Store;
  engine: Engine;
  token: string;
  auth: Auth;
  browserLive: BrowserLive;
  employeeLives: Map<string, BrowserLive>;
  eventsSocket: EventsSocket;
  clientSockets: ClientSockets;
  headless: HeadlessBrowser;
  previewTokens: PreviewTokens;
};
let application: Application | undefined;
export function app() {
  if (!application) throw Error("Vega is not initialized");
  return application;
}
export async function initialize(pageScript: string, livePageScript: string) {
  if (application) return application;
  const store = await Store.open(),
    subscriptions = new Subscriptions(store),
    catalog = new Catalog(store, subscriptions),
    bridge = new ChromeBridge(false, pageScript),
    chrome = new Chrome(store, bridge, pageScript, "experience", livePageScript),
    engine = await Engine.create(store, catalog, chrome);
  store.db.onLockLost = (reason) => {
    console.error("[Vega] 数据库单活锁已丢失，已停止本实例任务调度以防止与新实例冲突：", reason);
    engine.employee.close();
  };
  catalog.refreshPrices = true;
  void catalog.modelMetadata(true);
  const token = process.env.VEGA_TOKEN || randomBytes(32).toString("base64url");
  if (token.length < 16)
    throw Error("VEGA_TOKEN must be at least16 characters");
  const auth = new Auth(store, token);
  auth.events.on("revoke", (id) => engine.localAgents.disconnect(id));
  if (!await auth.hasUsers())
    console.info(
      "[Vega] Create the first administrator using the setup token" +
        (process.env.VEGA_TOKEN ? " configured in VEGA_TOKEN." : ": " + token),
    );
  application = {
    store,
    engine,
    token,
    auth,
    browserLive: new BrowserLive(chrome, auth),
    employeeLives: new Map(),
    eventsSocket: new EventsSocket(engine, auth),
    clientSockets: new ClientSockets(store, auth, engine.localAgents, async (clientId) => await engine.clientInUse(clientId), engine.relay, (session, reason) => {
      // Esc 叫停：客户端上报“用户亲手按了 Esc”，服务端停掉占用桌面的那个会话。
      engine.cancel(session, reason);
      return engine.active.has(session);
    }, async (userId, clientId) => await engine.taskStatusFor(userId, clientId), async (userId, clientId) => await engine.handoffs.offline(clientId, userId)),
    headless: new HeadlessBrowser(),
    previewTokens: new PreviewTokens(),
  };
  const dbPath = process.env.VEGA_DB || "vega.db";
  if (!cloudEnabled()) {
    await application.headless.start(dbPath);
    await bridge.start();
  }
  await engine.employee.start();
  await engine.taskTabs.restore();
  engine.statusPush = (userId, clientId) => void application!.clientSockets.pushStatus(userId, clientId);
  engine.runtimePush = (userId) => void application!.clientSockets.pushRuntime(userId);
  application.clientSockets.runtime = {
    view: (userId) => engine.clientsView(userId),
  };
  return application;
}
export async function employeeLive(employeeId?: string) {
  const application = app();
  if (!employeeId) return application.browserLive;
  const employee = await application.engine.employee.for(employeeId);
  const ownerId = (await employee.state()).ownerId;
  const profileKey = application.engine.browserProfileKey(ownerId);
  // One live session per owner profile; employees of the same user share it.
  let live = application.employeeLives.get(profileKey);
  if (!live) {
    const chrome = application.engine.browsers.peek(profileKey);
    if (!chrome) throw Error("热心市民的浏览器尚未启动");
    live = new BrowserLive(chrome, application.auth, async (principal) => await employee.manageable(principal.user));
    application.employeeLives.set(profileKey, live);
  }
  return live;
}
export function authenticated(value: string, token: string) {
  const a = Buffer.from(value),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
