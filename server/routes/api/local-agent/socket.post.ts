import { defineEventHandler, createError } from "h3";
import { app } from "../../../core/application";
import { bodyJSON } from "../../../core/http-auth-routes";
import { CLIENT_SOCKET_LIMIT } from "../../../core/client-socket";

// Upstream half of the client control channel: heartbeats, job results and user stops.
export default defineEventHandler(async (event) => {
  const body = await bodyJSON(event, CLIENT_SOCKET_LIMIT),
    { clientSockets } = app();
  try {
    const grant = await clientSockets.authorize({ url: "http://native.invalid/", headers: new Headers(event.node.req.headers as Record<string, string>) });
    await clientSockets.messageByChannel(String(body.channel || ""), grant, body.message as any);
    return { ok: true };
  } catch (error: any) {
    throw createError({ statusCode: 403, statusMessage: String(error?.message || "Client credential invalid or revoked").slice(0, 300) });
  }
});
