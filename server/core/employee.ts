import { systemPresence, type Presence } from "./presence";
import type { Store } from "./store";
import { assert, id, clone, clip, type Obj } from "./util";
import { Vault } from "./vault";
export type Owner = { token: string; name: string };
export type Task = Obj & {
  id: string;
  text: string;
  status: string;
  createdAt: number;
  profile: string;
  cwd: string;
  owner: Owner;
};
export type EmployeeState = {
  enabled: boolean;
  public: boolean;
  workStart: string;
  workEnd: string;
  idleMinutes: number;
  takeoverSeconds: number;
  desktopAskAfter: number;
  cwd: string;
  duties: Obj[];
  tasks: Task[];
  memories: Obj[];
  runs: Obj[];
  orbit: Obj[];
  links: string[];
};
export const ended = (status: string) =>
  ["done", "failed", "stopped", "cancelled"].includes(status);
const hhmm = (s: any) =>
  typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const profile = (s: string = "lightweight") =>
  (
    ({
      轻量化: "lightweight",
      编码: "coding",
      电脑: "computer",
      剑来: "computer",
    }) as Obj
  )[s] ||
  s ||
  "lightweight";
export function requestedTime(a: Obj, now = Date.now()) {
  if (a.nextAt !== undefined) {
    assert(
      typeof a.nextAt === "string" &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(a.nextAt),
      "nextAt must be local YYYY-MM-DD HH:MM",
    );
    const parsed = new Date(a.nextAt.replace(" ", "T") + ":00");
    assert(
      parsed.getTime() > now &&
        `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")} ${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}` ===
          a.nextAt,
      "nextAt must be a valid future local time",
    );
    return parsed.getTime();
  }
  if (a.nextCheckInMinutes !== undefined) {
    assert(
      Number.isInteger(a.nextCheckInMinutes) &&
        a.nextCheckInMinutes >= 1 &&
        a.nextCheckInMinutes <= 10080,
      "nextCheckInMinutes must be 1–10080",
    );
    return now + a.nextCheckInMinutes * 60000;
  }
  return 0;
}
export function applyDuty(d: Obj, a: Obj, now = Date.now()) {
  for (const k of ["text", "note"])
    if (k in a) {
      assert(typeof a[k] === "string", `${k} must be text`);
      d[k] = a[k].trim();
    }
  if ("profile" in a) {
    d.profile = profile(a.profile);
    assert(["lightweight", "coding"].includes(d.profile), "Invalid profile");
  }
  for (const k of ["enabled", "manual"])
    if (k in a) {
      assert(typeof a[k] === "boolean", `${k} must be boolean`);
      d[k] = a[k];
    }
  if (a.manual === true) {
    d.times = [];
    d.events = [];
    d.everyMinutes = 0;
    d.nextCheckAt = 0;
    d.pending = [];
    d.eventAt = 0;
  }
  if ("times" in a) {
    assert(
      Array.isArray(a.times) && a.times.every(hhmm),
      "times must contain HH:MM values",
    );
    const times = [...new Set(a.times)].sort();
    if (JSON.stringify(times) !== JSON.stringify(d.times)) {
      d.times = times;
      d.firedAt = now;
    }
  }
  if ("everyMinutes" in a) {
    assert(
      Number.isInteger(a.everyMinutes) &&
        a.everyMinutes >= 0 &&
        a.everyMinutes <= 10080,
      "everyMinutes must be 0–10080",
    );
    d.everyMinutes = a.everyMinutes;
  }
  assert(
    !(d.everyMinutes && d.times?.length),
    "times and everyMinutes are mutually exclusive",
  );
  if ("events" in a) {
    assert(
      Array.isArray(a.events) &&
        a.events.every((e: string) =>
          ["orbit.added", "orbit.done", "orbit.changed"].includes(e),
        ),
      "Unknown duty event",
    );
    d.events = [...new Set(a.events)];
    d.pending = [];
    d.eventAt = 0;
  }
  assert(
    !(d.manual && (d.everyMinutes || d.times?.length || d.events?.length)),
    "manual duties cannot have auto triggers; set manual=false first",
  );
  const at = requestedTime(a, now);
  if (at) {
    assert(
      !d.manual && !d.everyMinutes && !d.times?.length && !d.events?.length,
      "Only dynamic duties use nextAt",
    );
    d.nextCheckAt = at;
  }
  assert(
    typeof d.text === "string" && d.text.trim() && [...d.text].length <= 8000,
    "Duty text requires 1–8000 characters",
  );
  assert(
    Buffer.byteLength(d.note || "") <= 4096,
    "Duty note exceeds 4096 bytes",
  );
}
export function retention(m: Obj, now = Date.now()) {
  return m.importance >= 3
    ? 1
    : Math.exp(
        -Math.max(0, now - Math.max(m.at || 0, m.usedAt || 0)) /
          86400000 /
          (5 * Math.max(1, m.strength || 1) * Math.max(1, m.importance || 1)),
      );
}
function bigrams(s: string) {
  const a = [...s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
  return new Set(a.slice(1).map((c, i) => a[i] + c));
}
export function recallMemory(
  state: EmployeeState,
  task: string,
  now = Date.now(),
) {
  state.memories = state.memories.filter((m) => retention(m, now) >= 0.05);
  const words = bigrams(task),
    r = state.memories.map((m) => {
      const own = bigrams(m.text);
      return own.size
        ? [...own].filter((v) => words.has(v)).length / own.size
        : 0;
    }),
    top = Math.max(0, ...r),
    scored = state.memories
      .map((m, i) => ({
        m,
        r: r[i],
        score:
          (top ? (3 * r[i]) / top : 0) +
          (Math.max(1, m.importance) - 1) +
          0.5 * retention(m, now),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  for (const { m, r } of scored)
    if (r >= 0.2) {
      m.strength = Math.max(1, m.strength) + 1;
      m.usedAt = now;
    }
  return scored.map((v) => v.m);
}
export function nextFixed(times: string[], after: number) {
  const base = new Date(after),
    values = [];
  for (let days = 0; days < 3; days++)
    for (const s of times) {
      const [h, m] = s.split(":").map(Number),
        date = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + days,
          h,
          m,
        );
      if (date.getTime() > after) values.push(date.getTime());
    }
  return Math.min(...values);
}
export function workSlot(start: string, end: string, now: number) {
  assert(hhmm(start) && hhmm(end), "Work hours require HH:MM");
  const d = new Date(now),
    hm = d.toTimeString().slice(0, 5),
    open =
      start === end ||
      (start < end ? hm >= start && hm < end : hm >= start || hm < end);
  if (open) return now;
  const [h, m] = start.split(":").map(Number),
    next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}
export type EmployeeRuntime = {
  run: (session: string, text: string) => Promise<void>;
  cancel: (session: string) => void;
  isRunning: (session: string) => boolean;
  emit: (type: string, data?: any) => void;
  send: (to: string, type: string, data: any) => Promise<any>;
  config: () => Obj;
  presence?: () => Promise<Presence>;
};
export class Employee {
  busy = new Map<string, { computer: boolean; session: string }>();
  timer?: ReturnType<typeof setTimeout>;
  closed = false;
  takeovers = new Map<string, { until: number; accepted: boolean }>();
  lastActivity = Date.now();
  locked = false;
  nativePresence?: Presence;
  constructor(
    public store: Store,
    public vault: Vault,
    public runtime: EmployeeRuntime,
  ) {}
  // shortcut: task history shares one SQLite document; normalize tasks when histories become large.
  state(): EmployeeState {
    return this.store.get("employee", {
      enabled: false,
      public: false,
      workStart: "09:00",
      workEnd: "18:00",
      idleMinutes: 10,
      takeoverSeconds: 15,
      desktopAskAfter: 0,
      cwd: process.cwd(),
      duties: [],
      tasks: [],
      memories: [],
      runs: [],
      orbit: [],
      links: [],
    });
  }
  update<T>(fn: (s: EmployeeState) => T): T {
    const result = this.store.transaction(() => {
      const s = this.state(),
        value = fn(s);
      this.store.put("employee", s);
      return value;
    });
    this.runtime.emit("employee_changed");
    this.schedule();
    return result;
  }
  start() {
    this.closed = false;
    this.update((s) => {
      for (const t of s.tasks)
        if (t.status === "running") {
          t.status = "queued";
          t.nextCheckAt = 0;
          t.answer =
            "服务中断后在同一任务续做。检查已发生的外部操作，不要重放提交/发送；工具历史中的中断结果不是未执行证明。";
        }
      for (const r of s.runs)
        if (r.status === "running") {
          r.status = "stopped";
          r.ended = Date.now();
        }
    });
    this.schedule();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const run of this.busy.values()) this.runtime.cancel(run.session);
  }
  schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        void this.tick().catch((e) => {
          this.runtime.emit("employee_error", e.message);
          this.timer = setTimeout(() => this.schedule(), 300000);
        }),
      0,
    );
  }
  task(s: EmployeeState, key: string) {
    const t = s.tasks.find((t) => t.id === key);
    assert(t, "Task not found");
    return t;
  }
  authorize(s: EmployeeState, caller: string, a: Obj) {
    if (!caller) return undefined;
    const t = this.task(s, caller);
    assert(
      t.status === "running" && this.busy.has(caller),
      "Task is no longer running",
    );
    const action = a.action;
    if (
      [
        "list",
        "ask",
        "help",
        "defer",
        "progress",
        "relay",
        "remember",
        "forget",
        "vault_list",
        "vault_get",
        "vault_request",
        "vault_send",
        "orbit_list",
        "orbit_add",
        "orbit_done",
      ].includes(action)
    )
      return t;
    if (action === "add") {
      assert(a.kind === "todo", "Task cannot create duties");
      return t;
    }
    if (action === "update") {
      if (a.id === t.id)
        assert(
          Object.keys(a).every((k) =>
            ["action", "id", "nextAt", "nextCheckInMinutes"].includes(k),
          ),
          "Task may only reschedule itself",
        );
      else {
        assert(a.id === t.dutyId, "Task can only update itself or its duty");
        const d = s.duties.find((d) => d.id === a.id);
        assert(d, "Duty missing");
        assert(
          Object.entries(a).every(
            ([k, v]) =>
              ["action", "id"].includes(k) ||
              (k === "enabled" && v === false) ||
              (["nextAt", "nextCheckInMinutes"].includes(k) &&
                !d.manual &&
                !d.everyMinutes &&
                !d.times?.length &&
                !d.events?.length),
          ),
          "Cannot modify user-owned duty text, note or fixed rules",
        );
      }
      return t;
    }
    throw Error("Action is user-only");
  }
  async execute(
    caller: string,
    a: Obj,
    owner: Owner = { token: "", name: "" },
  ): Promise<{ value: any; stop?: boolean; secret?: string }> {
    const action = a.action;
    assert(typeof action === "string", "employee action required");
    if (a.text !== undefined)
      assert(
        typeof a.text === "string" && [...a.text].length <= 8000,
        "text exceeds 8000",
      );
    const initial = this.state(),
      current = this.authorize(initial, caller, a);
    if (
      action.startsWith("vault_") &&
      !["vault_request", "vault_send"].includes(action)
    ) {
      if (action === "vault_list")
        return { value: { entries: this.vault.list() } };
      if (action === "vault_get") {
        const value = this.vault.get(a.id, a.text, caller);
        return {
          value: {
            name: value.name,
            condition: value.condition,
            content:
              "[withheld from transcript; available only to current turn]",
          },
          secret: JSON.stringify(value),
        };
      }
      assert(!caller, "Only user can modify vault");
      if (action === "vault_save") return { value: this.vault.save(a) };
      if (action === "vault_delete") {
        this.vault.remove(a.id);
        return { value: { ok: true } };
      }
      throw Error("Unknown vault action");
    }
    let stop = false,
      pendingSend: { to: string; type: string; data: any } | undefined;
    const value = this.update((s) => {
      const t = caller ? this.authorize(s, caller, a) : undefined,
        now = Date.now(),
        content = String(a.text || "").trim(),
        get = () => this.task(s, a.id);
      switch (action) {
        case "list":
          return {
            now: new Date(now).toLocaleString(),
            duties: s.duties,
            inbox: s.tasks.filter((t) => !ended(t.status)),
            tasks: s.tasks,
            recentRuns: s.runs
              .filter((r) => !caller || r.taskId === caller)
              .slice(-10),
            memories: [...s.memories]
              .sort((a, b) => retention(b) - retention(a))
              .slice(0, 30),
            memoryCount: s.memories.length,
            scenes: ["lightweight", "coding", "computer"],
          };
        case "add": {
          assert(content, "text is required");
          const p = profile(a.profile);
          assert(["lightweight", "coding"].includes(p), "Invalid profile");
          if (a.kind === "duty") {
            assert(s.duties.length < 50, "Duty capacity reached");
            const d: Obj = {
              id: id("d"),
              text: content,
              enabled: true,
              profile: p,
              owner,
              createdAt: now,
              firedAt: now,
            };
            applyDuty(d, a, now);
            assert(
              d.manual ||
                d.everyMinutes ||
                d.times?.length ||
                d.events?.length ||
                d.nextCheckAt,
              "Duty requires explicit trigger or manual=true",
            );
            s.duties.push(d);
            return { id: d.id };
          }
          assert(a.kind === "todo", "kind is duty or todo");
          assert(
            !a.key || (typeof a.key === "string" && [...a.key].length <= 200),
            "key exceeds 200",
          );
          const old = a.key ? s.tasks.find((t) => t.key === a.key) : undefined;
          if (old) return { id: old.id, exists: true, status: old.status };
          assert(
            s.tasks.filter((t) => !ended(t.status)).length < 100,
            "Active task capacity reached",
          );
          const task: Task = {
            id: id("t"),
            text: content,
            status: "queued",
            createdAt: now,
            profile: p,
            cwd: t?.cwd || a.cwd || s.cwd,
            owner: t?.owner || owner,
            key: a.key || "",
            origin: t?.id || "",
            fromDuty: t?.dutyId || t?.fromDuty || "",
            nextCheckAt: requestedTime(a, now),
            plan: [],
            progress: [],
          };
          s.tasks.push(task);
          return { id: task.id };
        }
        case "update": {
          const d = s.duties.find((d) => d.id === a.id);
          if (d) {
            applyDuty(d, a, now);
            for (const task of s.tasks.filter(
              (t) => t.dutyId === d.id || t.fromDuty === d.id,
            )) {
              if (!d.enabled && !ended(task.status)) {
                task.status = "cancelled";
                this.runtime.cancel(
                  task.side === "computer"
                    ? task.computerSession
                    : task.workSession,
                );
              } else if (
                !task.workSession &&
                !task.computerSession &&
                !this.busy.has(task.id)
              ) {
                task.text = d.text;
                task.profile = d.profile;
              }
            }
            return { ok: true };
          }
          const task = get();
          assert(!ended(task.status), "Task has ended");
          if ("text" in a || "profile" in a) {
            assert(
              !task.workSession &&
                !task.computerSession &&
                !this.busy.has(task.id),
              "Started tasks cannot be rewritten",
            );
            assert(!task.dutyId, "Duty task follows the duty template");
            if ("text" in a) {
              assert(content, "text required");
              task.text = content;
            }
            if ("profile" in a) {
              const value = profile(a.profile);
              assert(
                ["lightweight", "coding"].includes(value),
                "Tasks start in lightweight/coding; computer work uses relay",
              );
              task.profile = value;
            }
          }
          const at = requestedTime(a, now);
          if (at) {
            assert(
              !task.dutyId || caller,
              "Duty-triggered tasks use defer rather than direct rescheduling",
            );
            task.nextCheckAt = at;
            if (caller) {
              task.status = "deferred";
              stop = true;
            }
          }
          return { ok: true };
        }
        case "done": {
          const task = s.tasks.find((t) => t.id === a.id);
          if (task) {
            assert(!this.busy.has(task.id), "Stop running task first");
            task.status = "cancelled";
            task.finishedAt = now;
            this.vault.dropTemp(task.id);
            return { ok: true };
          }
          const d = s.duties.find((d) => d.id === a.id);
          assert(d, "Duty/task not found");
          s.duties = s.duties.filter((v) => v.id !== a.id);
          for (const task of s.tasks.filter(
            (t) => t.dutyId === a.id || t.fromDuty === a.id,
          ))
            if (!ended(task.status)) {
              task.status = "cancelled";
              this.runtime.cancel(
                task.side === "computer"
                  ? task.computerSession
                  : task.workSession,
              );
            }
          return { ok: true };
        }
        case "ask":
        case "help":
        case "defer":
        case "progress":
        case "relay":
        case "vault_request":
        case "vault_send": {
          assert(t, "Action requires a running task");
          if (action !== "vault_send") assert(content, "text required");
          if (action === "progress") {
            assert([...content].length <= 200, "progress is at most 200 chars");
            if (a.plan) {
              assert(
                Array.isArray(a.plan) &&
                  a.plan.length >= 1 &&
                  a.plan.length <= 50,
                "Plan needs 1–50 steps",
              );
              let size = 0;
              for (const step of a.plan) {
                assert(
                  typeof step.content === "string" &&
                    step.content.trim() &&
                    step.content.length <= 500 &&
                    [
                      "pending",
                      "in_progress",
                      "completed",
                      "failed",
                      "blocked",
                    ].includes(step.status),
                  "Invalid plan step",
                );
                size += step.content.length;
              }
              assert(size <= 8000, "Plan exceeds 8000 characters");
              t.plan = a.plan;
            }
            t.progress ??= [];
            t.progress.push({ at: now, text: content });
            t.progress = t.progress.slice(-50);
            return { ok: true, next: "Continue the current step" };
          }
          if (action === "ask") {
            t.status = "approval";
            t.approval = content;
            this.note(s, t, "confirm", owner.name || "员工", content);
            if (t.owner.token)
              pendingSend = {
                to: t.owner.token,
                type: "starlink.notify",
                data: { text: "需要你确认：" + clip(content, 80) },
              };
          }
          if (action === "help" || action === "vault_request") {
            if (action === "vault_request") {
              assert(
                t.owner.token,
                "Local task must use help for missing credentials",
              );
              t.vaultPk = this.vault.request(t.id);
            }
            t.status = "waiting";
            t.waiting =
              action === "vault_request"
                ? "【请求密码本里的凭据】" + content
                : content;
            this.note(s, t, "help", "员工", t.waiting);
            if (t.owner.token)
              pendingSend = {
                to: t.owner.token,
                type: "starlink.help",
                data: {
                  id: t.id,
                  task: t.text,
                  question: t.waiting,
                  vaultKey: t.vaultPk || "",
                  shot: this.latestShot(t),
                },
              };
          }
          if (action === "defer") {
            const at = requestedTime(a, now);
            assert(at, "defer requires future check time");
            t.nextCheckAt = at;
            t.checkpoint = content;
            t.status = "deferred";
          }
          if (action === "relay") {
            assert(
              a.scene === "computer" && t.side !== "computer",
              "Only work session can relay to computer",
            );
            assert(!t.waiting && !t.approval, "Cannot relay a suspended task");
            t.side = "computer";
            t.handoff = content;
            t.status = "queued";
            t.nextCheckAt = 0;
          }
          if (action === "vault_send") {
            assert(
              t.replyTo && t.vaultPk,
              "Not a remote credential support task",
            );
            const sealed = this.vault.sealFor(a.id, t.replyTo.id, t.vaultPk);
            pendingSend = {
              to: t.replyTo.token,
              type: "starlink.reply",
              data: {
                id: t.replyTo.id,
                text: "已通过密码本加密发来「" + sealed.name + "」",
                sealed: sealed.sealed,
              },
            };
            t.replyTo = null;
            t.vaultPk = "";
          }
          stop = true;
          return {
            ok: true,
            next: "Saved; end this turn now. System resumes the same task/session; do not resubmit or poll.",
          };
        }
        case "remember": {
          assert(
            content && [...content].length <= 200,
            "Memory requires 1–200 characters",
          );
          const importance = a.importance ?? 1;
          assert(
            Number.isInteger(importance) && importance >= 1 && importance <= 3,
            "importance is 1–3",
          );
          let m = a.id
            ? s.memories.find((m) => m.id === a.id)
            : s.memories.find((m) => m.text === content);
          if (a.id) assert(m, "Memory not found");
          if (!m) {
            if (s.memories.length >= 300) {
              const weakest = s.memories
                .filter((m) => m.importance < 3)
                .sort((a, b) => retention(a) - retention(b))[0];
              assert(
                weakest,
                "All memories are permanent; forget or merge one",
              );
              s.memories = s.memories.filter((m) => m.id !== weakest.id);
            }
            m = { id: id("m"), strength: 0 };
            s.memories.push(m);
          }
          Object.assign(m, {
            text: content,
            importance: a.importance ?? m.importance ?? 1,
            at: now,
            usedAt: now,
            strength: (m.strength || 0) + 1,
          });
          return { id: m.id };
        }
        case "forget":
          assert(
            s.memories.some((m) => m.id === a.id),
            "Memory not found",
          );
          s.memories = s.memories.filter((m) => m.id !== a.id);
          return { ok: true };
        case "orbit_list":
          return { items: s.orbit };
        case "orbit_add": {
          assert(content, "text required");
          const item = { id: id("o"), text: content, done: false, at: now };
          s.orbit.push(item);
          if (!caller) this.event(s, "orbit.added", content, now);
          return item;
        }
        case "orbit_done": {
          const item = s.orbit.find((o) => o.id === a.id);
          assert(item, "Orbit item not found");
          const done = a.done ?? true;
          assert(typeof done === "boolean", "done must be boolean");
          if (item.done !== done) {
            item.done = done;
            if (!caller)
              this.event(
                s,
                done ? "orbit.done" : "orbit.changed",
                item.text,
                now,
              );
          }
          return { ok: true };
        }
        default:
          throw Error("Unknown employee action " + action);
      }
    });
    if (pendingSend) {
      const send = pendingSend as { to: string; type: string; data: any };
      await this.runtime.send(send.to, send.type, send.data);
    }
    return { value, stop };
  }
  event(s: EmployeeState, kind: string, text: string, now: number) {
    for (const d of s.duties)
      if (
        d.enabled &&
        !d.manual &&
        (d.events?.includes(kind) || d.events?.includes("orbit.changed"))
      ) {
        d.eventAt = now + 5000;
        d.pending = [...(d.pending || []), clip(kind + ": " + text, 500)].slice(
          -20,
        );
      }
  }
  note(s: EmployeeState, t: Task, kind: string, who: string, text: string) {
    const run = [...s.runs].reverse().find((r) => r.taskId === t.id);
    if (run) {
      run.notes ??= [];
      const last = [...run.notes].reverse().find((n: Obj) => n.kind === kind);
      if (last?.text !== text)
        run.notes.push({ at: Date.now(), kind, who, text: clip(text, 4000) });
    }
  }
  latestShot(t: Task) {
    const rows = this.store.messages(
      t.side === "computer" ? t.computerSession : t.workSession,
    );
    for (const m of [...rows].reverse())
      if (m.images?.length) {
        const im = m.images.at(-1)!;
        if (im.data.length <= (4 * 1024 * 1024 * 4) / 3)
          return { data: im.data, ext: im.mime.split("/")[1] };
      }
  }
  async control(a: Obj, owner: Owner = { token: "", name: "" }) {
    let reply: any;
    const value = this.update((s) => {
      if (a.action === "settings") {
        assert(!owner.token, "Only host user can change employee settings");
        for (const k of ["enabled", "public"])
          if (k in a) {
            assert(typeof a[k] === "boolean", "Boolean setting required");
            (s as any)[k] = a[k];
          }
        for (const k of ["workStart", "workEnd"])
          if (k in a) {
            assert(hhmm(a[k]), "Work hours require HH:MM");
            (s as any)[k] = a[k];
          }
        for (const [k, min, max] of [
          ["idleMinutes", 0, 120],
          ["takeoverSeconds", 1, 120],
        ] as [string, number, number][])
          if (k in a) {
            assert(
              Number.isInteger(a[k]) && a[k] >= min && a[k] <= max,
              "Invalid setting",
            );
            (s as any)[k] = a[k];
          }
        if (a.cwd) s.cwd = a.cwd;
        return { ok: true };
      }
      if (a.action === "fire") {
        const duty = s.duties.find((d) => d.id === a.id);
        assert(duty && duty.enabled, "Duty not enabled");
        const task = this.fire(s, duty, Date.now(), a.text);
        return { id: task.id };
      }
      const t = this.task(s, a.id);
      assert(
        !owner.token || t.owner.token === owner.token,
        "Only the assigning member may control this task",
      );
      if (a.action !== "stop")
        assert(
          !this.busy.has(t.id),
          "Task still executing; wait until slot is released",
        );
      switch (a.action) {
        case "stop":
          t.status = "stopped";
          t.result = "用户停止：续做前核对外部操作，不要重放。";
          this.runtime.cancel(
            t.side === "computer" ? t.computerSession : t.workSession,
          );
          break;
        case "answer":
          assert(t.status === "waiting", "Task not waiting for information");
          assert(
            typeof a.text === "string" && a.text.trim(),
            "Answer required",
          );
          t.answer = `你问：${t.waiting}\n${owner.name || "用户"}答：${clip(a.text, 8000)}`;
          t.waiting = "";
          t.status = "queued";
          t.nextCheckAt = 0;
          this.note(s, t, "answer", owner.name || "用户", a.text);
          if (t.replyTo) {
            reply = { ...t.replyTo, text: a.text };
            t.replyTo = null;
            t.status = "done";
          }
          break;
        case "approve":
          assert(t.status === "approval", "Task not awaiting approval");
          if (a.approved === true) {
            t.answer = "用户仅批准以下操作：" + t.approval;
            t.approval = "";
            t.status = "queued";
            t.nextCheckAt = 0;
            this.note(s, t, "approve", owner.name || "用户", t.answer);
          } else {
            t.status = "cancelled";
            t.result = "审批被驳回";
            this.vault.dropTemp(t.id);
          }
          break;
        case "resume":
          assert(
            ended(t.status) && t.status !== "done",
            "Only stopped/failed/cancelled tasks may continue",
          );
          assert(
            !t.vaultPk || this.store.object("vault-request", t.id),
            "Credential request expired; create a new request",
          );
          t.status = "queued";
          t.nextCheckAt = 0;
          t.finishedAt = 0;
          t.answer =
            "同一任务续做，保留原计划与会话；核对已发生的操作，不重做。上次结果：\n" +
            (t.result || "");
          break;
        case "redispatch":
          assert(
            a.confirmed === true,
            "Explicit confirmation required to redispatch as a NEW task",
          );
          const copy: Task = {
            id: id("t"),
            text: t.text,
            status: "queued",
            profile: t.profile,
            cwd: t.cwd,
            owner: t.owner,
            createdAt: Date.now(),
            plan: [],
            progress: [],
            origin: t.id,
            fromDuty: t.dutyId || t.fromDuty,
          };
          s.tasks.push(copy);
          return { id: copy.id };
        case "remove":
          assert(ended(t.status), "Only ended task records may be deleted");
          s.tasks = s.tasks.filter((v) => v.id !== t.id);
          this.vault.dropTemp(t.id);
          break;
        default:
          throw Error("Unknown task control");
      }
      return { ok: true };
    });
    if (reply)
      await this.runtime.send(reply.token, "starlink.reply", {
        id: reply.id,
        text: reply.text,
      });
    return value;
  }
  fire(s: EmployeeState, d: Obj, now: number, event?: string) {
    const t: Task = {
      id: id("t"),
      text: d.text,
      status: "queued",
      profile: profile(d.profile),
      cwd: s.cwd,
      owner: d.owner || { token: "", name: "" },
      createdAt: now,
      dutyId: d.id,
      event: event || "",
      plan: [],
      progress: [],
    };
    s.tasks.push(t);
    d.firedAt = now;
    if (!d.everyMinutes && !d.times?.length) d.nextCheckAt = 0;
    return t;
  }
  async tick(now = Date.now()) {
    if (this.closed) return;
    clearTimeout(this.timer);
    const initial = this.state();
    let desk: Presence | undefined;
    if (
      initial.enabled &&
      workSlot(initial.workStart, initial.workEnd, now) === now &&
      (initial.desktopAskAfter || 0) <= now &&
      initial.tasks.some(
        (t) =>
          ["queued", "deferred"].includes(t.status) &&
          (t.nextCheckAt || 0) <= now &&
          (t.side === "computer" || t.profile === "computer"),
      )
    ) {
      desk = await (this.runtime.presence?.() || systemPresence());
      if (this.closed) return;
      const before = this.nativePresence;
      this.nativePresence = desk;
      if (
        before?.locked !== desk.locked ||
        before?.available !== desk.available
      )
        this.runtime.emit("employee_changed");
    }
    const s = this.state();
    if (!s.enabled) return;
    const slot = workSlot(s.workStart, s.workEnd, now);
    if (slot > now) {
      this.timer = setTimeout(
        () => this.schedule(),
        Math.min(slot - now, 2147483647),
      );
      return;
    }
    let next = Infinity,
      changed = false;
    for (const d of s.duties) {
      if (!d.enabled || d.manual) continue;
      let due = 0;
      if (d.everyMinutes) {
        if (!s.tasks.some((t) => t.dutyId === d.id && !ended(t.status)))
          due = d.lastRunAt ? d.lastRunAt + d.everyMinutes * 60000 : 1;
      } else if (d.times?.length) due = nextFixed(d.times, d.firedAt || now);
      else due = d.nextCheckAt || 0;
      const event = d.eventAt && d.eventAt <= now;
      if ((due && due <= now) || event) {
        this.fire(s, d, now, event ? (d.pending || []).join("\n") : undefined);
        if (event) {
          d.pending = [];
          d.eventAt = 0;
        }
        changed = true;
      } else {
        if (due > now) next = Math.min(next, due);
        if (d.eventAt > now) next = Math.min(next, d.eventAt);
      }
    }
    const jobs: Task[] = [];
    for (const t of s.tasks) {
      if (this.busy.has(t.id) || !["queued", "deferred"].includes(t.status))
        continue;
      if ((t.nextCheckAt || 0) > now) {
        next = Math.min(next, t.nextCheckAt);
        continue;
      }
      if (this.busy.size >= 3) continue;
      const computer = t.side === "computer" || t.profile === "computer";
      if (computer) {
        if ([...this.busy.values()].some((v) => v.computer)) continue;
        if (this.locked || !desk?.available || desk.locked) {
          next = Math.min(next, now + 2000);
          continue;
        }
        if (s.desktopAskAfter > now) {
          next = Math.min(next, s.desktopAskAfter);
          continue;
        }
        let takeover = this.takeovers.get(t.id);
        const idle =
          Math.min(desk.idleMs, now - this.lastActivity) >=
          s.idleMinutes * 60000;
        if (!idle && !takeover) {
          takeover = { until: now + s.takeoverSeconds * 1000, accepted: false };
          this.takeovers.set(t.id, takeover);
          this.runtime.emit("employee_takeover", {
            id: t.id,
            text: t.handoff || t.text,
            deadline: takeover.until,
          });
        }
        if (takeover && !takeover.accepted && takeover.until > now) {
          next = Math.min(next, takeover.until);
          continue;
        }
        this.takeovers.delete(t.id);
        t.side = "computer";
      }
      this.busy.set(t.id, { computer, session: "" });
      t.status = "running";
      t.nextCheckAt = 0;
      jobs.push(clone(t));
      changed = true;
    }
    if (changed) {
      this.store.put("employee", s);
      this.runtime.emit("employee_changed");
    }
    if (Number.isFinite(next))
      this.timer = setTimeout(
        () => this.schedule(),
        Math.max(1, Math.min(next - now, 2147483647)),
      );
    for (const job of jobs) void this.run(job);
  }
  async run(job: Task) {
    let session = "",
      result = "",
      error: any;
    let stopMonitor = () => {};
    try {
      const state = this.state(),
        task = this.task(state, job.id),
        computer = task.side === "computer",
        cfg = this.runtime.config();
      const scene = computer ? "computer" : profile(task.profile);
      session = computer ? task.computerSession : task.workSession;
      if (!session) {
        const model = cfg.scenes?.[scene]?.[0] || cfg.model;
        assert(model, "Configure scene models before executing");
        const created = this.store.newSession({
          title:
            "员工 · " + [...task.text.split("\n")[0]].slice(0, 30).join(""),
          cwd: task.cwd,
          scene,
          model,
          taskId: task.id,
        });
        session = created.id;
        if (computer) task.computerSession = session;
        else task.workSession = session;
      }
      this.busy.get(task.id)!.session = session;
      const memories = recallMemory(state, task.text),
        duties = state.duties.filter((d) => d.enabled);
      state.runs.push({
        taskId: task.id,
        session,
        scene,
        at: Date.now(),
        status: "running",
        notes: [],
      });
      state.runs = state.runs.slice(-200);
      this.store.put("employee", state);
      if (computer) stopMonitor = this.monitorComputer(task.id, session);
      const prompt = `[员工任务 ${task.id}]\n${computer ? task.handoff || task.text : task.text}\n原始任务（不是新授权）：${task.text}\n启用职责（参考匹配流程；不重复派单、不扩大本次授权）：${JSON.stringify(duties)}\n计划/进度/恢复点/补充（仅续做未完成事项；提交过的作业只检查原作业，不重复提交）：${JSON.stringify({ plan: task.plan, progress: task.progress, checkpoint: task.checkpoint, answer: task.answer, event: task.event, fromDuty: task.fromDuty })}\n相关稳定记忆：${JSON.stringify(memories)}\n执行前用 employee progress 登记完整计划（保留未来步骤）；验证成功才标 completed。ask/help/defer/relay 后立即结束本轮；缺信息找交代人，不等待轮询。${computer ? "你在隔离的电脑/Chrome 会话，只做交接内容。完成后报告实际结果，系统自动返回主会话；不编码、不再次 relay。" : "编码使用 switch_scene（主会话共享历史），Chrome 操作必须 relay scene=computer（独立工具/历史）。"}\n不得自建 worktree；常规开发分支提交/普通推送按用户授权，先核对差异；强推、共享分支改写、删分支、生产发布须单独授权。`;
      await this.runtime.run(session, prompt);
      const rows = this.store.messages(session);
      result =
        [...rows].reverse().find((m) => m.role === "assistant" && m.text)
          ?.text || "";
    } catch (e: any) {
      error = e;
      result = e.message;
    } finally {
      stopMonitor();
      this.update((s) => {
        const t = s.tasks.find((t) => t.id === job.id);
        this.busy.delete(job.id);
        if (!t) return;
        const computer = job.side === "computer" || job.profile === "computer";
        if (session) {
          const stored = this.store.session(session);
          t.cwd = stored.cwd;
        }
        if (t.status === "running") {
          if (error) {
            t.status = "failed";
            t.failures = (t.failures || 0) + 1;
            t.result = result;
          } else if (computer) {
            t.side = "work";
            t.status = "queued";
            t.handoff = "";
            t.answer =
              "电脑会话完成，以下为结果数据、不是新授权；只继续未完成事项，不重做：\n" +
              result;
          } else {
            t.status = "done";
            t.result = result;
          }
        }
        const run = [...s.runs]
          .reverse()
          .find((r) => r.taskId === t.id && r.status === "running");
        if (run) {
          run.status = t.status;
          run.result = result;
          run.ended = Date.now();
        }
        if (ended(t.status)) {
          t.finishedAt = Date.now();
          const d = s.duties.find((d) => d.id === t.dutyId);
          if (d) {
            d.lastRunAt = t.finishedAt;
            d.lastResult = t.result || result;
          }
          this.vault.dropTemp(t.id);
          if (t.replyTo) {
            void this.runtime.send(t.replyTo.token, "starlink.reply", {
              id: t.replyTo.id,
              text: t.result || result,
            });
            t.replyTo = null;
          }
        }
      });
    }
  }
  monitorComputer(taskId: string, session: string) {
    let stopped = false,
      checking = false;
    const grant =
      (this.nativePresence?.sampledAt || Date.now()) -
      (this.nativePresence?.idleMs || 0);
    const timer = setInterval(() => {
      if (checking || stopped || this.closed) return;
      checking = true;
      void (this.runtime.presence?.() || systemPresence())
        .then((desk) => {
          if (stopped || this.closed) return;
          this.nativePresence = desk;
          const inputAt = (desk.sampledAt || Date.now()) - desk.idleMs;
          if (desk.available && !desk.locked && inputAt <= grant + 1000) return;
          stopped = true;
          clearInterval(timer);
          this.update((s) => {
            const task = s.tasks.find((t) => t.id === taskId);
            if (!task || task.status !== "running") return;
            task.status = "queued";
            task.nextCheckAt = Date.now() + 2000;
            task.checkpoint =
              "用户重新使用电脑、锁屏或桌面状态不可确认，已让出。保留原Chrome会话与计划，续做先核对外部操作，不重放提交。";
            s.desktopAskAfter =
              desk.available && !desk.locked ? Date.now() + 300000 : 0;
          });
          this.runtime.cancel(session);
        })
        .catch(() => {})
        .finally(() => (checking = false));
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
  takeover(a: Obj) {
    assert(this.takeovers.has(a.id), "No pending browser takeover");
    this.update((s) => {
      if (a.accepted) {
        this.takeovers.get(a.id)!.accepted = true;
      } else {
        s.desktopAskAfter = Date.now() + 300000;
        this.takeovers.delete(a.id);
      }
    });
  }
  async remote(from: Owner, kind: string, data: Obj) {
    const s = this.state();
    if (kind === "starlink.help") {
      assert(
        s.links.includes(from.token),
        "Unsolicited support request rejected",
      );
      assert(data.id && data.question, "Incomplete support request");
      if (
        s.tasks.some(
          (t) => t.replyTo?.token === from.token && t.replyTo?.id === data.id,
        )
      )
        return;
      this.update((s) => {
        const task: Task = {
          id: id("t"),
          text: `替「${from.name}」的数字员工补充信息（它在做：${clip(data.task || "", 60)}）：${clip(data.question, 7000)}`,
          status: "queued",
          createdAt: Date.now(),
          profile: "lightweight",
          cwd: s.cwd,
          owner: { token: "", name: "" },
          replyTo: { token: from.token, name: from.name, id: data.id },
          vaultPk:
            Buffer.from(data.vaultKey || "", "base64").length === 32
              ? data.vaultKey
              : "",
          plan: [],
          progress: [],
        };
        if (data.shot?.data && Buffer.byteLength(data.shot.data) <= 6 << 20) {
          const blob = this.store.blob(
            "image/" +
              (/^(jpg|jpeg|png|webp)$/.test(data.shot.ext)
                ? data.shot.ext
                : "jpeg"),
            Buffer.from(data.shot.data, "base64"),
          );
          task.shot = `sqlite:blob/${blob}`;
        }
        s.tasks.push(task);
      });
      return;
    }
    if (kind === "starlink.reply") {
      const task = s.tasks.find(
        (t) =>
          t.id === data.id &&
          t.status === "waiting" &&
          t.owner.token === from.token,
      );
      assert(task, "No outstanding request for this member");
      let answer = data.text;
      if (data.sealed) {
        const entry = this.vault.receive(
          task.id,
          clip(task.text, 40),
          data.sealed,
        );
        answer = `对方已加密发来「${entry.name}」，临时条目 ${entry.id}；使用 vault_get，任务结束自动删除。`;
      }
      await this.control({ action: "answer", id: task.id, text: answer }, from);
      return;
    }
    if (kind === "starlink.notify") {
      assert(s.links.includes(from.token), "Unsolicited notification rejected");
      this.runtime.emit("employee_notification", { from, text: data.text });
      return;
    }
  }
  transcript(session: string) {
    const s = this.state(),
      task = s.tasks.find(
        (t) => t.workSession === session || t.computerSession === session,
      );
    assert(task, "Not an employee-owned session");
    const runs = s.runs.filter((r) => r.taskId === task.id),
      entries = runs
        .flatMap((r) => [
          ...(r.notes || []),
          {
            kind: "result",
            scene: r.scene,
            status: r.status,
            text: r.result || "",
            at: r.ended || Date.now(),
          },
        ])
        .sort((a, b) => a.at - b.at);
    return { title: task.text, entries };
  }
}
