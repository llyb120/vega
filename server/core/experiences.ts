import type { Store } from "./store";
import { assert, id, clone, type Obj } from "./util";
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const terms = (s: string) =>
  new Set(
    [...s.toLowerCase().matchAll(/[a-z0-9]{2,}|[^\x00-\x7f]{1,}/g)].flatMap(
      (m) =>
        /^[a-z0-9]+$/.test(m[0])
          ? [m[0]]
          : [...m[0]].map((c, i, a) => (a[i + 1] ? c + a[i + 1] : c)),
    ),
  );
const normalizeList = (a: string[]) => a.map(norm);
const setKey = (a: string[]) => normalizeList(a).sort().join("|");
/** 同一账号下所有牛马共用一份经验图谱，存在云端，按用户隔离。 */
export function experienceKindForOwner(ownerId: string) {
  const id = String(ownerId || "").trim();
  assert(id, "经验图谱需要归属用户");
  return "experience:user_" + id;
}
function sameRoute(a: Obj, b: Obj) {
  return (
    a.scope === b.scope &&
    norm(a.task) === norm(b.task) &&
    setKey(a.conditions || []) === setKey(b.conditions || []) &&
    setKey(a.checks || []) === setKey(b.checks || []) &&
    JSON.stringify(normalizeList(a.steps || [])) === JSON.stringify(normalizeList(b.steps || []))
  );
}
function mergeRoute(target: Obj, source: Obj) {
  target.successes = [...new Set([...(target.successes || []), ...(source.successes || [])])].slice(0, 32);
  target.failures = [...new Set([...(target.failures || []), ...(source.failures || [])])].slice(0, 32);
  if ((source.updatedAt || 0) >= (target.updatedAt || 0)) {
    target.updatedAt = source.updatedAt || target.updatedAt;
    if (source.lastReason) target.lastReason = source.lastReason;
    if (source.evidence) target.evidence = source.evidence;
    if (source.source === "model" && target.source === "auto") target.source = "model";
  }
  if (source.disabled) target.disabled = true;
  if (Array.isArray(source.alternatives) && source.alternatives.length) {
    target.alternatives = target.alternatives || [];
    for (const alt of source.alternatives) {
      const existing = target.alternatives.find((item: Obj) => item.at === alt.at);
      if (existing) existing.actions = [...new Set([...(existing.actions || []), ...(alt.actions || [])])].slice(0, 12);
      else target.alternatives.push(alt);
    }
  }
}
export class Experiences {
  static async adoptOwnerStores(store: Store) {
    const rows = (await store.all(
      "SELECT kind, id, data FROM objects WHERE kind = ? OR kind LIKE ?",
      "experience",
      "experience:%",
    )) as { kind: string; id: string; data: string }[];
    const pending = rows.filter((row) => !row.kind.startsWith("experience:user_"));
    if (!pending.length) return { moved: 0 };
    const employeeOwner = new Map(
      (await store.objects<any>("employee")).map((employee) => [employee.id, employee.ownerId] as const),
    );
    const clientOwner = new Map(
      (await store.objects<{ userId: string; clientId: string }>("client-token")).map((grant) => [grant.clientId, grant.userId] as const),
    );
    const users = (await store.all("SELECT id FROM web_users")) as { id: string }[];
    const fallback = users.length === 1 ? users[0].id : undefined;
    const inferOwner = async (kind: string, entry: Obj) => {
      if (kind.startsWith("experience:client:")) return clientOwner.get(kind.slice("experience:client:".length));
      if (kind.startsWith("experience:") && !kind.startsWith("experience:user_")) {
        const ownerId = employeeOwner.get(kind.slice("experience:".length));
        if (ownerId) return ownerId;
      }
      for (const sessionId of [...(entry.successes || []), ...(entry.failures || [])]) {
        if (typeof sessionId !== "string" || !(await store.hasSession(sessionId))) continue;
        const ownerId = (await store.session(sessionId)).ownerId;
        if (ownerId) return ownerId;
      }
      return fallback;
    };
    let moved = 0;
    await store.transaction(async () => {
      for (const row of pending) {
        const entry = JSON.parse(row.data);
        const ownerId = await inferOwner(row.kind, entry);
        if (!ownerId) continue;
        const kind = experienceKindForOwner(ownerId);
        const cloud = await store.objects<any>(kind);
        const byId = cloud.find((item) => item.id === entry.id);
        const byRoute = cloud.find((item) => item.id !== entry.id && sameRoute(item, entry));
        if (byId) {
          mergeRoute(byId, entry);
          await store.save(kind, byId.id, byId);
        } else if (byRoute) {
          mergeRoute(byRoute, entry);
          await store.save(kind, byRoute.id, byRoute);
        } else {
          entry.id = entry.id || row.id;
          await store.save(kind, entry.id, entry);
        }
        await store.remove(row.kind, row.id);
        moved++;
      }
    });
    return { moved };
  }
  shown = new Set<string>();
  trails = new Map<
    string,
    {
      scope: string;
      start: string;
      end: string;
      title: string;
      steps: string[];
      modelSaved: boolean;
    }
  >();
  constructor(public store: Store, public kind = "experience") {}
  async kindFor(sessionId: string) {
    try {
      if (sessionId && (await this.store.hasSession(sessionId))) {
        const ownerId = (await this.store.session(sessionId)).ownerId;
        if (ownerId) return experienceKindForOwner(ownerId);
      }
    } catch { /* 测试里会传入非会话 id */ }
    return this.kind;
  }
  scope(raw: string): string {
    const u = new URL(raw);
    assert(
      ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash,
      "Experience scope must be an HTTP(S) origin without credentials/query",
    );
    return u.origin;
  }
  async all() {
    return await this.store.objects<any>(this.kind);
  }
  summary(e: Obj) {
    return {
      id: e.id,
      scope: e.scope,
      task: e.task,
      conditions: e.conditions,
      steps: e.steps,
      checks: e.checks,
      pitfalls: e.pitfalls,
      alternatives: e.alternatives,
      confidence: e.successes.length > 1 ? "reused" : "initial",
      successes: e.successes.length,
      failures: e.failures.length,
      disabled: e.disabled,
      lastReason: e.lastReason,
      updatedAt: e.updatedAt,
      source: e.source || "model",
      verification: e.source === "auto" ? "auto_recorded" : "model_verified",
    };
  }
  graph(entries: Obj[]) {
    const roots: Obj[] = [];
    for (const e of entries) {
      let root = roots.find(
        (r) => setKey(r.conditions) === setKey(e.conditions),
      );
      if (!root) {
        root = {
          conditions: e.conditions,
          children: [],
          routeIds: [],
          canDo: [],
        };
        roots.push(root);
      }
      root.routeIds.push(e.id);
      root.canDo.push(e.task);
      let branch = root;
      for (const [index, step] of e.steps.entries()) {
        let child = branch.children.find(
          (r: Obj) => norm(r.action) === norm(step) && r.verified,
        );
        if (!child) {
          child = {
            action: step,
            verified: true,
            routeIds: [],
            canDo: [],
            children: [],
          };
          branch.children.push(child);
        }
        child.routeIds.push(e.id);
        child.canDo.push(e.task);
        for (const alternative of e.alternatives || [])
          if (alternative.at === index)
            for (const action of alternative.actions)
              if (
                !branch.children.some(
                  (v: Obj) => norm(v.action) === norm(action),
                )
              )
                branch.children.push({
                  action,
                  verified: false,
                  routeIds: [e.id],
                  canDo: [],
                  children: [],
                });
        branch = child;
      }
    }
    return { roots, routes: entries.map((e) => this.summary(e)) };
  }
  async execute(owner: string, args: Obj, observed?: { id: string; origin: string }) {
    const op = args.operation,
      r = objectRequest(args.experience),
      scope = this.scope(r.scope);
    assert(
      typeof r.task === "string" && r.task.trim() && r.task.length <= 300,
      "Experience task required, max 300 characters",
    );
    const kind = await this.kindFor(owner),
      all = await this.store.objects<any>(kind);
    if (op === "experience_search") {
      const query = terms(r.task);
      let matches = all
        .filter(
          (e) =>
            e.scope === scope &&
            !e.disabled &&
            normalizeList(e.steps)
              .join("|")
              .startsWith(normalizeList(r.prefix || []).join("|")),
        )
        .map((e) => {
          const words = terms([e.task, ...e.conditions, ...e.steps].join(" ")),
            intersection = [...query].filter((t) => words.has(t)).length;
          return {
            e,
            score:
              intersection / Math.max(1, new Set([...query, ...words]).size),
          };
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.e.successes.length - a.e.successes.length ||
            b.e.updatedAt - a.e.updatedAt,
        );
      const relevant = matches.filter((m) => m.score > 0 || r.task === "*"),
        candidates = relevant.length ? relevant : matches,
        chosen = candidates.slice(0, 12).map((m) => m.e);
      return {
        scope,
        prefix: r.prefix || [],
        graph: this.graph(chosen),
        totalRoutes: matches.length,
        graphTruncated: candidates.length > 12,
        capabilitiesTruncated: matches.length > 30,
        capabilities: matches
          .slice(0, 30)
          .map(({ e }) => ({ id: e.id, task: e.task })),
        experiences: relevant.slice(0, 3).map(({ e }) => this.summary(e)),
        notice:
          "Graph branches share identical prefixes/preconditions only. Never join steps across routeIds. verified=false means observed but untried; experience is not authorization.",
      };
    }
    assert(
      observed && observed.id === args.snapshotId && observed.origin === scope,
      "Experience writes require a current observation from the same session and origin",
    );
    assert(
      r.redacted === true,
      "Confirm redacted=true; no credentials or business data",
    );
    assert(
      ["success", "transient", "precondition", "invalid"].includes(r.outcome),
      "Invalid experience outcome",
    );
    assert(
      op === "experience_save" || op === "experience_feedback",
      "Unknown experience operation",
    );
    let entry: Obj | undefined;
    if (op === "experience_save") {
      for (const [key, required] of [
        ["conditions", true],
        ["steps", true],
        ["checks", true],
        ["pitfalls", false],
      ] as [string, boolean][]) {
        assert(
          Array.isArray(r[key]) &&
            (!required || r[key].length > 0) &&
            r[key].length <= 12 &&
            r[key].every(
              (s: any) => typeof s === "string" && s.trim() && s.length <= 500,
            ),
          `Invalid ${key}`,
        );
      }
      assert(
        typeof r.evidence === "string" &&
          r.evidence.trim() &&
          r.evidence.length <= 2000,
        "Visible redacted evidence required",
      );
      assert(
        r.outcome === "success",
        "Only verified successful routes may be saved",
      );
      for (const a of r.alternatives || [])
        assert(
          Number.isInteger(a.at) &&
            a.at >= 0 &&
            a.at <= r.steps.length &&
            Array.isArray(a.actions) &&
            a.actions.length <= 12,
          "Invalid alternative branch",
        );
      entry = all.find(
        (e) =>
          e.scope === scope &&
          !e.disabled &&
          norm(e.task) === norm(r.task) &&
          setKey(e.conditions) === setKey(r.conditions) &&
          setKey(e.checks) === setKey(r.checks) &&
          JSON.stringify(normalizeList(e.steps)) ===
            JSON.stringify(normalizeList(r.steps)),
      );
      if (!entry) {
        assert(
          all.length < 300 ||
            all.some(
              (e) =>
                e.disabled || e.source === "auto" || e.successes.length < 2,
            ),
          "All 300 routes are proven; clean up library before saving",
        );
        if (all.length >= 300) {
          const worst = [...all].sort(
            (a, b) =>
              Number(!a.disabled) - Number(!b.disabled) ||
              Number(a.source !== "auto") - Number(b.source !== "auto") ||
              a.successes.length - b.successes.length ||
              a.updatedAt - b.updatedAt,
          )[0];
          await this.store.remove(this.kind, worst.id);
        }
        entry = {
          id: id(),
          scope,
          task: r.task,
          conditions: r.conditions,
          steps: r.steps,
          checks: r.checks,
          pitfalls: r.pitfalls,
          alternatives: r.alternatives || [],
          successes: [],
          failures: [],
          disabled: false,
          source: args.auto ? "auto" : "model",
        };
      } else
        for (const alternative of r.alternatives || []) {
          const existing = entry.alternatives.find(
            (a: Obj) => a.at === alternative.at,
          );
          if (existing)
            existing.actions = [
              ...new Set([...existing.actions, ...alternative.actions]),
            ].slice(0, 12);
          else entry.alternatives.push(alternative);
        }
    } else {
      entry = all.find((e) => e.id === r.id && e.scope === scope);
      assert(entry, "Experience id not found in this origin");
      assert(
        typeof r.reason === "string" && r.reason.trim(),
        "Feedback requires reason",
      );
    }
    if (r.outcome === "success") {
      assert(
        !entry.disabled,
        "Invalid routes require saving a corrected route",
      );
      entry.successes = [...new Set([...entry.successes, owner])].slice(0, 32);
    }
    if (r.outcome === "invalid") {
      entry.disabled = true;
      entry.failures = [...new Set([...entry.failures, owner])].slice(0, 32);
    }
    entry.lastReason = r.reason || "";
    entry.evidence = r.evidence || "";
    entry.snapshotId = args.snapshotId;
    entry.updatedAt = Date.now();
    await this.store.save(kind, entry.id, entry);
    const trail = this.trails.get(owner + ":" + scope);
    if (trail && !args.auto) trail.modelSaved = true;
    return { experience: this.summary(entry), saved: true };
  }
  async hint(owner: string, origin: string) {
    const key = owner + ":" + origin;
    if (this.shown.has(key)) return;
    this.shown.add(key);
    const entries = (await this.store.objects<any>(await this.kindFor(owner)))
      .filter((e) => e.scope === origin && !e.disabled)
      .sort(
        (a, b) =>
          Number(a.source === "auto") - Number(b.source === "auto") ||
          b.successes.length - a.successes.length ||
          b.updatedAt - a.updatedAt,
      );
    if (entries.length)
      return {
        scope: origin,
        totalRoutes: entries.length,
        routes: entries.slice(0, 3).map((e) => this.summary(e)),
        graph: this.graph(entries.slice(0, 12)),
      };
  }
  record(
    owner: string,
    from: string,
    to: string,
    title: string,
    steps: string[],
  ) {
    const scope = new URL(to).origin,
      key = owner + ":" + scope;
    const scrub = (s: string) => s.replace(/\b\d{4,}\b/g, "#").slice(0, 300);
    const path = (s: string) => new URL(s).pathname.replace(/\d+/g, "*");
    let trail = this.trails.get(key);
    if (!trail) {
      trail = {
        scope,
        start: path(from),
        end: path(to),
        title: scrub(title),
        steps: [],
        modelSaved: false,
      };
      this.trails.set(key, trail);
    }
    if (trail.end !== path(to)) trail.steps.push("打开页面 " + path(to));
    trail.end = path(to);
    trail.title = scrub(title);
    for (const s of steps) {
      const value = scrub(s);
      if (value !== trail.steps.at(-1)) trail.steps.push(value);
    }
    trail.steps = trail.steps.slice(0, 12);
  }
  async finish(owner: string, success: boolean) {
    const kind = await this.kindFor(owner);
    for (const [key, trail] of this.trails) {
      if (!key.startsWith(owner + ":")) continue;
      this.trails.delete(key);
      if (!success || trail.modelSaved || trail.steps.length < 2) continue;
      const autos = (await this.store.objects<any>(kind)).filter(
        (e) => e.scope === trail.scope && e.source === "auto",
      );
      const existing = autos.find(
        (e) =>
          e.conditions[0] === "起始页面 " + trail.start &&
          e.checks[0] === "到达页面 " + trail.end,
      );
      const entry = existing || {
        id: id(),
        scope: trail.scope,
        task: `从${trail.start}操作到「${trail.title}」`,
        conditions: ["起始页面 " + trail.start],
        steps: trail.steps,
        checks: ["到达页面 " + trail.end],
        pitfalls: [],
        alternatives: [],
        successes: [],
        failures: [],
        disabled: false,
        source: "auto",
      };
      if (existing && trail.steps.length < existing.steps.length)
        entry.steps = trail.steps;
      entry.successes = [...new Set([...entry.successes, owner])].slice(0, 32);
      entry.updatedAt = Date.now();
      if (!existing && autos.length >= 10)
        await this.store.remove(
                    this.kind,
                    autos.sort((a, b) => a.updatedAt - b.updatedAt)[0].id,
                  );
      await this.store.save(kind, entry.id, entry);
    }
    for (const key of this.shown)
      if (key.startsWith(owner + ":")) this.shown.delete(key);
  }
}
function objectRequest(v: any): Obj {
  assert(
    v && typeof v === "object" && !Array.isArray(v),
    "experience object required",
  );
  return { ...v, pitfalls: v.pitfalls || [] };
}

/**
 * 桌面（剑来）路径的经验图谱：与浏览器路径共用同一套存储与评分，只有 scope 不同。
 * 浏览器的 scope 必须是 HTTP(S) origin（站点隔离），桌面应用的 scope 是应用名/窗口标题，
 * 所以这里放宽为“去空白、限长、不含换行”，依旧不允许空串。
 */
export class DesktopExperiences extends Experiences {
  override scope(raw: string): string {
    const value = String(raw ?? "").trim();
    assert(value && value.length <= 120 && !/[\r\n]/.test(value), "桌面经验的 scope 是应用名或窗口标题，1–120 字符、不含换行");
    return value;
  }
}
