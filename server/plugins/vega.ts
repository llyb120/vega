import { defineNitroPlugin, useStorage } from "nitropack/runtime";
import { initialize } from "../core/application";
export default defineNitroPlugin(async (nitro) => {
  const page =
    await useStorage("assets:browser").getItem<string>("browser-page.js");
  if (!page) throw Error("Bundled browser asset missing");
  const { store, engine, browserLive, employeeLives, eventsSocket, clientSockets, headless } =
    await initialize(page);
  nitro.hooks.hook("close", async () => {
    eventsSocket.closeAll();
    clientSockets.closeAll();
    await browserLive.close();
    await Promise.all([...employeeLives.values()].map((live) => live.close()));
    await headless.close();
    await engine.close();
    await store.close();
  });
});
