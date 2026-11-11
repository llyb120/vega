import { defineEventHandler, createError } from "h3";
import { app } from "../../core/application";
import { laneParams, openStream, wire, wireRequest } from "../../core/sse";

const denied = (error: any): never => {
  throw createError({ statusCode: 403, statusMessage: String(error?.message || "Realtime connection denied").slice(0, 300) });
};

// Events only: the page keeps one stream open and reopens it when it needs a different set of sessions.
export default defineEventHandler(async (event) => {
  const { eventsSocket } = app(),
    request = wireRequest(event),
    { lane, channel } = laneParams(event);
  if (lane > 0) {
    const principal = await eventsSocket.identity(request).catch(denied),
      { sink, body } = openStream(event);
    try {
      eventsSocket.channels.owned(channel, principal.hash).attach(lane, sink);
    } catch (error) {
      denied(error);
    }
    return body;
  }
  const { principal } = await eventsSocket.authorize(request, true).catch(denied),
    { sink, body } = openStream(event);
  let id = "";
  const live = eventsSocket.channels.create(principal.hash, { lanes: 3, ongone: () => eventsSocket.close(id) });
  id = live.id;
  live.attach(0, sink);
  const socket = wire(live, request);
  socket.send({ type: "channel", channel: live.id });
  try {
    await eventsSocket.open(socket, principal);
  } catch (error: any) {
    live.close(4429, String(error?.message || "实时连接过多").slice(0, 200));
  }
  return body;
});
