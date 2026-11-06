import { defineWebSocketHandler } from "h3";
import { app } from "../../../core/application";
import type { NetworkRelay } from "../../../core/network-relay";

export default defineWebSocketHandler({
  async upgrade(request) {
    try { request.context.relayGrant = await app().clientSockets.authorize(request); }
    catch { return new Response("Unauthorized", { status: 401 }); }
  },
  open(peer) {
    try {
      // crossws dispatches messages without awaiting open; authenticate before completing the upgrade.
      app().engine.relay.open(peer, peer.context.relayGrant as Parameters<NetworkRelay["open"]>[1], peer.request.headers.get("x-vega-relay") || "");
    } catch {
      console.warn("[Vega relay] Tunnel rejected: missing, expired or mismatched flow/device grant");
      peer.close(1008, "Invalid relay connection");
    }
  },
  message(peer, message) { app().engine.relay.message(peer, message.uint8Array()); },
  close(peer) { app().engine.relay.closePeer(peer.id); },
  error(peer) { app().engine.relay.closePeer(peer.id); },
});
