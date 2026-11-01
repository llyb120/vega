import { defineWebSocketHandler } from "h3";
import { employeeLive } from "../../../core/application";
import type { Peer } from "crossws";
import type { BrowserLive } from "../../../core/browser-live";
const sessions = new Map<string, BrowserLive>();
const live = (request: { url: string }) => employeeLive(new URL(request.url).searchParams.get("employeeId") || undefined);
export default defineWebSocketHandler({
  upgrade(request) {
    try { live(request).authorize(request); }
    catch { return new Response("Browser connection denied", { status: 403 }); }
  },
  open(peer: Peer) {
    try {
      const hub = live(peer.request);
      hub.open(peer);
      sessions.set(peer.id, hub);
    } catch { peer.close(4403, "浏览器连接已失效"); }
  },
  message(peer, message) { sessions.get(peer.id)?.message(peer, message.text()); },
  close(peer) {
    void sessions.get(peer.id)?.sessions.get(peer.id)?.close();
    sessions.delete(peer.id);
  },
  error(peer) {
    void sessions.get(peer.id)?.sessions.get(peer.id)?.close(1011, "浏览器连接已中断");
    sessions.delete(peer.id);
  },
});
