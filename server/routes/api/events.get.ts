import { defineWebSocketHandler } from "h3";
import { app } from "../../core/application";

// Events only: the page sends subscriptions; API calls go over HTTP.
export default defineWebSocketHandler({
  async upgrade(request) {
    try {
      await app().eventsSocket.authorize(request);
    } catch {
      return new Response("Realtime connection denied", { status: 403 });
    }
  },
  async open(peer) {
    try {
      await app().eventsSocket.open(peer);
    } catch {
      peer.close(4403, "实时连接已失效");
    }
  },
  message(peer, message) {
    app().eventsSocket.message(peer, message.text());
  },
  close(peer) {
    app().eventsSocket.close(peer.id);
  },
  error(peer) {
    app().eventsSocket.close(peer.id);
  },
});
