import { timingSafeEqual, randomBytes } from "node:crypto";
import { Store } from "./store";
import { Subscriptions } from "./subscriptions";
import { Catalog } from "./catalog";
import { ChromeBridge } from "./chrome-bridge";
import { Chrome } from "./chrome";
import { Engine } from "./engine";
export type Application = { store: Store; engine: Engine; token: string };
let application: Application | undefined;
export function app() {
  if (!application) throw Error("Vega is not initialized");
  return application;
}
export async function initialize(pageScript: string, helper: string) {
  if (application) return application;
  const store = new Store(),
    auth = new Subscriptions(store, helper),
    catalog = new Catalog(store, auth),
    bridge = new ChromeBridge(),
    chrome = new Chrome(store, bridge, pageScript),
    engine = new Engine(store, catalog, chrome);
  const token = process.env.VEGA_TOKEN || randomBytes(32).toString("base64url");
  if (token.length < 16)
    throw Error("VEGA_TOKEN must be at least16 characters");
  if (!process.env.VEGA_TOKEN)
    console.info(
      "[Vega] Temporary access token (rotates on restart): " + token,
    );
  application = { store, engine, token };
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
