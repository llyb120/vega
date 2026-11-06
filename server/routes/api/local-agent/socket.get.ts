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
  close(peer) { app().clientSockets.close(peer.id); },
  error(peer) { app().clientSockets.close(peer.id); },
});
