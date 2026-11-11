import { defineEventHandler, createError } from "h3";
import { app } from "../../../core/application";
import { laneParams, openStream, wire, wireRequest } from "../../../core/sse";

const denied = (error: any): never => {
  throw createError({ statusCode: 403, statusMessage: String(error?.message || "Client credential invalid or revoked").slice(0, 300) });
};

// Downstream half of the client control channel: queued jobs and acknowledgements reach the device as SSE.
export default defineEventHandler(async (event) => {
  const request = wireRequest(event),
    { lane, channel } = laneParams(event);
  if (lane > 0) {
    const grant = await app().clientSockets.authorize(request).catch(denied),
      { sink, body } = openStream(event);
    try {
      app().clientSockets.channels.owned(channel, grant.hash).attach(lane, sink);
    } catch (error) {
      denied(error);
    }
    return body;
  }
  const { clientSockets } = app(),
    grant = await clientSockets.authorize(request).catch(denied),
    { sink, body } = openStream(event);
  let id = "";
  const stream = clientSockets.channels.create(grant.hash, { lanes: 3, ongone: () => clientSockets.close(id) });
  id = stream.id;
  stream.attach(0, sink);
  const socket = wire(stream, request);
  socket.send({ type: "channel", channel: stream.id });
  try {
    await clientSockets.open(socket, grant);
  } catch (error: any) {
    stream.close(4429, String(error?.message || "Too many native client connections").slice(0, 200));
  }
  return body;
});
