import { defineNitroPlugin, useStorage } from "nitropack/runtime";
import { initialize } from "../core/application";
import { CLIENT_BODY_LIMIT } from "../core/client-socket";
export default defineNitroPlugin(async (nitro) => {
  Object.assign(nitro.h3App.websocket, {
    serverOptions: {
      maxPayload: CLIENT_BODY_LIMIT,
      perMessageDeflate: false,
    },
  });
  const page =
    await useStorage("assets:browser").getItem<string>("browser-page.js");
  const helper = await useStorage("assets:assets").getItem<string>(
    "workbuddy-login.cjs",
  );
  if (!page || !helper) throw Error("Bundled migration assets missing");
  const { store, engine, browserLive, eventsSocket, clientSockets, headless } =
    await initialize(page, helper);
  nitro.hooks.hook("close", async () => {
    eventsSocket.closeAll();
    clientSockets.closeAll();
    await browserLive.close();
    await headless.close();
    await engine.close();
    store.close();
  });
});
