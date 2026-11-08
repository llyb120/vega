import { defineWebSocketHandler } from "h3";
import { app } from "../../../core/application";
import type { ClientSockets } from "../../../core/client-socket";

export default defineWebSocketHandler({
  async upgrade(request) {
    try { request.context.clientGrant = await app().clientSockets.authorize(request); }
    catch { return new Response("Client credential invalid or revoked", { status: 403 }); }
  },
  async open(peer) {
    try { await app().clientSockets.open(peer, peer.context.clientGrant as Awaited<ReturnType<ClientSockets["authorize"]>>); }
    catch { peer.close(4403, "Client authorization failed"); }
  },
  async message(peer, message) { await app().clientSockets.message(peer, message.text()); },
  close(peer, details) {
    // 1009 means a frame was over CLIENT_SOCKET_LIMIT; without this line the only symptom is a silent
    // drop-and-reconnect that never finishes its task.
    if (details?.code && details.code !== 1000 && details.code !== 1005)
      console.warn(`[Vega client] socket closed ${details.code}${details.reason ? " " + details.reason : ""}`);
    app().clientSockets.close(peer.id);
  },
  error(peer, err) {
    console.warn(`[Vega client] socket error: ${err?.message || err}`);
    app().clientSockets.close(peer.id);
  },
});
