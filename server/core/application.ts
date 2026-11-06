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
};
let application: Application | undefined;
export function app() {
  if (!application) throw Error("Vega is not initialized");
  return application;
}
export async function initialize(pageScript: string) {
  if (application) return application;
  const store = await Store.open(),
    subscriptions = new Subscriptions(store),
    catalog = new Catalog(store, subscriptions),
    bridge = new ChromeBridge(),
    chrome = new Chrome(store, bridge, pageScript),
    engine = await Engine.create(store, catalog, chrome);
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
    clientSockets: new ClientSockets(store, auth, engine.localAgents, async (clientId) => await engine.clientInUse(clientId), engine.relay),
    headless: new HeadlessBrowser(),
  };
  const dbPath = process.env.VEGA_DB || "vega.db";
  if (!cloudEnabled()) {
    await application.headless.start(dbPath);
    await bridge.start();
  }
  await engine.employee.start();
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
    if (!chrome) throw Error("牛马浏览器尚未启动");
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
