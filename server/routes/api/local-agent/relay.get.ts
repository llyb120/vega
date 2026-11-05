import { defineWebSocketHandler } from "h3";
import { app } from "../../../core/application";

export default defineWebSocketHandler({
  async upgrade(request) {
    try { await app().clientSockets.authorize(request); }
    catch { return new Response("Unauthorized", { status: 401 }); }
  },
  async open(peer) {
    try {
      const grant = await app().clientSockets.authorize(peer.request);
      app().engine.relay.open(peer, grant, peer.request.headers.get("x-vega-relay") || "");
    } catch { peer.close(1008, "Invalid relay connection"); }
  },
  message(peer, message) { app().engine.relay.message(peer, message.uint8Array()); },
  close(peer) { app().engine.relay.closePeer(peer.id); },
  error(peer) { app().engine.relay.closePeer(peer.id); },
});
