import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  assert,
  object,
  request,
  nativeArguments,
  readChunk,
  type Obj,
} from "./util";
import type { Model } from "./config";
const LIMIT = 32 << 20;
export const varint = (value: number | bigint) => {
  let n = BigInt(value);
  const b = [];
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n) byte |= 128;
    b.push(byte);
  } while (n);
  return Buffer.from(b);
};
export const fieldNumber = (field: number, value: number) =>
  Buffer.concat([varint(field * 8), varint(value)]);
export const fieldBytes = (field: number, value: string | Uint8Array) => {
  const b = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
};
const double = (field: number, value: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  return Buffer.concat([varint(field * 8 + 1), b]);
};
export const envelope = (payload: Uint8Array, flags = 0) => {
  const b = Buffer.alloc(5);
  b[0] = flags;
  b.writeUInt32BE(payload.length, 1);
  return Buffer.concat([b, payload]);
};
export function decodeProto(input: Uint8Array): [number, bigint | Buffer][] {
  const b = Buffer.from(input),
    fields: [number, bigint | Buffer][] = [];
  let at = 0;
  const read = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      assert(at < b.length, "Truncated protobuf varint");
      const byte = b[at++];
      assert(shift !== 63n || byte <= 1, "Protobuf varint overflow");
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw Error("Protobuf varint overflow");
  };
  while (at < b.length) {
    const tag = read(),
      field = Number(tag >> 3n),
      wire = Number(tag & 7n);
    assert(field > 0 && field < 1 << 29, "Invalid protobuf field");
    if (wire === 0) {
      fields.push([field, read()]);
      continue;
    }
    assert([1, 2, 5].includes(wire), "Invalid protobuf wire type");
    const size = wire === 2 ? Number(read()) : wire === 1 ? 8 : 4;
    assert(
      Number.isSafeInteger(size) && size >= 0 && at + size <= b.length,
      "Truncated protobuf bytes",
    );
    const value = b.subarray(at, at + size);
    at += size;
    if (wire === 2) fields.push([field, value]);
  }
  return fields;
}
const utf8 = (v: Buffer | bigint) => {
  assert(Buffer.isBuffer(v), "Expected protobuf bytes");
  return new TextDecoder("utf-8", { fatal: true }).decode(v);
};
export function encodeDevin(body: Obj, key: string, version: string) {
  const out: Buffer[] = [],
    metadata: Buffer[] = [];
  for (const [f, v] of [
    [1, "nova-openai"],
    [2, version],
    [3, key],
    [4, "en"],
    [5, process.platform],
    [7, version],
    [12, "chisel"],
    [28, "chisel"],
  ] as [number, string][])
    metadata.push(fieldBytes(f, v));
  out.push(fieldBytes(1, Buffer.concat(metadata)));
  const systems: string[] = [];
  assert(Array.isArray(body.messages), "Devin messages required");
  for (const message of body.messages) {
    const role = message.role;
    assert(
      ["user", "assistant", "tool", "system", "developer"].includes(role),
      "Invalid Devin role",
    );
    const msg = [
        fieldBytes(1, randomUUID()),
        fieldNumber(
          2,
          role === "user"
            ? 1
            : role === "assistant"
              ? 2
              : role === "tool"
                ? 4
                : 0,
        ),
      ],
      texts: string[] = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "image_url") {
          const match =
            /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(
              part.image_url?.url,
            );
          assert(match && match[2].length <= LIMIT, "Invalid Devin image");
          assert(
            Buffer.from(match[2], "base64").length <= LIMIT / 2,
            "Devin image exceeds 16MiB",
          );
          msg.push(
            fieldBytes(
              10,
              Buffer.concat([fieldBytes(1, match[2]), fieldBytes(2, match[1])]),
            ),
          );
        } else throw Error("Unsupported Devin content type");
      }
    } else if (typeof message.content === "string") texts.push(message.content);
    if (["system", "developer"].includes(role)) {
      systems.push(texts.join("\n"));
      continue;
    }
    msg.push(fieldBytes(3, texts.join("\n")));
    if (typeof message.reasoning_content === "string" && message.reasoning_content)
      msg.push(fieldBytes(5, message.reasoning_content));
    for (const call of message.tool_calls || [])
      msg.push(
        fieldBytes(
          6,
          Buffer.concat([
            fieldBytes(1, call.id),
            fieldBytes(2, call.function.name),
            fieldBytes(3, call.function.arguments),
          ]),
        ),
      );
    if (message.tool_call_id) msg.push(fieldBytes(7, message.tool_call_id));
    out.push(fieldBytes(3, Buffer.concat(msg)));
  }
  const temperature = body.temperature ?? 1,
    top = body.top_p ?? 0.95;
  assert(
    temperature >= 0 && temperature <= 2 && top >= 0 && top <= 1,
    "Invalid Devin sampling",
  );
  out.push(
    fieldBytes(2, systems.join("\n\n")),
    fieldNumber(7, 5),
    fieldBytes(
      8,
      Buffer.concat([
        fieldNumber(1, 1),
        fieldNumber(
          2,
          Math.max(
            32,
            Math.min(
              128000,
              body.max_completion_tokens || body.max_tokens || 128000,
            ),
          ),
        ),
        fieldNumber(3, 400),
        double(5, temperature),
        fieldNumber(7, 40),
        double(8, top),
      ]),
    ),
  );
  for (const tool of body.tools || [])
    out.push(
      fieldBytes(
        10,
        Buffer.concat([
          fieldBytes(1, tool.function.name),
          fieldBytes(2, tool.function.description || ""),
          fieldBytes(3, JSON.stringify(tool.function.parameters)),
        ]),
      ),
    );
  out.push(
    fieldBytes(
      15,
      Buffer.concat([
        fieldBytes(1, randomUUID()),
        fieldNumber(3, 4),
        fieldNumber(4, 14),
      ]),
    ),
    fieldBytes(16, randomUUID()),
    fieldNumber(20, 1),
    fieldBytes(21, body.model),
    fieldBytes(22, randomUUID()),
    fieldBytes(28, "nova-api"),
  );
  const payload = Buffer.concat(out);
  assert(payload.length <= LIMIT, "Devin request exceeds 32MiB");
  return envelope(payload);
}
export class ConnectDecoder {
  buffer = Buffer.alloc(0);
  total = 0;
  expanded = 0;
  ended = false;
  push(chunk: Uint8Array) {
    this.total += chunk.length;
    assert(this.total <= LIMIT, "Devin response exceeds 32MiB");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 5) {
      const flags = this.buffer[0],
        size = this.buffer.readUInt32BE(1);
      assert(
        flags <= 3 && size <= LIMIT && !this.ended,
        "Invalid Connect frame",
      );
      if (this.buffer.length < size + 5) break;
      let payload = this.buffer.subarray(5, size + 5);
      this.buffer = this.buffer.subarray(size + 5);
      if (flags & 1)
        payload = gunzipSync(payload, {
          maxOutputLength: LIMIT - this.expanded,
        });
      this.expanded += payload.length;
      assert(
        this.expanded <= LIMIT,
        "Decompressed Devin response exceeds limit",
      );
      if (flags & 2) {
        const trailer = object(JSON.parse(payload.toString()));
        assert(
          !trailer.error,
          `Devin rejected request: ${trailer.error?.code || "upstream_error"}`,
        );
        this.ended = true;
      } else frames.push(payload);
    }
    return frames;
  }
  finish() {
    assert(
      this.ended && !this.buffer.length,
      "Devin stream interrupted: missing complete Connect trailer",
    );
  }
}
export async function devinStream(
  model: Model,
  body: Obj,
  version: string,
  signal: AbortSignal,
  emit: (type: string, data: any) => void,
) {
  const url = new URL(
    "/exa.api_server_pb.ApiServerService/GetChatMessage",
    model.baseURL,
  ).href;
  const response = await request(url, {
    method: "POST",
    body: encodeDevin(body, model.apiKey, version),
    headers: {
      ...model.headers,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-accept-encoding": "gzip",
    },
    signal,
  }, 0);
  assert(response.ok, `Devin upstream HTTP ${response.status}`);
  assert(
    response.headers
      .get("content-type")
      ?.startsWith("application/connect+proto"),
    "Devin response is not Connect/Protobuf",
  );
  assert(response.body, "Missing Devin stream");
  const decoder = new ConnectDecoder(),
    reader = response.body.getReader(),
    calls: { id: string; name: string; args: string }[] = [],
    indexes = new Map<string, number>();
  let current = -1,
    stop: number | undefined,
    text = "",
    thinking = "",
    usage: Obj = {};
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await readChunk(reader, signal);
      if (done) break;
      emit("activity", null);
      for (const frame of decoder.push(value)) {
        for (const [field, v] of decodeProto(frame)) {
          if (field === 3 || field === 9) {
            const delta = utf8(v);
            if (field === 3) text += delta;
            else thinking += delta;
            emit(field === 3 ? "text_delta" : "thinking_delta", delta);
          } else if (field === 5) {
            assert(typeof v === "bigint", "Invalid Devin stop type");
            const n = Number(v);
            assert(
              [0, 1, 2, 3, 4, 10].includes(n),
              "Unknown Devin stop reason",
            );
            if ([3, 10].includes(n) || stop === undefined) stop = n;
          } else if (field === 6) {
            assert(Buffer.isBuffer(v), "Invalid tool fragment");
            let cid = "",
              name = "",
              args = "";
            {
              const fragment = v;
              for (const [f, value] of decodeProto(fragment)) {
                if (f === 1) cid += utf8(value);
                if (f === 2) name += utf8(value);
                if (f === 3) args += utf8(value);
              }
            }
            if (cid) {
              if (!indexes.has(cid)) {
                indexes.set(cid, calls.length);
                calls.push({ id: cid, name: "", args: "" });
              }
              current = indexes.get(cid)!;
            }
            assert(current >= 0, "Devin tool has no call ID");
            calls[current].name += name;
            calls[current].args += args;
          } else if (field === 7) {
            assert(Buffer.isBuffer(v), "Invalid usage");
            const u = Object.fromEntries(
              decodeProto(v).map(([k, v]) => [k, Number(v)]),
            );
            usage = {
              input: Math.max(0, (u[2] || 0) - (u[5] || 0)),
              output: u[3] || 0,
              cacheRead: u[5] || 0,
              cacheWrite: 0,
              totalTokens: (u[2] || 0) + (u[3] || 0),
            };
          }
        }
      }
    }
    decoder.finish();
  } finally {
    await reader.cancel().catch(() => {});
  }
  assert(!(stop === 10 && !calls.length), "Devin tool handoff missing calls");
  assert(
    !(stop === 3 && calls.length),
    "Devin tool arguments truncated; tools were not dispatched",
  );
  const validated = calls.map((c) => {
    assert(
      body.tools?.some((t: Obj) => t.function.name === c.name),
      "Devin returned an undeclared tool",
    );
    const arguments_ = nativeArguments(c.args);
    assert(
      arguments_ &&
        typeof arguments_ === "object" &&
        !Array.isArray(arguments_),
      "Invalid Devin tool arguments",
    );
    return { id: c.id, name: c.name, arguments: arguments_ };
  });
  return {
    role: "assistant",
    text,
    thinking,
    calls: validated,
    usage,
    stop: stop === 3 ? "length" : "stop",
    model: model.selection,
  };
}
