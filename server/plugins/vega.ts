import { defineNitroPlugin, useStorage } from "nitropack/runtime";
import { initialize } from "../core/application";
export default defineNitroPlugin(async (nitro) => {
  Object.assign(nitro.h3App.websocket, {
    serverOptions: { maxPayload: 65536, perMessageDeflate: false },
  });
  const page =
    await useStorage("assets:browser").getItem<string>("browser-page.js");
  const helper = await useStorage("assets:assets").getItem<string>(
    "workbuddy-login.cjs",
  );
  if (!page || !helper) throw Error("Bundled migration assets missing");
  const { store, engine, browserLive } = await initialize(page, helper);
  nitro.hooks.hook("close", async () => {
    await browserLive.close();
    await engine.close();
    store.close();
  });
});
