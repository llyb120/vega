import { defineNitroPlugin, useStorage } from "nitropack/runtime";
import { initialize } from "../core/application";
export default defineNitroPlugin(async (nitro) => {
  const page =
    await useStorage("assets:browser").getItem<string>("browser-page.js");
  const helper = await useStorage("assets:assets").getItem<string>(
    "workbuddy-login.cjs",
  );
  if (!page || !helper) throw Error("Bundled migration assets missing");
  const { store, engine } = await initialize(page, helper);
  nitro.hooks.hook("close", async () => {
    await engine.close();
    store.close();
  });
});
