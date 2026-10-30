import {
  defineEventHandler,
  getHeader,
  getRequestURL,
  createError,
  setHeader,
} from "h3";
import { app, authenticated } from "../core/application";
export default defineEventHandler((event) => {
  if (!getRequestURL(event).pathname.startsWith("/api/")) return;
  const { token } = app(),
    supplied = (getHeader(event, "authorization") || "").replace(
      /^Bearer /,
      "",
    );
  if (!authenticated(supplied, token))
    throw createError({
      statusCode: 401,
      statusMessage: "API access token required",
    });
  const origin = getHeader(event, "origin"),
    host = getHeader(event, "host");
  if (origin && new URL(origin).host !== host)
    throw createError({
      statusCode: 403,
      statusMessage: "Cross-origin API access denied",
    });
  setHeader(event, "Cache-Control", "no-store");
});
