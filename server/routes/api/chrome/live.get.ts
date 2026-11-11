import { defineEventHandler, createError } from "h3";
import { employeeLive } from "../../../core/application";
import { laneParams, openStream, wire, wireRequest } from "../../../core/sse";

const live = async (url: string) => await employeeLive(new URL(url).searchParams.get("employeeId") || undefined);
const denied = (error: any): never => {
  throw createError({ statusCode: 403, statusMessage: String(error?.message || "Browser connection denied").slice(0, 300) });
};
export default defineEventHandler(async (event) => {
  const request = wireRequest(event),
    hub = await live(request.url).catch(denied),
    { lane, channel } = laneParams(event);
  if (lane > 0) {
    const principal = await hub.identity(request).catch(denied),
      { sink, body } = openStream(event);
    try {
      hub.channels.owned(channel, principal.hash).attach(lane, sink);
    } catch (error) {
      denied(error);
    }
    return body;
  }
  const { principal, ticket } = await hub.authorize(request, true).catch(denied),
    { sink, body } = openStream(event);
  let id = "";
  const stream = hub.channels.create(principal.hash, {
    lanes: 3,
    // Losing lane 0 ends the session: capture, control lock and the viewer all go with it.
    ongone: () => void hub.sessions.get(id)?.close(1000, "连接已关闭"),
  });
  id = stream.id;
  stream.attach(0, sink);
  const socket = wire(stream, request);
  socket.send({ type: "channel", channel: stream.id });
  await hub.open(socket, principal, ticket.tabTag);
  return body;
});
