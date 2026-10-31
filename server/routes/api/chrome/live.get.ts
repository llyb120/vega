import { defineWebSocketHandler } from "h3";
import { app } from "../../../core/application";
export default defineWebSocketHandler({
  upgrade(request) {
    try {
      app().browserLive.authorize(request);
    } catch {
      return new Response("Browser connection denied", { status: 403 });
    }
  },
  open(peer) {
    try {
      app().browserLive.open(peer);
    } catch {
      peer.close(4403, "浏览器连接已失效");
    }
  },
  message(peer, message) {
    app().browserLive.message(peer, message.text());
  },
  close(peer) {
    void app().browserLive.sessions.get(peer.id)?.close();
  },
  error(peer) {
    void app()
      .browserLive.sessions.get(peer.id)
      ?.close(1011, "浏览器连接已中断");
  },
});
