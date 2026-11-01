import {
  beijingParts,
  beijingTimestamp,
  beijingDateTime,
} from "../../shared/time";
import { systemPresence, type Presence } from "./presence";
import type { Store } from "./store";
import { resolve } from "node:path";
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
  id: string;
  name: string;
  instruction: string;
  ownerId: string;
  chatSession?: string;
  vaultIds: string[];
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
const cwdKey = (cwd: string) => process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
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
      "nextAt must be Beijing YYYY-MM-DD HH:MM",
    );
    const [year, month, day, hour, minute] = a.nextAt
      .match(/\d+/g)!
      .map(Number);
    const at = beijingTimestamp(year, month - 1, day, hour, minute);
    assert(
      at > now && beijingDateTime(at) === a.nextAt,
      "nextAt must be a valid future Beijing time",
    );
    return at;
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
      Array.isArray(a.events) && a.events.length === 0,
      "不再支持星轨事件触发",
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
  const p = beijingParts(after),
    values: number[] = [];
  for (let days = 0; days < 3; days++)
    for (const value of times) {
      const [hour, minute] = value.split(":").map(Number),
        at = beijingTimestamp(p.year, p.month, p.day + days, hour, minute);
      if (at > after) values.push(at);
    }
  return Math.min(...values);
}
export function workSlot(start: string, end: string, now: number) {
  assert(hhmm(start) && hhmm(end), "Work hours require HH:MM");
  const p = beijingParts(now),
    hm = beijingDateTime(now).slice(-5);
  if (
    start === end ||
    (start < end ? hm >= start && hm < end : hm >= start || hm < end)
  )
    return now;
  const [hour, minute] = start.split(":").map(Number);
  let next = beijingTimestamp(p.year, p.month, p.day, hour, minute);
  if (next <= now)
    next = beijingTimestamp(p.year, p.month, p.day + 1, hour, minute);
  return next;
}
export type EmployeeRuntime = {
  run: (session: string, text: string, signal?: AbortSignal) => Promise<void>;
  cancel: (session: string) => void;
  isRunning: (session: string) => boolean;
  emit: (type: string, data?: any) => void;
  send: (to: string, type: string, data: any) => Promise<any>;
  config: () => Obj;
  isolated?: boolean;
  presence?: () => Promise<Presence>;
};
export class Employee {
  busy = new Map<string, { computer: boolean; session: string }>();
  members = new Map<string, Employee>();
  membersLoaded = false;
  wakeAt = Infinity;
  draining = false;
  rerun = false;
  cursor = 0;
  stopping = false;
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
    public employeeId = "default",
    public root?: Employee,
  ) {}
  all(): Employee[] {
    const root = this.root || this;
    if (!root.membersLoaded) {
      for (const row of this.store.objects<EmployeeState>("employee"))
        if (!root.members.has(row.id))
          root.members.set(row.id, new Employee(this.store, this.vault, this.runtime, row.id, root));
      root.membersLoaded = true;
    }
    return [root, ...root.members.values()];
  }
  for(key = "default"): Employee {
    const member = this.all().find((e) => e.employeeId === key);
    assert(member, "Employee not found");
    return member;
  }
  accessible(user: { id: string; role: string }) {
    const s = this.state();
    return user.role === "admin" || (user.role === "operator" && s.ownerId === user.id);
  }
  create(a: Obj, ownerId: string) {
    assert(typeof a.name === "string" && a.name.trim() && a.name.length <= 80, "Employee name requires 1–80 characters");
    assert(a.instruction === undefined || (typeof a.instruction === "string" && a.instruction.length <= 8000), "Invalid employee instruction");
    assert(a.cwd === undefined || (typeof a.cwd === "string" && a.cwd.length <= 4096), "Invalid cwd");
    assert(this.all().length < 50, "Employee capacity reached");
    const key = id("e"), employee = new Employee(this.store, this.vault, this.runtime, key, this.root || this);
    const s = employee.state();
    Object.assign(s, { name: a.name.trim(), instruction: a.instruction || "", ownerId, cwd: a.cwd || process.cwd(), enabled: true, workStart: "00:00", workEnd: "00:00" });
    employee.save(s);
    (this.root || this).members.set(key, employee);
    employee.emitChanged(s);
    return s;
  }
  chat(ownerId: string) {
    const existing = this.state().chatSession;
    if (existing) return this.store.session(existing);
    return this.update((s) => {
      const session = this.store.newSession({ title: s.name, cwd: s.cwd, ownerId: s.ownerId || ownerId, employeeId: this.employeeId });
      s.chatSession = session.id;
      return session;
    });
  }
  save(s: EmployeeState) {
    if (this.employeeId === "default") this.store.put("employee", s);
    else this.store.save("employee", this.employeeId, s);
  }
  wake(at: number) {
    const root = this.root || this;
    if (root.closed || at >= root.wakeAt) return;
    clearTimeout(root.timer);
    root.wakeAt = at;
    root.timer = setTimeout(() => {
      root.wakeAt = Infinity;
      void root.drain().catch((error) => {
        root.runtime.emit("employee_error", { employeeId: root.employeeId, message: String(error?.message || error) });
        root.wake(Date.now() + 60000);
      });
    }, Math.max(0, Math.min(at - Date.now(), 2147483647)));
    root.timer.unref?.();
  }
  async drain() {
    if (this.draining) { this.rerun = true; return; }
    this.draining = true;
    try {
      const employees = this.all(), start = this.cursor++ % employees.length;
      for (let index = 0; index < employees.length; index++) {
        if (this.closed) return;
        const employee = employees[(start + index) % employees.length];
        try { await employee.tick(); }
        catch (e: any) {
          employee.runtime.emit("employee_error", { employeeId: employee.employeeId, message: e.message });
          this.wake(Date.now() + 60000);
        }
      }
    } finally {
      this.draining = false;
      if (this.rerun) { this.rerun = false; this.schedule(); }
    }
  }
  recover(t: Task, reason: string, now = Date.now()) {
    const recovery = t.recovery ||= { attempts: 0, startedAt: now, history: [] };
    recovery.attempts++;
    recovery.reason = clip(String(reason), 2000);
    recovery.history.push({ at: now, reason: recovery.reason });
    recovery.history = recovery.history.slice(-5);
    t.result = recovery.reason;
    if (recovery.attempts > 3 || now - recovery.startedAt > 30 * 60000) {
      t.status = "waiting";
      t.waiting = "自动恢复已达上限，需要你处理：" + recovery.reason;
      return;
    }
    t.status = "recovering";
    t.nextCheckAt = now + 30000 * 2 ** (recovery.attempts - 1);
    t.checkpoint ||= "恢复原任务：检查错误与外部状态，诊断、最小修复并验证；不重复发送/提交，不扩大授权。";
  }
  // shortcut: task history shares one SQLite document; normalize tasks when histories become large.
  state(): EmployeeState {
    const fallback: EmployeeState = {
      id: this.employeeId,
      name: "默认员工",
      instruction: "",
      ownerId: "",
      vaultIds: [],
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
    };
    const state = this.employeeId === "default"
      ? this.store.get<EmployeeState>("employee", fallback)
      : this.store.object<EmployeeState>("employee", this.employeeId) || fallback;
    Object.assign(state, { id: this.employeeId, name: state.name || fallback.name, instruction: state.instruction || "", ownerId: state.ownerId || "", vaultIds: (state.vaultIds || []).filter((key) => this.store.object("vault", key)) });
    // Retain legacy data but do not fire removed Orbit subscriptions.
    for (const duty of state.duties)
      if (duty.events?.some((name: string) => name.startsWith("orbit."))) {
        duty.events = [];
        duty.pending = [];
        duty.eventAt = 0;
        if (!duty.manual && !duty.everyMinutes && !duty.times?.length)
          duty.enabled = false;
      }
    return state;
  }
  update<T>(fn: (s: EmployeeState) => T): T {
    const result = this.store.transaction(() => {
      const s = this.state(),
        value = fn(s);
      this.save(s);
      return value;
    });
    this.emitChanged(this.state());
    this.schedule();
    return result;
  }
  start() {
    this.closed = false;
    this.stopping = false;
    this.update((s) => {
      for (const t of s.tasks)
        if (t.status === "running") {
          this.recover(t, "服务中断：原会话续做，先检查外部状态；中断不代表提交/发送未执行。");
        }
      for (const r of s.runs)
        if (r.status === "running") {
          r.status = "stopped";
          r.ended = Date.now();
        }
    });
    if (!this.root) for (const employee of this.all().slice(1)) employee.start();
    this.schedule();
  }
  close() {
    this.closed = true;
    this.stopping = true;
    clearTimeout(this.timer);
    this.wakeAt = Infinity;
    for (const run of this.busy.values()) this.runtime.cancel(run.session);
    if (!this.root) for (const employee of this.members.values()) employee.close();
  }
  emitChanged(s: EmployeeState) {
    this.runtime.emit("employee_changed", {
      employeeId: this.employeeId,
      activeTasks: s.tasks.filter((t) => !ended(t.status)).length,
    });
  }
  schedule() {
    if (this.closed) return;
    this.wake(Date.now());
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
        "complete",
        "relay",
        "remember",
        "forget",
        "vault_list",
        "vault_get",
        "vault_request",
        "vault_send",
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
    assert(!action.startsWith("orbit_"), "星轨功能已移除");
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
        return { value: { entries: this.vault.list().filter((entry) => initial.vaultIds.includes(entry.id) && (!entry.tempFor || entry.tempFor === caller)) } };
      if (action === "vault_get") {
        assert(initial.vaultIds.includes(a.id), "Credential is not granted to this employee");
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
      throw Error("User-only vault action; use the settings page");
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
            employeeId: this.employeeId,
            name: s.name,
            now: beijingDateTime(now),
            timeZone: "Asia/Shanghai",
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
            employeeId: this.employeeId,
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
        case "complete": {
          assert(t && t.side !== "computer", "Complete requires the main task session");
          if (t.supplementPending) {
            t.supplementPending = false;
            return { ok: false, supplement: t.answer, next: "Apply the user's latest supplement, update and verify the plan before completing." };
          }
          assert(content && t.plan?.length && t.plan.every((step: Obj) => step.status === "completed") && (t.planRevision || 0) === (t.revision || 0), "Complete requires a fully verified plan for the latest requirements and result evidence in text");
          t.completion = content;
          stop = true;
          return { ok: true, next: "Task verified; report the result and end this turn." };
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
              t.planRevision = t.revision || 0;
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
            assert(initial.vaultIds.includes(a.id), "Credential is not granted to this employee");
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
        const im = this.store.imageData(m.images.at(-1)!);
        if (im.data && im.data.length <= (4 * 1024 * 1024 * 4) / 3)
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
        for (const [key, max] of [["name", 80], ["instruction", 8000], ["cwd", 4096]] as const)
          if (key in a) {
            assert(typeof a[key] === "string" && a[key].length <= max && (key === "instruction" || a[key].trim()), "Invalid employee " + key);
            s[key] = a[key].trim();
          }
        if ("vaultIds" in a) {
          assert(Array.isArray(a.vaultIds) && a.vaultIds.every((key: string) => this.vault.list().some((entry) => entry.id === key)), "Invalid credential grants");
          s.vaultIds = [...new Set<string>(a.vaultIds)];
        }
        if (a.enabled === false) {
          for (const task of s.tasks) if (task.status === "running") {
            task.status = "stopped";
            task.result = "员工已停用；用户确认后才能续做。";
            this.runtime.cancel(task.side === "computer" ? task.computerSession : task.workSession);
          }
          if (s.chatSession) this.runtime.cancel(s.chatSession);
        }
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
      if (a.action === "resume" && a.text) {
        assert(typeof a.text === "string" && a.text.length <= 8000 && a.text.trim(), "Invalid task supplement");
        t.answer = (t.answer || "") + "\n用户补充：" + a.text;
        t.supplementPending = true;
        t.revision = (t.revision || 0) + 1;
        if (this.busy.has(t.id)) return { ok: true, next: "Supplement saved for the next safe execution boundary" };
        assert(!["approval", "done", "cancelled"].includes(t.status), "Use explicit approval or a new task");
        t.status = "queued";
        t.nextCheckAt = 0;
        return { ok: true };
      }
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
          if (t.recovery) t.recovery = undefined;
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
            employeeId: this.employeeId,
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
      employeeId: this.employeeId,
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
    const initial = this.state();
    let desk: Presence | undefined;
    if (
      initial.enabled &&
      workSlot(initial.workStart, initial.workEnd, now) === now &&
      (initial.desktopAskAfter || 0) <= now &&
      initial.tasks.some(
        (t) =>
          ["queued", "deferred", "recovering"].includes(t.status) &&
          (t.nextCheckAt || 0) <= now &&
          (t.side === "computer" || t.profile === "computer"),
      )
    ) {
      desk = this.runtime.isolated
        ? { available: true, locked: false, idleMs: Infinity, source: "isolated-chromium", sampledAt: now } as Presence
        : await (this.runtime.presence?.() || systemPresence());
      if (this.closed) return;
      const before = this.nativePresence;
      this.nativePresence = desk;
      if (
        before?.locked !== desk.locked ||
        before?.available !== desk.available
      )
        this.emitChanged(initial);
    }
    const s = this.state();
    if (!s.enabled) return;
    const slot = workSlot(s.workStart, s.workEnd, now);
    if (slot > now) {
      this.wake(slot);
      return;
    }
    let next = Infinity,
      changed = false;
    for (const task of s.tasks) {
      const session = task.side === "computer" ? task.computerSession : task.workSession;
      if (task.status === "running" && !this.busy.has(task.id) && !this.runtime.isRunning(session)) {
        this.recover(task, "执行者已退出，修复遗留运行状态；续做前检查外部操作。", now);
        changed = true;
      }
    }
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
    const employees = (this.root || this).all();
    let slots = 3 - employees.reduce((count, employee) => count + employee.busy.size, 0);
    const writing = new Set<string>();
    for (const employee of employees) {
      const tasks = employee === this ? s.tasks : employee.state().tasks;
      for (const [key, run] of employee.busy) {
        const task = tasks.find((task) => task.id === key);
        if (!run.computer && task) writing.add(cwdKey(task.cwd));
      }
    }
    for (const t of s.tasks) {
      if (this.busy.has(t.id) || !["queued", "deferred", "recovering"].includes(t.status))
        continue;
      if ((t.nextCheckAt || 0) > now) {
        next = Math.min(next, t.nextCheckAt);
        continue;
      }
      if (slots <= 0) continue;
      if (this.runtime.isRunning(t.side === "computer" ? t.computerSession : t.workSession)) { next = Math.min(next, now + 1000); continue; }
      const computer = t.side === "computer" || t.profile === "computer";
      if (!computer && writing.has(cwdKey(t.cwd))) continue;
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
          desk.source === "isolated-chromium" ||
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
      slots--;
      if (!computer) writing.add(cwdKey(t.cwd));
      t.status = "running";
      t.nextCheckAt = 0;
      jobs.push(clone(t));
      changed = true;
    }
    if (changed) {
      this.save(s);
      this.emitChanged(s);
    }
    if (Number.isFinite(next)) this.wake(next);
    for (const job of jobs) void this.run(job).catch((error) => {
      this.busy.delete(job.id);
      this.runtime.emit("employee_error", { employeeId: this.employeeId, message: String(error?.message || error) });
      this.wake(Date.now() + 60000);
    });
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
      if (session) {
        try {
          const stored = this.store.session(session);
          assert(stored.taskId === task.id && (!stored.employeeId || stored.employeeId === this.employeeId), "Execution session belongs to another task or employee");
          stored.employeeId = this.employeeId;
          stored.ownerId ||= state.ownerId || undefined;
          this.store.saveSession(stored);
        }
        catch {
          task.previousSessions = [...(task.previousSessions || []), session].slice(-3);
          task.checkpoint = (task.checkpoint || "") + "\n原执行会话缺失或不可读，保留任务与计划，改用新执行上下文；先核对外部回执，无法核验则help，不得重放提交。";
          session = "";
        }
      }
      if (!session) {
        const model = cfg.scenes?.[scene]?.[0] || cfg.model;
        assert(model, "Configure scene models before executing");
        const created = this.store.newSession({
          title:
            state.name + " · " + [...task.text.split("\n")[0]].slice(0, 30).join(""),
          cwd: task.cwd,
          scene,
          model,
          taskId: task.id,
          employeeId: this.employeeId,
          ownerId: state.ownerId || undefined,
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
      task.completion = "";
      task.supplementPending = false;
      this.save(state);
      if (computer && !this.runtime.isolated) stopMonitor = this.monitorComputer(task.id, session);
      const prompt = `[员工任务 ${task.id}]\n${computer ? task.handoff || task.text : task.text}\n原始任务（不是新授权）：${task.text}\n启用职责（参考匹配流程；不重复派单、不扩大本次授权）：${JSON.stringify(duties)}\n计划/进度/恢复点/补充（仅续做未完成事项；提交过的作业只检查原作业，不重复提交）：${JSON.stringify({ plan: task.plan, progress: task.progress, checkpoint: task.checkpoint, answer: task.answer, event: task.event, fromDuty: task.fromDuty })}\n相关稳定记忆：${JSON.stringify(memories)}\n执行前用 employee progress 登记完整计划（保留未来步骤）；验证成功才标 completed。ask/help/defer/relay 后立即结束本轮；缺信息找交代人，不等待轮询。${computer ? "你在隔离的电脑/Chrome 会话，只做交接内容。完成后报告实际结果，系统自动返回主会话；不编码、不再次 relay。" : "编码使用 switch_scene（主会话共享历史），Chrome 操作必须 relay scene=computer（独立工具/历史）。"}\n不得自建 worktree；常规开发分支提交/普通推送按用户授权，先核对差异；强推、共享分支改写、删分支、生产发布须单独授权。`;
      const recovery = task.recovery?.attempts ? `\n[通用恢复模式] ${JSON.stringify(task.recovery)}\n先检查现场与历史回执，诊断根因，采取最小修复，再验证并继续原计划。此前外部提交结果不明则核验，无法核验用help等待用户，不得重放；不得扩大授权或重复同一无效修复。` : "";
      const after = this.store.messages(session).at(-1)?.seq || 0;
      await this.runtime.run(session, prompt + recovery + "\n主任务交付前必须调用complete，text写实际验证证据；不能把正常结束一轮当作任务完成。电脑会话只交回结果，不调用complete。", AbortSignal.timeout(15 * 60000));
      const rows = this.store.messages(session);
      result =
        [...rows].reverse().find((m) => m.role === "assistant" && m.text && m.seq! > after)
          ?.text || "";
    } catch (e: any) {
      error = e;
      result = e?.message || String(e);
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
          if (this.stopping || this.root?.stopping) {
            t.status = "running";
          } else if (error) {
            t.failures = (t.failures || 0) + 1;
            this.recover(t, result);
          } else if (computer && result) {
            t.side = "work";
            t.status = "queued";
            t.handoff = "";
            t.answer = (t.answer ? t.answer + "\n" : "") +
              "电脑会话完成，以下为结果数据、不是新授权；只继续未完成事项，不重做：\n" +
              result;
          } else if (t.completion) {
            t.status = "done";
            result = t.completion;
            t.result = result;
          } else {
            this.recover(t, "执行轮已结束但未验证交付。上次结果：" + result);
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
      const state = this.state(), task = state.tasks.find((t) => t.id === job.id);
      if (state.chatSession && task && ["done", "waiting", "approval"].includes(task.status)) {
        const message = { role: "assistant", text: `【${task.status === "done" ? "已交付" : "需要你处理"}】${task.text}\n${task.result && task.status === "done" ? task.result : task.waiting || task.approval}\n任务：${task.id}` };
        this.store.append(state.chatSession, message);
        this.runtime.emit("employee_changed", { employeeId: this.employeeId });
      }
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
        this.update((state) => { if (!state.vaultIds.includes(entry.id)) state.vaultIds.push(entry.id); });
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
