import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { gate, httpError } from "../core/http-auth";
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/api/")) return;
  setHeader(event, "Cache-Control", "no-store");
  try {
    gate(event, path);
  } catch (error) {
    httpError(error);
  }
});
