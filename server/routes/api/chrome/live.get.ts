import { defineWebSocketHandler } from "h3";
import { employeeLive } from "../../../core/application";
import type { Peer } from "crossws";
import type { BrowserLive } from "../../../core/browser-live";
const sessions = new Map<string, BrowserLive>();
const live = async (request: { url: string }) => await employeeLive(new URL(request.url).searchParams.get("employeeId") || undefined);
export default defineWebSocketHandler({
  async upgrade(request) {
    try { await (await live(request)).authorize(request); }
    catch { return new Response("Browser connection denied", { status: 403 }); }
  },
  async open(peer: Peer) {
    try {
      const hub = await live(peer.request);
      await hub.open(peer);
      sessions.set(peer.id, hub);
    } catch { peer.close(4403, "浏览器连接已失效"); }
  },
  async message(peer, message) { await sessions.get(peer.id)?.message(peer, message.text()); },
  close(peer) {
    void sessions.get(peer.id)?.sessions.get(peer.id)?.close();
    sessions.delete(peer.id);
  },
  error(peer) {
    void sessions.get(peer.id)?.sessions.get(peer.id)?.close(1011, "浏览器连接已中断");
    sessions.delete(peer.id);
  },
});
