import { defineEventHandler, getCookie, getRequestURL, send, setHeader, setResponseStatus } from "h3";
import { app } from "../../core/application";
import { COOKIE } from "../../core/http-auth";
import { handlePreviewRequest } from "../../core/previews";

export default defineEventHandler(async (event) => {
  const { store, auth, previewTokens } = app();
  const pathname = getRequestURL(event).pathname;
  const response = await handlePreviewRequest(
    { store, auth, previewTokens },
    { method: event.method, pathname, sessionCookie: getCookie(event, COOKIE) },
  );
  setResponseStatus(event, response.status);
  for (const [key, value] of Object.entries(response.headers)) {
    setHeader(event, key, value);
  }
  return send(event, response.body ?? Buffer.alloc(0));
});
