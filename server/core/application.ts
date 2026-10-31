import { timingSafeEqual, randomBytes } from "node:crypto";
import { Auth } from "./auth";
import { Store } from "./store";
import { Subscriptions } from "./subscriptions";
import { Catalog } from "./catalog";
import { ChromeBridge } from "./chrome-bridge";
import { Chrome } from "./chrome";
import { Engine } from "./engine";
import { BrowserLive } from "./browser-live";
export type Application = {
  store: Store;
  engine: Engine;
  token: string;
  auth: Auth;
  browserLive: BrowserLive;
};
let application: Application | undefined;
export function app() {
  if (!application) throw Error("Vega is not initialized");
  return application;
}
export async function initialize(pageScript: string, helper: string) {
  if (application) return application;
  const store = new Store(),
    subscriptions = new Subscriptions(store, helper),
    catalog = new Catalog(store, subscriptions),
    bridge = new ChromeBridge(),
    chrome = new Chrome(store, bridge, pageScript),
    engine = new Engine(store, catalog, chrome);
  const token = process.env.VEGA_TOKEN || randomBytes(32).toString("base64url");
  if (token.length < 16)
    throw Error("VEGA_TOKEN must be at least16 characters");
  const auth = new Auth(store, token);
  if (!auth.hasUsers())
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
  };
  await bridge.start();
  engine.employee.start();
  engine.relay.restart();
  return application;
}
export function authenticated(value: string, token: string) {
  const a = Buffer.from(value),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
