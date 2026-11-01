import { defineWebSocketHandler } from "h3";
import { app } from "../../../core/application";

export default defineWebSocketHandler({
  upgrade(request) {
    try { app().clientSockets.authorize(request); }
    catch { return new Response("Client credential invalid or revoked", { status: 403 }); }
  },
  open(peer) {
    try { app().clientSockets.open(peer); }
    catch { peer.close(4403, "Client authorization failed"); }
  },
  message(peer, message) { app().clientSockets.message(peer, message.text()); },
  close(peer) { app().clientSockets.close(peer.id); },
  error(peer) { app().clientSockets.close(peer.id); },
});
