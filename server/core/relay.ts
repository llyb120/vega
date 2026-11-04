import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import type { Store } from "./store";
import type { Employee, Owner } from "./employee";
import {
  assert,
  id,
  expand,
  request,
  bounded,
  sse,
  sleep,
  type Obj,
} from "./util";
export function decodeRelayFrame(text: string) {
  const value = JSON.parse(text);
  if (value.encoding === "gzip" || value.encoding === "gzip-base64") {
    assert(typeof value.data === "string", "gzip SSE event missing data");
    return JSON.parse(
      gunzipSync(Buffer.from(value.data, "base64"), {
        maxOutputLength: 32 << 20,
      }).toString(),
    );
  }
  return value;
}
export function legacyRelayData(value: any) {
  if (typeof value?._z === "string") {
    try {
      return JSON.parse(
        inflateRawSync(Buffer.from(value._z, "base64"), {
          maxOutputLength: 32 << 20,
        }).toString(),
      );
    } catch {
      return value;
    }
  }
  return value;
}
export class Relay {
  abort?: AbortController;
  peers: any[] = [];
  connected = false;
  epoch = id();
  pending = new Map<
    string,
    {
      peer: string;
      resolve: (v: any) => void;
      reject: (e: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  tail = Promise.resolve();
  device: string;
  onStatus: (data: any) => void = () => {};
  constructor(
    public store: Store,
    public employee: Employee,
  ) {
    this.device = store.get("relay:device", "") || id();
    store.put("relay:device", this.device);
  }
  cfg() {
    return this.store.get<Obj>("config", {}).relay || {};
  }
  headers() {
    const cfg = this.cfg(),
      token = expand(cfg.token || "");
    assert(cfg.server && token, "Configure relay server and token");
    return {
      Authorization: "Bearer " + token,
      "X-Relay-Name-Encoded": encodeURIComponent(
        token.split("/")[0] || cfg.name || "Vega",
      ),
      "X-Relay-Groups-Encoded": encodeURIComponent(
        [
          ...new Set(
            String(cfg.groups || "")
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        ].join(","),
      ),
      "X-Relay-Device": this.device,
      "X-Relay-Version": "0.2.0",
    };
  }
  restart() {
    this.abort?.abort();
    this.abort = new AbortController();
    const cfg = this.cfg();
    if (!cfg.server || !cfg.token) return;
    void this.loop(this.abort.signal);
  }
  close() {
    this.abort?.abort();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Relay closed"));
    }
    this.pending.clear();
  }
  async loop(signal: AbortSignal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const cfg = this.cfg(),
          state = this.store.get("relay:cursor", { seq: 0, serverEpoch: "" }),
          url = new URL(cfg.server.replace(/\/$/, "") + "/v2/events");
        url.searchParams.set("since", String(state.seq));
        url.searchParams.set("serverEpoch", state.serverEpoch);
        const response = await request(
          url.href,
          {
            headers: {
              ...this.headers(),
              Accept: "text/event-stream",
              "Accept-Encoding": "identity",
              "X-Nova-SSE-Topics": "relay,remote",
              "X-Nova-SSE-Encoding": "gzip-base64",
              "Cache-Control": "no-cache",
            },
            signal,
          },
          0,
          20000,
        );
        assert(response.ok, `Relay SSE HTTP ${response.status}`);
        this.connected = true;
        this.onStatus({ connected: true });
        backoff = 1000;
        for (const employee of this.employee.all()) for (const task of employee.state().tasks)
          if (task.status === "waiting" && task.owner.token)
            void this.send(task.owner.token, "starlink.help", {
              id: task.id,
              task: task.text,
              question: task.waiting,
              vaultKey: task.vaultPk || "",
            });
        for await (const chunk of sse(response, signal, 45000, 32 << 20)) {
          if (!chunk.data) continue;
          const frame = decodeRelayFrame(chunk.data);
          if (frame.op === "ready") {
            if (Number.isSafeInteger(frame.lastSeq)) state.seq = frame.lastSeq;
            if (frame.serverEpoch) state.serverEpoch = frame.serverEpoch;
            this.store.put("relay:cursor", state);
          }
          if (frame.op === "event") {
            const event = frame.event;
            if (event.seq && event.seq <= state.seq) continue;
            event.data = legacyRelayData(event.data);
            await this.dispatch(event);
            if (event.seq) {
              state.seq = event.seq;
              this.store.put("relay:cursor", state);
            }
          }
        }
      } catch (e: any) {
        if (signal.aborted) return;
        this.onStatus({ connected: false, error: e.message });
      }
      this.connected = false;
      await sleep(backoff + Math.random() * 500, signal).catch(() => {});
      backoff = Math.min(30000, backoff * 2);
    }
  }
  async send(to: string, type: string, data: any) {
    const messageId = id();
    const perform = async () => {
      let last: any;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const cfg = this.cfg(),
            frame = {
              version: 2,
              op: "send",
              messageId,
              epoch: this.epoch,
              threadId: data.guestThreadId || data.hostThreadId || "",
              to,
              type,
              data,
            },
            raw = Buffer.from(JSON.stringify(frame)),
            compressed = raw.length >= 1024;
          const response = await request(
            cfg.server.replace(/\/$/, "") + "/v2/send",
            {
              method: "POST",
              headers: {
                ...this.headers(),
                "Content-Type": "application/json",
                ...(compressed ? { "Content-Encoding": "gzip" } : {}),
              },
              body: compressed ? gzipSync(raw) : raw,
              signal: this.abort?.signal,
            },
            30000,
          );
          assert(response.ok, `Relay send HTTP ${response.status}`);
          if (response.status === 204) return { messageId };
          const ack = JSON.parse((await bounded(response)).toString());
          assert(!ack.error, ack.error);
          return ack;
        } catch (e) {
          last = e;
          if (this.abort?.signal.aborted) throw e;
          await sleep(200 * 2 ** attempt, this.abort?.signal);
        }
      }
      throw last;
    };
    const result = this.tail.then(perform, perform);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async call(peer: string, command: string, args: Obj) {
    const reqId = id();
    if (["employee_do", "employee_say"].includes(command))
      this.employee.update((s) => {
        if (!s.links.includes(peer)) s.links.push(peer);
      });
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(Error("Peer did not respond (offline/private/old version)"));
      }, 30000);
      this.pending.set(reqId, { peer, resolve, reject, timer });
      void this.send(peer, "starlink.call", { reqId, command, args }).catch(
        (error) => {
          clearTimeout(timer);
          this.pending.delete(reqId);
          reject(error);
        },
      );
    });
  }
  async dispatch(event: Obj) {
    if (event.type === "presence") {
      this.peers = event.data?.peers || [];
      this.onStatus({ peers: this.peers });
      return;
    }
    const from: Owner = {
        token: event.from,
        name: event.from?.split("/")[0] || event.fromName || "",
      },
      data = event.data || {};
    if (event.type === "starlink.result") {
      const pending = this.pending.get(data.reqId);
      if (pending && pending.peer === from.token) {
        clearTimeout(pending.timer);
        this.pending.delete(data.reqId);
        if (data.error) pending.reject(Error(data.error));
        else pending.resolve(data.value);
      }
      return;
    }
    if (event.type === "starlink.call") {
      try {
        const value = await this.serve(from, data.command, data.args || {});
        await this.send(from.token, "starlink.result", {
          reqId: data.reqId,
          value,
        });
      } catch (e: any) {
        await this.send(from.token, "starlink.result", {
          reqId: data.reqId,
          error: e.message,
        });
      }
      return;
    }
    if (event.type?.startsWith("starlink.")) {
      const employee = event.type === "starlink.reply"
        ? this.employee.all().find((employee) => employee.findTask(data.id)) || this.employee
        : this.employee;
      await employee.remote(from, event.type, data);
    }
  }
  async serve(owner: Owner, command: string, args: Obj) {
    const employee = this.employee.for(args.employeeId || "default");
    assert(employee.state().public, "Employee is not public");
    if (command === "info") {
      return {
        status: "ready",
        tasks: employee.store.activeTaskCount(employee.employeeId),
      };
    }
    if (command === "employee_get") {
      const s = employee.state();
      return {
        id: s.id, name: s.name, public: s.public,
        duties: [], memories: [], runs: [], orbit: [], links: [],
        tasks: s.tasks.filter((task) => task.owner.token === owner.token).map(({ checkpoint, ...task }) => task),
      };
    }
    if (command === "employee_say")
      return (
        await employee.execute(
          "",
          { action: "add", kind: "todo", text: args.text },
          owner,
        )
      ).value;
    if (command === "employee_do") {
      const aliases: Obj = {
        continue: "resume",
        retry: "resume",
        rerun: "redispatch",
        delete: "remove",
        supply: "answer",
      };
      return employee.control(
        { ...args, action: aliases[args.action] || args.action },
        owner,
      );
    }
    if (command === "transcript") {
      let taskId = "";
      try { taskId = employee.store.session(args.threadId).taskId || ""; } catch {}
      const task = employee.findTask(taskId);
      assert(task && (task.workSession === args.threadId || task.computerSession === args.threadId), "Only the assigning member may view this task");
      assert(task?.owner.token === owner.token, "Only the assigning member may view this task");
      return employee.transcript(args.threadId);
    }
    throw Error("Unsupported employee team command");
  }
}
