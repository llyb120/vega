import { connect } from "node:net";
import { createReadStream, createWriteStream } from "node:fs";
import { frames, send } from "../shared/cloud-wire.mjs";

// No credentials or launch parameters in argv; this proxy remains the service UID, never the tenant UID.
const request = JSON.parse(process.env.VEGA_CLOUD_REQUEST || "null");
if (!request) throw Error("Cloud launch request missing");
const socket = connect(process.env.VEGA_CLOUD_SOCKET || "/run/vega/cloud.sock");
let finished = false, started = false;
const streams = new Map([[1, process.stdout], [2, process.stderr]]);
const inputs = [];
function stop(message) {
  if (finished) return;
  finished = true;
  if (message) process.stderr.write(String(message) + "\n");
  socket.destroy();
  for (const input of inputs) input.destroy();
  process.exit(message ? 1 : 0);
}
const timer = setTimeout(() => stop("Cloud executor startup timed out"), 30000);
socket.on("connect", () => send(socket, request));
socket.on("error", (error) => stop(error.message));
socket.on("close", () => { if (!finished) stop("Cloud executor disconnected; command was not retried"); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop());
frames(socket, (message) => {
  if (message.error) return stop(message.error);
  if (message.ready && !started) {
    started = true; clearTimeout(timer);
    for (const fd of request.pipes ? [0, 3] : [0]) {
      const input = fd === 0 ? process.stdin : createReadStream(null, { fd, autoClose: true });
      inputs.push(input);
      input.on("data", (data) => { if (!send(socket, { fd, data: data.toString("base64") })) input.pause(); });
      input.on("end", () => send(socket, { fd, end: true }));
      input.on("error", () => send(socket, { fd, end: true }));
      socket.on("drain", () => input.resume());
    }
    if (request.pipes) streams.set(4, createWriteStream(null, { fd: 4, autoClose: false }));
  }
  if (Number.isInteger(message.fd) && streams.has(message.fd)) {
    const output = streams.get(message.fd);
    if (!output.write(Buffer.from(message.data, "base64"))) {
      socket.pause(); output.once("drain", () => socket.resume());
    }
  }
  if (message.exit !== undefined) {
    finished = true; clearTimeout(timer); socket.destroy();
    for (const input of inputs) input.destroy();
    const code = message.exit === 0 ? 0 : message.exit || 1;
    Promise.all([...streams.values()].map((stream) => new Promise((yes) => stream.write("", yes)))).then(() => process.exit(code));
  }
});
