import { defineNitroPlugin } from "nitropack/runtime";
import { getRequestHeader, setResponseHeader, removeResponseHeader } from "h3";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);
const MIN_BYTES = 2048;

/**
 * JSON API responses (session histories, bootstrap) are gzipped when the browser accepts it; chat history shrinks
 * to a third or less. Runs on the zlib thread pool, so a large history never blocks the event loop. Binary, streamed and
 * already-sent responses are left alone; a proxy that also compresses skips responses that already carry an encoding.
 */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("beforeResponse", async (event, response) => {
    const body = response.body;
    if (!event.path.startsWith("/api/") || event.node.res.headersSent) return;
    if (!body || typeof body !== "object" || !(Array.isArray(body) || Object.getPrototypeOf(body) === Object.prototype)) return;
    if (!/\bgzip\b/.test(getRequestHeader(event, "accept-encoding") || "")) return;
    const json = JSON.stringify(body);
    if (json.length < MIN_BYTES) return;
    const data = await compress(json, { level: 5 });
    setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
    setResponseHeader(event, "Content-Encoding", "gzip");
    setResponseHeader(event, "Vary", "Accept-Encoding");
    removeResponseHeader(event, "Content-Length");
    response.body = data;
  });
});
