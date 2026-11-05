import { createError, defineEventHandler, getRequestURL, setHeader } from "h3";
import { spaPage } from "../core/spa";
// Unmatched non-API paths: app pages get index.html (served by the static handler), the rest 404.
export default defineEventHandler(async (event) => {
  if (!spaPage(event.method, getRequestURL(event).pathname)) throw createError({ statusCode: 404, statusMessage: "Not Found" });
  setHeader(event, "Content-Type", "text/html; charset=utf-8");
  setHeader(event, "Cache-Control", "no-cache");
  return await $fetch<string>("/index.html", { responseType: "text" });
});
