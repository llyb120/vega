import { connect } from "node:net";

export const MAX_FRAME = 96 * 1024 * 1024;
export function encode(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
export function decode(value) {
  if (value && typeof value.$bytes === "string") return Buffer.from(value.$bytes, "base64");
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  return value;
}
export function frames(socket, receive) {
  let chunks = [], size = 0;
  socket.on("data", (chunk) => {
    try {
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const part = chunk.subarray(start, end);
        if (size + part.length > MAX_FRAME) throw Error("Cloud frame too large");
        const data = chunks.length ? Buffer.concat([...chunks, part]) : part;
        chunks = []; size = 0;
        receive(JSON.parse(data.toString("utf8")));
        start = end + 1;
      }
      if (start < chunk.length) {
        chunks.push(chunk.subarray(start)); size += chunk.length - start;
        if (size > MAX_FRAME) throw Error("Cloud frame too large");
      }
    } catch (error) { socket.destroy(error); }
  });
}
export function send(socket, value) { return socket.write(JSON.stringify(value) + "\n"); }
export function cloudRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath), output = [];
    let size = 0, finished = false;
    const timer = setTimeout(() => socket.destroy(Error("Cloud operation timed out")), 60000);
    const done = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.once("connect", () => send(socket, encode(request)));
    socket.on("error", (error) => done(error));
    socket.on("close", () => { if (!finished) done(Error("Cloud executor disconnected; operation was not retried")); });
    frames(socket, (message) => {
      if (message.error) return done(Object.assign(Error(message.error), { code: message.code }));
      if (message.healthy !== undefined) return done(undefined, message.healthy);
      if (message.identity) return done(undefined, message.identity);
      if (message.fd === 1) {
        const part = Buffer.from(message.data, "base64"); size += part.length;
        if (size > MAX_FRAME) return done(Error("Cloud result too large"));
        output.push(part);
      }
      if (message.exit !== undefined) {
        try {
          const result = decode(JSON.parse(Buffer.concat(output).toString("utf8")));
          if (result.error) done(Object.assign(Error(result.error), { code: result.code }));
          else if (message.exit !== 0) done(Error("Cloud worker failed"));
          else done(undefined, result.value);
        } catch (error) { done(error); }
      }
    });
  });
}
