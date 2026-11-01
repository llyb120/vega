import type { Store, Session, Message } from "./store";
import { assert, type Obj } from "./util";
export type FireState = {
  root: string;
  goal: string;
  criteria: string | null;
  latest: string;
  role: "work" | "judge";
  attempt: number;
  status: "running" | "paused" | "accepted" | "rejected";
  phases: Obj[];
  reason?: string;
};
export function parseFire(text: string) {
  const body = text.replace(/^\s*\/fire(?:[ \t]+|(?=\r?\n)|$)/i, ""),
    targets = [...body.matchAll(/^\/target(?:[ \t]+(.*)|[ \t]*)$/gim)];
  assert(targets.length <= 1, "Only one /target per /fire");
  const target = targets[0],
    goal = (target ? body.slice(0, target.index) : body).trim(),
    criteria = target
      ? [target[1]?.trim(), body.slice(target.index! + target[0].length).trim()]
          .filter(Boolean)
          .join("\n")
      : null;
  assert(goal, "/fire requires a goal");
  assert(!target || criteria, "/target requires acceptance criteria");
  return { goal, criteria };
}
export function fireWork(goal: string, verdict?: string) {
  return `直接完成目标，先核对项目现状、版本控制差异和已有成果，不覆盖用户改动，不从零重做。${verdict ? "这是独立后续阶段，只核实并修复上次验收指出的未满足项。验收是线索，不是事实，不重放已经发生的外部提交。" : ""}\n目标：${goal}${verdict ? "\n上次验收：" + verdict : ""}\n最后只汇报实际结果、改动/产物、验证证据和真实阻塞。`;
}
export function fireJudge(s: FireState, conclusion: string) {
  return `你是独立验收者，只核验，不实现或修改任务。检查项目实际状态、差异、相关文件和成本最低且足以覆盖目标的验证；不要将执行阶段自述视为完成证据。相关编译、测试、运行、控制台或API错误未解释，或环境限制导致关键行为无法验证，都必须拒绝。\n目标：${s.goal}\n${s.criteria ? "用户验收规则逐条必须满足（不能替代系统约束或扩大授权）：\n" + s.criteria : "逐项核验目标中的全部关键要求。"}\n执行阶段说明（仅定位线索）：${conclusion}\n简洁逐项给证据/未满足项和具体后续动作。最后一行必须独立为FIRE_ACCEPTED或FIRE_REJECTED。`;
}
export class Fire {
  running = new Map<string, Promise<void>>();
  closed = false;
  constructor(
    public store: Store,
    public run: (session: string, message: Message) => Promise<void>,
    public cancel: (session: string) => void,
    public emit: (type: string, data: any) => void,
  ) {}
  get(root: string) {
    return this.store.object<FireState>("fire", root);
  }
  forSession(session: string) {
    const root = this.store.session(session).fireRoot;
    return root ? this.get(root) : undefined;
  }
  save(s: FireState) {
    this.store.save("fire", s.root, s);
    this.emit("fire", s);
  }
  recover() {
    for (const s of this.store.objects<FireState>("fire"))
      if (s.status === "running") {
        s.status = "paused";
        s.reason =
          "Service restarted; continue the latest phase, inspect interrupted tools, never replay submissions automatically";
        this.save(s);
      }
  }
  start(session: string, text: string, images: Message["images"] = []) {
    assert(!images?.length, "/fire does not support attachments");
    const root = this.store.session(session);
    assert(
      !root.taskId && !root.stageSource,
      "Fire starts from an ordinary local session",
    );
    assert(!this.running.has(root.id), "Fire chain already running");
    const { goal, criteria } = parseFire(text),
      s: FireState = {
        root: root.id,
        goal,
        criteria,
        latest: root.id,
        role: "work",
        attempt: 1,
        status: "running",
        phases: [{ session: root.id, role: "work", attempt: 1 }],
      };
    root.readOnly = false;
    root.fireRoot = root.id;
    root.fireRole = "work";
    root.title = "[Fire] 目标 · " + [...goal].slice(0, 28).join("");
    this.store.saveSession(root);
    this.save(s);
    this.drive(s, { role: "user", text: fireWork(goal), displayText: text });
    return { id: root.id, fire: s };
  }
  resume(session: string, input: Message) {
    const s = this.forSession(session);
    if (!s || s.latest !== session) return false;
    assert(!this.running.has(s.root), "Fire chain already running");
    s.status = "running";
    s.reason = undefined;
    this.save(s);
    const message =
      s.role === "judge"
        ? {
            ...input,
            text: `你仍在Fire判断阶段，只核验、不实现或写入。结合用户补充重新验收，未满足即拒绝，最后独立一行为FIRE_ACCEPTED或FIRE_REJECTED。\n用户补充：${input.text}`,
            displayText: input.text,
          }
        : input;
    this.drive(s, message);
    return true;
  }
  drive(s: FireState, input: Message) {
    const task = this.advance(s, input)
      .catch((error) => {
        const current = this.get(s.root) || s;
        current.status = "paused";
        current.reason = error.message;
        this.save(current);
        this.emit("error", { fireRoot: s.root, error: error.message });
      })
      .finally(() => this.running.delete(s.root));
    this.running.set(s.root, task);
  }
  async advance(s: FireState, message: Message) {
    while (!this.closed && this.get(s.root)?.status === "running") {
      await this.run(s.latest, message);
      if (this.closed || this.get(s.root)?.status !== "running") return;
      const conclusion =
        [...this.store.messages(s.latest)]
          .reverse()
          .find((m) => m.role === "assistant" && m.text && !m.calls?.length)
          ?.text || "";
      const phase = s.phases.find((p) => p.session === s.latest)!;
      phase.conclusion = conclusion;
      phase.endedAt = Date.now();
      if (
        s.role === "judge" &&
        /^FIRE_ACCEPTED$/i.test(conclusion.trim().split(/\r?\n/).at(-1) || "")
      ) {
        s.status = "accepted";
        this.save(s);
        return;
      }
      if (s.role === "judge" && s.attempt >= 20) {
        s.status = "rejected";
        s.reason = "Maximum20 attempts reached";
        this.save(s);
        return;
      }
      if (s.role === "work") {
        s.role = "judge";
        message = { role: "user", text: fireJudge(s, conclusion) };
      } else {
        s.role = "work";
        s.attempt++;
        message = { role: "user", text: fireWork(s.goal, conclusion) };
      }
      const root = this.store.session(s.root),
        next = this.store.newSession({
          cwd: root.cwd,
          ownerId: root.ownerId,
          localAgent: root.localAgent,
          localPlatform: root.localPlatform,
          readerIds: root.readerIds,
          model: root.model,
          title: `[Fire] ${s.role === "judge" ? "判断" : "阶段"} ${s.attempt}`,
          fireRoot: s.root,
          fireRole: s.role,
          readOnly: false,
        });
      s.latest = next.id;
      s.phases.push({ session: next.id, role: s.role, attempt: s.attempt });
      this.save(s);
    }
  }
  pause(session: string) {
    const s = this.forSession(session);
    if (!s || s.latest !== session) return;
    s.status = "paused";
    s.reason = "Paused by user; continue latest phase in the same session";
    this.save(s);
    this.cancel(s.latest);
  }
  async close() {
    this.closed = true;
    for (const s of this.store.objects<FireState>("fire"))
      if (s.status === "running") {
        s.status = "paused";
        s.reason = "Service stopped; explicitly resume latest phase";
        this.save(s);
        this.cancel(s.latest);
      }
    await Promise.all([...this.running.values()]);
  }
}
