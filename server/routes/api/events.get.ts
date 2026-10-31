import { defineWebSocketHandler } from "h3";
import { useNitroApp } from "nitropack/runtime";
import { app } from "../../core/application";

export default defineWebSocketHandler({
  upgrade(request) {
    try {
      app().eventsSocket.authorize(request);
    } catch {
      return new Response("Realtime connection denied", { status: 403 });
    }
  },
  open(peer) {
    try {
      app().eventsSocket.open(peer);
    } catch {
      peer.close(4403, "实时连接已失效");
    }
  },
  message(peer, message) {
    const request = peer.request;
    app().eventsSocket.message(peer, message.text(), (method, path, body, signal, csrf) =>
      useNitroApp().localFetch("/api" + path, {
        method,
        headers: {
          cookie: request.headers.get("cookie") || "",
          origin: request.headers.get("origin") || "",
          host: request.headers.get("host") || "",
          "sec-fetch-site": "same-origin",
          "x-csrf-token": csrf,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body,
        signal,
        redirect: "manual",
      }),
    );
  },
  close(peer) {
    app().eventsSocket.close(peer.id);
  },
  error(peer) {
    app().eventsSocket.close(peer.id);
  },
});
