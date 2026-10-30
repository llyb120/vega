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
export class Experiences {
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
  constructor(public store: Store) {}
  scope(raw: string) {
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
  all() {
    return this.store.objects<any>("experience");
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
  execute(owner: string, args: Obj, observed?: { id: string; origin: string }) {
    const op = args.operation,
      r = objectRequest(args.experience),
      scope = this.scope(r.scope);
    assert(
      typeof r.task === "string" && r.task.trim() && r.task.length <= 300,
      "Experience task required, max 300 characters",
    );
    const all = this.all();
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
          this.store.remove("experience", worst.id);
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
    this.store.save("experience", entry.id, entry);
    const trail = this.trails.get(owner + ":" + scope);
    if (trail && !args.auto) trail.modelSaved = true;
    return { experience: this.summary(entry), saved: true };
  }
  hint(owner: string, origin: string) {
    const key = owner + ":" + origin;
    if (this.shown.has(key)) return;
    this.shown.add(key);
    const entries = this.all()
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
  finish(owner: string, success: boolean) {
    for (const [key, trail] of this.trails) {
      if (!key.startsWith(owner + ":")) continue;
      this.trails.delete(key);
      if (!success || trail.modelSaved || trail.steps.length < 2) continue;
      const autos = this.all().filter(
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
        this.store.remove(
          "experience",
          autos.sort((a, b) => a.updatedAt - b.updatedAt)[0].id,
        );
      this.store.save("experience", entry.id, entry);
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
