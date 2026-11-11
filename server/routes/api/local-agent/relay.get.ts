import { defineEventHandler, getHeader, createError } from "h3";
import { app } from "../../../core/application";
import { laneParams, openStream, wire, wireRequest } from "../../../core/sse";

const denied = (error: any): never => {
  throw createError({ statusCode: 403, statusMessage: String(error?.message || "Unauthorized").slice(0, 300) });
};

// Downstream half of one TCP tunnel. One lane only: tunnel bytes must stay in order.
export default defineEventHandler(async (event) => {
  const request = wireRequest(event),
    { clientSockets, engine } = app(),
    relay = engine.relay,
    flow = getHeader(event, "x-vega-relay") || "";
  // A tunnel is a single ordered stream: extra lanes would let bytes overtake each other.
  if (laneParams(event).lane !== 0) denied(Error("Relay does not support lanes"));
  const grant = await clientSockets.authorize(request).catch(denied),
    { sink, body } = openStream(event);
  let id = "";
  const stream = clientSockets.channels.create(grant.hash, { lanes: 1, ongone: () => relay.closePeer(id) });
  id = stream.id;
  stream.attach(0, sink);
  const socket = wire(stream, request);
  socket.send({ type: "channel", channel: stream.id });
  try {
    relay.open(socket, grant, flow);
  } catch {
    console.warn("[Vega relay] Tunnel rejected: missing, expired or mismatched flow/device grant");
    stream.close(1008, "Invalid relay connection");
  }
  return body;
});
