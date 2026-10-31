import { defineNitroPlugin, useStorage } from "nitropack/runtime";
import { initialize } from "../core/application";
import { WS_BODY_LIMIT } from "../core/events-socket";
export default defineNitroPlugin(async (nitro) => {
  Object.assign(nitro.h3App.websocket, {
    serverOptions: {
      maxPayload: WS_BODY_LIMIT + 4096,
      perMessageDeflate: false,
    },
  });
  const page =
    await useStorage("assets:browser").getItem<string>("browser-page.js");
  const helper = await useStorage("assets:assets").getItem<string>(
    "workbuddy-login.cjs",
  );
  if (!page || !helper) throw Error("Bundled migration assets missing");
  const { store, engine, browserLive, eventsSocket } = await initialize(
    page,
    helper,
  );
  nitro.hooks.hook("close", async () => {
    eventsSocket.closeAll();
    await browserLive.close();
    await engine.close();
    store.close();
  });
});
