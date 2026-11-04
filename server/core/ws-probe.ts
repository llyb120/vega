/**
 * Protocol-level liveness and backpressure for a crossws peer. Browsers and gorilla/websocket answer WebSocket
 * pings in their network stack, so this keeps working for throttled background tabs and during large writes.
 */
export type Probe = {
  /** Bytes queued for this peer and not yet written to the socket. */
  readonly buffered: number;
  /** Sends a ping; false when the previous ping never got a pong (the peer is gone or wedged). */
  ping(): boolean;
  terminate(): void;
};
type RawSocket = {
  ping(): void;
  on(event: "pong", listener: () => void): void;
  bufferedAmount: number;
  terminate(): void;
};
export function probe(peer: unknown, onPong?: () => void): Probe | undefined {
  const ws = (peer as { _internal?: { ws?: RawSocket } })?._internal?.ws;
  if (!ws || typeof ws.ping !== "function" || typeof ws.on !== "function") return;
  let answered = true;
  ws.on("pong", () => {
    answered = true;
    onPong?.();
  });
  return {
    get buffered() {
      return Number(ws.bufferedAmount) || 0;
    },
    ping() {
      if (!answered) return false;
      answered = false;
      try {
        ws.ping();
      } catch {
        return false;
      }
      return true;
    },
    terminate() {
      try {
        ws.terminate();
      } catch {}
    },
  };
}
