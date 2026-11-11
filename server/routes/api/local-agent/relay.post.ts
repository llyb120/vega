import { defineEventHandler, getHeader, createError } from "h3";
import { app } from "../../../core/application";
import { bodyJSON } from "../../../core/http-auth-routes";
import { wireRequest } from "../../../core/sse";

// Upstream half of one TCP tunnel; one POST per frame, in order.
export default defineEventHandler(async (event) => {
  const body = await bodyJSON(event, 1 << 20),
    { clientSockets, engine } = app();
  try {
    const grant = await clientSockets.authorize(wireRequest(event));
    engine.relay.incoming(getHeader(event, "x-vega-relay") || "", grant, body.data);
    return { ok: true };
  } catch (error: any) {
    throw createError({ statusCode: 403, statusMessage: String(error?.message || "Invalid relay connection").slice(0, 300) });
  }
});
