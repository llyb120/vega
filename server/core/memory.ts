import { assert, id, type Obj } from "./util";

export const MEMORY_KINDS = [
  "preference",
  "convention",
  "procedure",
  "environment",
  "person_org",
  "correction",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SCENES = ["chat", "coding", "computer", "any"] as const;
export type MemoryScene = (typeof MEMORY_SCENES)[number];

export const MEMORY_STATUSES = ["active", "draft", "conflict", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type MemoryLinks = {
  mergedFrom?: string[];
  conflictsWith?: string[];
  vaultNames?: string[];
};

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  claim: string;
  evidence?: string;
  scope: string;
  scene: MemoryScene;
  confidence: number;
  usefulness: number;
  status: MemoryStatus;
  links: MemoryLinks;
  pinned?: boolean;
  ttl?: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  lastVerifiedAt?: number;
  /** @deprecated legacy mirror for gradual UI; prefer claim */
  text?: string;
  /** @deprecated */
  importance?: number;
  /** @deprecated */
  strength?: number;
  /** @deprecated */
  at?: number;
  usedAt?: number;
};

export const ACTIVE_MEMORY_CAP = 300;
/** Tier 1: pinned, preference and correction memories are injected every turn, regardless of the query. */
export const MEMORY_ALWAYS_K = 8;
/** Tier 2: the remaining memories, ranked by relevance to the query. */
export const MEMORY_TOP_K = 6;
export const MEMORY_RELEVANCE_FLOOR = 0.08;
export const MEMORY_CLAIM_MAX = 200;
export const MEMORY_MERGE_SIM = 0.72;
export const MEMORY_CONFLICT_SIM = 0.55;
export const ARCHIVE_SCORE = 0.08;
export const HARD_DELETE_ARCHIVE_DAYS = 180;

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: "偏好",
  convention: "约定",
  procedure: "流程",
  environment: "环境",
  person_org: "人事",
  correction: "纠错",
};

const SLOW_DECAY = new Set<MemoryKind>(["preference", "correction"]);

/** Standing memories hold every turn, so recall never gates them on the wording of the current query. */
export function isStandingMemory(m: MemoryRecord) {
  return !!m.pinned || SLOW_DECAY.has(m.kind);
}

export function isMemoryKind(v: any): v is MemoryKind {
  return MEMORY_KINDS.includes(v);
}

export function isMemoryScene(v: any): v is MemoryScene {
  return MEMORY_SCENES.includes(v);
}

export function isMemoryStatus(v: any): v is MemoryStatus {
  return MEMORY_STATUSES.includes(v);
}

export function normalizeClaim(text: string) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》,.!?;:'"()\[\]{}<>]/g, "");
}

function bigrams(s: string) {
  const a = [...normalizeClaim(s).replace(/[^\p{L}\p{N}]/gu, "")];
  if (a.length < 2) return new Set(a.length ? [a[0]] : []);
  return new Set(a.slice(1).map((c, i) => a[i] + c));
}

export function similarity(a: string, b: string) {
  const na = normalizeClaim(a),
    nb = normalizeClaim(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na),
    B = bigrams(nb);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function relevance(query: string, claim: string) {
  const q = normalizeClaim(query),
    c = normalizeClaim(claim);
  if (!q || !c) return 0;
  if (q.includes(c) || c.includes(q)) return Math.max(0.85, similarity(q, c));
  const sim = similarity(q, c);
  const Q = bigrams(q),
    C = bigrams(c);
  if (!Q.size || !C.size) return sim;
  let hit = 0;
  for (const x of C) if (Q.has(x)) hit++;
  const claimCoverage = hit / C.size;
  let qhit = 0;
  for (const x of Q) if (C.has(x)) qhit++;
  const queryCoverage = qhit / Q.size;
  return Math.max(sim, claimCoverage, queryCoverage * 0.95);
}

const SECRET_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|authorization)\b\s*[:=]/i, reason: "疑似凭据字段" },
  { re: /\b(sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/, reason: "疑似密钥/令牌" },
  { re: /(验证码|otp|one[-\s]?time|2fa|mfa)\s*[:：]?\s*\d{4,8}/i, reason: "验证码/OTP" },
  { re: /(登录|login).{0,40}(一次性|临时|expire|ttl).{0,20}(链接|link|url|令牌|token|密码|口令)|(登录|login).{0,10}(链接|link|url|令牌|token).{0,30}(一次性|临时|expire|ttl)/i, reason: "一次性登录材料" },
  { re: /tabtag\s*[:=]/i, reason: "当次浏览器标签状态" },
  { re: /about:blank/i, reason: "当次浏览器空白页状态" },
  { re: /bearer\s+[a-z0-9\-._~+/]+=*/i, reason: "Bearer Token" },
];

/**
 * One-off state, not the concept: a countdown, a resend timer or a checkpoint only counts when it carries a concrete
 * number, time or value ("倒计时 58 秒", "60秒后重发", "恢复点：…"); "页面有倒计时，到点前不要提交" is a stable procedure.
 */
const EPHEMERAL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /当前进度|本轮|这次任务|刚才失败|planRevision/i, reason: "当次任务的进度或状态" },
  { re: /临时(?:进度|状态|结果|链接|地址|方案)/, reason: "临时状态" },
  { re: /(?:恢复点|checkpoint)\s*[:：=]/i, reason: "当次恢复点" },
  { re: /倒计时[^，。；,.;\n]{0,8}?\d[\d:：.]*\s*(?:秒|分钟?|s)?|\d+\s*(?:秒|s|分钟?)[^，。；,.;\n]{0,4}?倒计时|(?:剩余?|还剩)\s*\d+\s*(?:秒|分钟?)/i, reason: "带具体数值的倒计时" },
  { re: /\d+\s*(?:秒|s)\s*后(?:可)?重(?:新)?发/i, reason: "当次重发计时" },
];

export type GateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function gateMemoryClaim(claim: string, evidence = ""): GateResult {
  const text = `${claim}\n${evidence}`.trim();
  const length = [...claim.trim()].length;
  if (!claim.trim()) return { ok: false, code: "empty", message: "记忆未保存：主张为空。" };
  if (length > MEMORY_CLAIM_MAX)
    return {
      ok: false,
      code: "too_long",
      message: `记忆未保存：claim 为 ${length} 字，要求 1–${MEMORY_CLAIM_MAX} 字。请提炼一条稳定主张；多件事分开保存，不要原样重试或直接截断。`,
    };
  for (const { re, reason } of SECRET_PATTERNS) {
    if (re.test(text))
      return {
        ok: false,
        code: "secret",
        message: `记忆未保存：${reason}。凭据与验证码只走密码本/任务状态，不能写入记忆。`,
      };
  }
  if (/^\d{4,8}$/.test(claim.trim()) || (/(验证码|otp)/i.test(text) && /\d{4,8}/.test(text)))
    return {
      ok: false,
      code: "secret",
      message: "记忆未保存：验证码/OTP。凭据与验证码只走密码本/任务状态，不能写入记忆。",
    };
  for (const { re, reason } of EPHEMERAL_PATTERNS) {
    const hit = claim.match(re)?.[0];
    if (hit)
      return {
        ok: false,
        code: "ephemeral",
        message: `记忆未保存：命中“${hit}”（${reason}），这像当次进度或一次性状态，请写入任务进度或 task_wait 的恢复点，不要记入长期记忆。若这是长期成立的规则，去掉当次的具体数值或状态后重写。`,
      };
  }
  return { ok: true };
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

export function isLegacyMemory(m: any) {
  return m && typeof m === "object" && typeof m.text === "string" && m.claim === undefined;
}

export function migrateMemory(raw: any, now = Date.now()): MemoryRecord {
  if (raw && typeof raw.claim === "string" && isMemoryKind(raw.kind)) {
    const m = normalizeRecord(raw, now);
    return m;
  }
  const text = String(raw?.text || raw?.claim || "").trim();
  const importance = Math.max(1, Math.min(3, Number(raw?.importance) || 1));
  const strength = Math.max(1, Number(raw?.strength) || 1);
  const createdAt = Number(raw?.at || raw?.createdAt) || now;
  const lastUsedAt = Number(raw?.usedAt || raw?.lastUsedAt) || undefined;
  const confidence = clamp01(0.35 + (importance - 1) * 0.2 + Math.min(0.25, (strength - 1) * 0.05));
  const usefulness = clamp01(0.3 + Math.min(0.4, (strength - 1) * 0.05) + (importance >= 3 ? 0.2 : 0));
  return normalizeRecord(
    {
      id: raw?.id || id("m"),
      kind: importance >= 3 ? "preference" : "convention",
      claim: [...text].slice(0, MEMORY_CLAIM_MAX).join(""),
      scope: "global",
      scene: "any",
      confidence,
      usefulness,
      status: "active",
      links: {},
      pinned: importance >= 3,
      createdAt,
      updatedAt: createdAt,
      lastUsedAt,
      lastVerifiedAt: lastUsedAt,
    },
    now,
  );
}

export function normalizeRecord(raw: any, now = Date.now()): MemoryRecord {
  const kind = isMemoryKind(raw.kind) ? raw.kind : "convention";
  const claim = String(raw.claim || raw.text || "").trim();
  const status = isMemoryStatus(raw.status) ? raw.status : "active";
  const scene = isMemoryScene(raw.scene) ? raw.scene : "any";
  const scope = String(raw.scope || "global").trim() || "global";
  const links: MemoryLinks = {
    mergedFrom: Array.isArray(raw.links?.mergedFrom) ? raw.links.mergedFrom.map(String) : undefined,
    conflictsWith: Array.isArray(raw.links?.conflictsWith) ? raw.links.conflictsWith.map(String) : undefined,
    vaultNames: Array.isArray(raw.links?.vaultNames) ? raw.links.vaultNames.map(String) : undefined,
  };
  return {
    id: String(raw.id || id("m")),
    kind,
    claim: [...claim].slice(0, MEMORY_CLAIM_MAX).join(""),
    evidence: raw.evidence ? String(raw.evidence).slice(0, 500) : undefined,
    scope,
    scene,
    confidence: clamp01(Number(raw.confidence ?? 0.5)),
    usefulness: clamp01(Number(raw.usefulness ?? 0.4)),
    status,
    links,
    pinned: !!raw.pinned,
    ttl: raw.ttl != null && Number.isFinite(Number(raw.ttl)) ? Number(raw.ttl) : undefined,
    createdAt: Number(raw.createdAt || raw.at) || now,
    updatedAt: Number(raw.updatedAt || raw.at) || now,
    lastUsedAt: raw.lastUsedAt != null ? Number(raw.lastUsedAt) : raw.usedAt != null ? Number(raw.usedAt) : undefined,
    lastVerifiedAt: raw.lastVerifiedAt != null ? Number(raw.lastVerifiedAt) : undefined,
    // mirrors for older UI/tests during transition
    text: [...claim].slice(0, MEMORY_CLAIM_MAX).join(""),
    at: Number(raw.createdAt || raw.at) || now,
    usedAt: raw.lastUsedAt != null ? Number(raw.lastUsedAt) : raw.usedAt != null ? Number(raw.usedAt) : undefined,
    importance: raw.pinned || kind === "preference" || kind === "correction" ? 3 : kind === "convention" ? 2 : 1,
    strength: Math.max(1, Math.round(1 + clamp01(Number(raw.usefulness ?? 0.4)) * 8)),
  };
}

export function migrateMemories(list: any[] | undefined, now = Date.now()) {
  const memories = Array.isArray(list) ? list.map((m) => migrateMemory(m, now)) : [];
  let changed = !Array.isArray(list) || list.some((m, i) => isLegacyMemory(m) || m?.claim !== memories[i]?.claim || m?.kind !== memories[i]?.kind);
  return { memories, changed };
}

export function scopeCompatible(a: string, b: string) {
  if (a === b) return true;
  if (a === "global" || b === "global") return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return false;
}

function contradiction(a: string, b: string) {
  const na = normalizeClaim(a),
    nb = normalizeClaim(b);
  if (!na || !nb || na === nb) return false;
  const neg = /(不要|别再|绝不能|不可|禁止|避免|勿|别|不|never|don't|do not|must not|cannot)/i;
  const aNeg = neg.test(a),
    bNeg = neg.test(b);
  if (aNeg === bNeg) return false;
  const strip = (s: string) =>
    normalizeClaim(s.replace(/不要|别再|绝不能|不可|禁止|避免|勿|别|不|never|don't|do not|must not|cannot/gi, ""));
  return similarity(strip(a), strip(b)) >= 0.55;
}

export function memoryScore(
  m: MemoryRecord,
  query: string,
  opts: { scene?: MemoryScene; scope?: string; now?: number } = {},
) {
  const now = opts.now ?? Date.now();
  const rel = relevance(query, m.claim);
  const sceneBoost = !opts.scene || m.scene === "any" || m.scene === opts.scene ? 0.08 : -0.25;
  const scopeBoost =
    !opts.scope || scopeCompatible(m.scope, opts.scope) ? (m.scope !== "global" && opts.scope && m.scope === opts.scope ? 0.12 : 0.04) : -0.2;
  const correctionBoost = m.kind === "correction" ? 0.15 : 0;
  const staleDays = Math.max(0, (now - Math.max(m.lastUsedAt || 0, m.updatedAt || 0, m.createdAt || 0)) / 86400000);
  const decayBase = SLOW_DECAY.has(m.kind) || m.pinned ? 90 : m.kind === "procedure" || m.kind === "environment" ? 25 : 40;
  const expiry =
    m.ttl && now > m.ttl
      ? 0.35
      : Math.min(0.35, staleDays / decayBase) * (1 - 0.5 * m.usefulness);
  return {
    rel,
    score:
      2.2 * rel +
      0.9 * m.usefulness +
      0.7 * m.confidence +
      scopeBoost +
      sceneBoost +
      correctionBoost -
      expiry,
  };
}

export function formatMemoriesForPrompt(memories: MemoryRecord[]) {
  if (!memories.length) return "";
  const active = memories.filter((m) => m.status === "active" || m.status === "conflict");
  if (!active.length) return "";
  const lines = active.map((m) => {
    const tag = `${KIND_LABEL[m.kind]}·${m.scope === "global" ? m.scene : m.scope}`;
    const flag = m.status === "conflict" ? "⚠冲突 " : "";
    return `- [${tag}] ${flag}${m.claim}`;
  });
  const conflicts = active.filter((m) => m.status === "conflict");
  let extra = "";
  if (conflicts.length) {
    extra =
      "\n冲突待确认：\n" +
      conflicts
        .map((m) => {
          const other = m.links.conflictsWith?.[0];
          return `- ${m.id}: ${m.claim}${other ? ` ↔ ${other}` : ""}`;
        })
        .join("\n");
  }
  return `\n可用记忆（已按当前任务筛选）：\n${lines.join("\n")}${extra}`;
}

export type RecallOptions = {
  scene?: MemoryScene;
  scope?: string;
  now?: number;
  /** tier-1 cap (pinned/preference/correction) */
  alwaysK?: number;
  /** tier-2 cap (relevance-ranked) */
  topK?: number;
  floor?: number;
  /** apply mild lastUsed bump only when rel is high — never large strengthen solely for TopK */
  touchUsed?: boolean;
};

export function recallMemories(
  memories: MemoryRecord[],
  query: string,
  opts: RecallOptions = {},
) {
  const now = opts.now ?? Date.now();
  const floor = opts.floor ?? MEMORY_RELEVANCE_FLOOR;
  const fits = (m: MemoryRecord) =>
    (!opts.scene || m.scene === "any" || m.scene === opts.scene) && (!opts.scope || scopeCompatible(m.scope, opts.scope));
  const rows = memories
    .filter((m) => m.status === "active" || m.status === "conflict")
    .map((m) => ({ m, ...memoryScore(m, query, { scene: opts.scene, scope: opts.scope, now }) }))
    .sort((a, b) => b.score - a.score || b.rel - a.rel);
  const standing = rows
    .filter((row) => isStandingMemory(row.m) && fits(row.m))
    .sort((a, b) => Number(!!b.m.pinned) - Number(!!a.m.pinned))
    .slice(0, opts.alwaysK ?? MEMORY_ALWAYS_K);
  const relevant = rows
    .filter((row) => !standing.includes(row) && row.rel >= floor)
    .slice(0, opts.topK ?? MEMORY_TOP_K);
  const scored = [...standing, ...relevant];
  if (opts.touchUsed) {
    for (const row of scored) {
      if (row.rel >= Math.max(floor + 0.08, 0.22)) {
        row.m.lastUsedAt = now;
        row.m.usedAt = now;
      }
    }
  }
  return scored.map((row) => row.m);
}

export function applyFeedback(
  m: MemoryRecord,
  signal: "success" | "correction" | "unused" | "helpful" | "unhelpful" | "edited",
  now = Date.now(),
) {
  const delta =
    signal === "success"
      ? 0.06
      : signal === "helpful"
        ? 0.12
        : signal === "edited"
          ? 0.08
          : signal === "unused"
            ? -0.02
            : signal === "unhelpful"
              ? -0.12
              : -0.1;
  m.usefulness = clamp01(m.usefulness + delta);
  if (signal === "success" || signal === "helpful" || signal === "edited") {
    m.confidence = clamp01(m.confidence + (signal === "edited" ? 0.1 : 0.03));
    m.lastVerifiedAt = now;
    m.lastUsedAt = now;
    m.usedAt = now;
  } else if (signal === "correction" || signal === "unhelpful") {
    m.confidence = clamp01(m.confidence - 0.08);
  }
  m.updatedAt = now;
  m.strength = Math.max(1, Math.round(1 + m.usefulness * 8));
}

export function pruneMemories(memories: MemoryRecord[], now = Date.now()) {
  let changed = false;
  for (const m of memories) {
    if (m.status === "archived" || m.status === "draft" || m.status === "conflict") continue;
    if (m.pinned || SLOW_DECAY.has(m.kind)) continue;
    const idleDays = (now - Math.max(m.lastUsedAt || 0, m.updatedAt || 0)) / 86400000;
    const score = m.usefulness * m.confidence;
    if (m.ttl && now > m.ttl && score < 0.55) {
      m.status = "archived";
      m.updatedAt = now;
      changed = true;
      continue;
    }
    if (idleDays > 45 && score < ARCHIVE_SCORE) {
      m.status = "archived";
      m.updatedAt = now;
      changed = true;
    }
  }
  const keep: MemoryRecord[] = [];
  for (const m of memories) {
    if (
      m.status === "archived" &&
      !m.pinned &&
      now - m.updatedAt > HARD_DELETE_ARCHIVE_DAYS * 86400000 &&
      m.usefulness * m.confidence < 0.05
    ) {
      changed = true;
      continue;
    }
    keep.push(m);
  }
  const active = keep.filter((m) => m.status === "active");
  if (active.length > ACTIVE_MEMORY_CAP) {
    const victims = active
      .filter((m) => !m.pinned)
      .sort((a, b) => a.usefulness * a.confidence - b.usefulness * b.confidence || a.updatedAt - b.updatedAt);
    const overflow = active.length - ACTIVE_MEMORY_CAP;
    for (let i = 0; i < overflow && i < victims.length; i++) {
      victims[i].status = "archived";
      victims[i].updatedAt = now;
      changed = true;
    }
  }
  return { memories: keep, changed };
}

export type ProposeInput = {
  claim: string;
  kind?: MemoryKind;
  evidence?: string;
  scope?: string;
  scene?: MemoryScene;
  id?: string;
  pinned?: boolean;
  ttl?: number;
  links?: MemoryLinks;
  /** user/ui writes are always active; model writes are active except person_org; extract writes are always draft */
  source?: "user" | "model" | "extract" | "ui";
};

export type ProposeResult =
  | { ok: true; memory: MemoryRecord; action: "created" | "updated" | "merged" | "draft" | "conflict" }
  | { ok: false; code: string; message: string; candidates?: MemoryRecord[] };

function inferKind(claim: string, fallback: MemoryKind = "convention"): MemoryKind {
  if (/(不要|别再|应改为|纠正|以后改|禁止再)/.test(claim)) return "correction";
  if (/(偏好|喜欢|习惯|默认用|请用|希望|尽量)/.test(claim)) return "preference";
  if (/(步骤|先|然后|流程|打开|检查|核对|relay|evaluate)/i.test(claim)) return "procedure";
  if (/(环境|域名|url|host|路径|目录|网关|region|集群)/i.test(claim)) return "environment";
  if (/(对接|负责人|同事|团队|组织)/.test(claim)) return "person_org";
  return fallback;
}

export function proposeMemory(memories: MemoryRecord[], input: ProposeInput, now = Date.now()): ProposeResult {
  const claim = String(input.claim || "").trim();
  const gate = gateMemoryClaim(claim, input.evidence);
  if (!gate.ok) return gate;
  const kind = input.kind && isMemoryKind(input.kind) ? input.kind : inferKind(claim);
  const scene = input.scene && isMemoryScene(input.scene) ? input.scene : "any";
  const scope = String(input.scope || "global").trim() || "global";
  const source = input.source || "model";
  const byUser = source === "user" || source === "ui";
  // Heuristic extraction is only a suggestion; model-written people facts need the user's confirmation.
  const asDraft = source === "extract" || (!byUser && kind === "person_org");

  if (input.id) {
    const existing = memories.find((m) => m.id === input.id);
    if (!existing) return { ok: false, code: "not_found", message: "Memory not found" };
    existing.claim = claim;
    existing.text = claim;
    existing.kind = kind;
    existing.scene = scene;
    existing.scope = scope;
    if (input.evidence !== undefined) existing.evidence = input.evidence;
    if (input.pinned !== undefined) existing.pinned = input.pinned;
    if (input.ttl !== undefined) existing.ttl = input.ttl;
    existing.updatedAt = now;
    existing.confidence = clamp01(existing.confidence + 0.05);
    applyFeedback(existing, "edited", now);
    if (existing.status === "archived" || existing.status === "draft" || (existing.status === "conflict" && byUser))
      existing.status = "active";
    return { ok: true, memory: existing, action: "updated" };
  }

  const neighbors = memories
    .filter((m) => m.status !== "archived" && m.kind === kind && scopeCompatible(m.scope, scope))
    .map((m) => ({ m, sim: similarity(m.claim, claim) }))
    .filter((row) => row.sim >= MEMORY_CONFLICT_SIM)
    .sort((a, b) => b.sim - a.sim);

  const best = neighbors[0];
  if (best && best.sim >= MEMORY_MERGE_SIM && !contradiction(best.m.claim, claim)) {
    const target = best.m;
    if ([...claim].length > [...target.claim].length) target.claim = claim;
    target.text = target.claim;
    target.evidence = [target.evidence, input.evidence].filter(Boolean).join(" · ").slice(0, 500) || target.evidence;
    target.confidence = clamp01(target.confidence + 0.08);
    target.usefulness = clamp01(target.usefulness + 0.04);
    target.updatedAt = now;
    target.lastVerifiedAt = now;
    target.links.mergedFrom = [...new Set([...(target.links.mergedFrom || []), ...(input.links?.mergedFrom || [])])];
    if (target.status === "draft" && byUser) target.status = "active";
    return { ok: true, memory: target, action: "merged" };
  }


  // Broader contradiction scan (even below the merge neighbor cutoff).
  const opposed = memories
    .filter((m) => m.status !== "archived" && m.kind === kind && scopeCompatible(m.scope, scope) && contradiction(m.claim, claim))
    .map((m) => ({ m, sim: similarity(m.claim, claim) }))
    .sort((a, b) => b.sim - a.sim)[0];
  const clash = opposed && opposed.sim >= 0.35 ? opposed.m : undefined;
  if (clash && source !== "extract") {
    const created = normalizeRecord(
      {
        id: id("m"),
        kind,
        claim,
        evidence: input.evidence,
        scope,
        scene,
        confidence: byUser ? 0.7 : 0.45,
        usefulness: 0.35,
        status: "conflict",
        links: { conflictsWith: [clash.id], ...(input.links || {}) },
        pinned: !!input.pinned,
        ttl: input.ttl,
        createdAt: now,
        updatedAt: now,
      },
      now,
    );
    clash.status = "conflict";
    clash.links.conflictsWith = [...new Set([...(clash.links.conflictsWith || []), created.id])];
    clash.updatedAt = now;
    memories.push(created);
    return { ok: true, memory: created, action: "conflict" };
  }

  if (best && best.sim >= MEMORY_MERGE_SIM - 0.04 && !contradiction(best.m.claim, claim)) {
    const target = best.m;
    if ([...claim].length > [...target.claim].length) target.claim = claim;
    target.text = target.claim;
    target.evidence = [target.evidence, input.evidence].filter(Boolean).join(" · ").slice(0, 500) || target.evidence;
    target.confidence = clamp01(target.confidence + 0.05);
    target.usefulness = clamp01(target.usefulness + 0.03);
    target.updatedAt = now;
    target.lastVerifiedAt = now;
    target.links.mergedFrom = [...new Set([...(target.links.mergedFrom || []), ...(input.links?.mergedFrom || [])])];
    if (target.status === "draft" && byUser) target.status = "active";
    return { ok: true, memory: target, action: "merged" };
  }

  const created = normalizeRecord(
    {
      id: id("m"),
      kind,
      claim,
      evidence: input.evidence,
      scope,
      scene,
      confidence: byUser ? 0.75 : asDraft ? 0.4 : 0.55,
      usefulness: byUser ? 0.55 : 0.4,
      status: asDraft ? "draft" : "active",
      // An extracted contradiction stays a draft; confirming it archives the memory it contradicts.
      links: clash ? { conflictsWith: [clash.id], ...(input.links || {}) } : input.links || {},
      pinned: !!input.pinned || kind === "correction" && byUser,
      ttl: input.ttl,
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: byUser ? now : undefined,
    },
    now,
  );
  memories.push(created);
  const pruned = pruneMemories(memories, now);
  memories.splice(0, memories.length, ...pruned.memories);
  return { ok: true, memory: created, action: asDraft ? "draft" : "created" };
}

export type ResolveInput = {
  action: "confirm" | "merge" | "keep" | "drop" | "archive" | "restore" | "feedback";
  id?: string;
  ids?: string[];
  keepId?: string;
  claim?: string;
  signal?: "success" | "correction" | "unused" | "helpful" | "unhelpful" | "edited";
};

export function resolveMemory(memories: MemoryRecord[], input: ResolveInput, now = Date.now()) {
  const find = (key: string) => {
    const m = memories.find((item) => item.id === key);
    assert(m, "Memory not found");
    return m;
  };
  switch (input.action) {
    case "confirm": {
      const m = find(input.id!);
      assert(m.status === "draft" || m.status === "conflict", "Only draft/conflict can confirm");
      if (input.claim) {
        const gate = gateMemoryClaim(input.claim);
        assert(gate.ok, gate.ok === false ? gate.message : "invalid");
        m.claim = input.claim.trim();
        m.text = m.claim;
      }
      m.status = "active";
      m.confidence = clamp01(m.confidence + 0.15);
      m.updatedAt = now;
      m.lastVerifiedAt = now;
      if (m.links.conflictsWith?.length) {
        for (const otherId of m.links.conflictsWith) {
          const other = memories.find((item) => item.id === otherId);
          if (!other) continue;
          other.status = "archived";
          other.updatedAt = now;
          other.links.conflictsWith = (other.links.conflictsWith || []).filter((x) => x !== m.id);
        }
        m.links.conflictsWith = [];
      }
      return { ok: true, memory: m };
    }
    case "merge": {
      const ids = input.ids?.length ? input.ids : input.id ? [input.id] : [];
      assert(ids.length >= 2, "merge needs at least two ids");
      const rows = ids.map(find);
      const keep = input.keepId ? find(input.keepId) : rows.sort((a, b) => b.usefulness * b.confidence - a.usefulness * a.confidence)[0];
      for (const row of rows) {
        if (row.id === keep.id) continue;
        keep.links.mergedFrom = [...new Set([...(keep.links.mergedFrom || []), row.id, ...(row.links.mergedFrom || [])])];
        if ([...row.claim].length > [...keep.claim].length) keep.claim = row.claim;
        keep.evidence = [keep.evidence, row.evidence].filter(Boolean).join(" · ").slice(0, 500) || keep.evidence;
        keep.usefulness = clamp01((keep.usefulness + row.usefulness) / 2 + 0.05);
        keep.confidence = clamp01(Math.max(keep.confidence, row.confidence) + 0.05);
        row.status = "archived";
        row.updatedAt = now;
      }
      keep.text = keep.claim;
      keep.status = "active";
      keep.updatedAt = now;
      keep.lastVerifiedAt = now;
      return { ok: true, memory: keep };
    }
    case "keep": {
      const m = find(input.id!);
      m.status = "active";
      m.pinned = true;
      m.updatedAt = now;
      return { ok: true, memory: m };
    }
    case "drop": {
      const m = find(input.id!);
      const idx = memories.findIndex((item) => item.id === m.id);
      memories.splice(idx, 1);
      for (const other of memories) {
        if (other.links.conflictsWith?.includes(m.id))
          other.links.conflictsWith = other.links.conflictsWith.filter((x) => x !== m.id);
        if (other.status === "conflict" && !other.links.conflictsWith?.length) other.status = "active";
      }
      return { ok: true, removed: m.id };
    }
    case "archive": {
      const m = find(input.id!);
      m.status = "archived";
      m.updatedAt = now;
      return { ok: true, memory: m };
    }
    case "restore": {
      const m = find(input.id!);
      m.status = "active";
      m.updatedAt = now;
      pruneMemories(memories, now);
      return { ok: true, memory: m };
    }
    case "feedback": {
      const m = find(input.id!);
      assert(input.signal, "feedback signal required");
      applyFeedback(m, input.signal, now);
      if (input.signal === "correction") {
        const created = proposeMemory(
          memories,
          {
            claim: input.claim || `纠正：不再沿用「${m.claim}」`,
            kind: "correction",
            scope: m.scope,
            scene: m.scene,
            source: "user",
            evidence: `针对 ${m.id}`,
          },
          now,
        );
        return { ok: true, memory: m, correction: created.ok ? created.memory : undefined };
      }
      return { ok: true, memory: m };
    }
    default:
      throw Error("Unknown memory resolve action");
  }
}

export function pinMemory(memories: MemoryRecord[], memoryId: string, pinned = true, now = Date.now()) {
  const m = memories.find((item) => item.id === memoryId);
  assert(m, "Memory not found");
  m.pinned = pinned;
  if (pinned && m.status === "archived") m.status = "active";
  m.updatedAt = now;
  return m;
}

export function forgetMemory(memories: MemoryRecord[], memoryId: string) {
  const idx = memories.findIndex((item) => item.id === memoryId);
  assert(idx >= 0, "Memory not found");
  const [removed] = memories.splice(idx, 1);
  for (const other of memories) {
    if (other.links.conflictsWith?.includes(memoryId))
      other.links.conflictsWith = other.links.conflictsWith.filter((x) => x !== memoryId);
  }
  return removed;
}

export function searchMemories(
  memories: MemoryRecord[],
  query: string,
  opts: { status?: MemoryStatus | "pending" | "all"; scene?: MemoryScene; limit?: number; now?: number } = {},
) {
  const now = opts.now ?? Date.now();
  let pool = memories;
  if (opts.status === "pending") pool = memories.filter((m) => m.status === "draft" || m.status === "conflict");
  else if (opts.status && opts.status !== "all") pool = memories.filter((m) => m.status === opts.status);
  if (!query.trim()) {
    return [...pool]
      .sort((a, b) => b.usefulness * b.confidence - a.usefulness * a.confidence || (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
      .slice(0, opts.limit ?? 30);
  }
  const qn = normalizeClaim(query);
  return pool
    .map((m) => ({ m, ...memoryScore(m, query, { scene: opts.scene, now }) }))
    .filter((row) => row.rel >= 0.05 || normalizeClaim(row.m.claim).includes(qn))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 30)
    .map((row) => row.m);
}

/** Heuristic 0–3 draft candidates from task delivery text; they only take effect once the user confirms. Never emits OTP/secrets (gate). */
export function extractMemoryCandidates(input: {
  summary?: string;
  result?: string;
  taskText?: string;
  cwd?: string;
  scene?: MemoryScene;
}) {
  const blob = [input.summary, input.result].filter(Boolean).join("\n");
  if (!blob.trim()) return [] as ProposeInput[];
  const sentences = blob
    .split(/[\n。；;]+/)
    .map((s) => s.replace(/^[\s\-*>#\d.]+/, "").trim())
    .filter((s) => [...s].length >= 8 && [...s].length <= MEMORY_CLAIM_MAX);
  const scored: { claim: string; kind: MemoryKind; weight: number }[] = [];
  for (const s of sentences) {
    let kind: MemoryKind | undefined;
    let weight = 0;
    // Only explicit rule wording: "默认/希望/必须" also describe one-off actions ("默认使用了第一页结果").
    if (/(偏好|请用|习惯|尽量使用)/.test(s)) {
      kind = "preference";
      weight = 3;
    } else if (/(约定|统一(?:使用|用|走|采用)|固定使用|一律|规范)/.test(s)) {
      kind = "convention";
      weight = 3;
    } else if (/(流程|步骤|先.*再|打开.*核对|evaluate|relay)/i.test(s)) {
      kind = "procedure";
      weight = 2;
    } else if (/(环境|域名|网关|region|目录|路径|host)/i.test(s)) {
      kind = "environment";
      weight = 2;
    } else if (/(不要|别再|应改为|纠正)/.test(s)) {
      kind = "correction";
      weight = 3;
    }
    if (!kind) continue;
    if (gateMemoryClaim(s).ok) scored.push({ claim: s, kind, weight });
  }
  scored.sort((a, b) => b.weight - a.weight || a.claim.length - b.claim.length);
  const uniq: ProposeInput[] = [];
  for (const row of scored) {
    if (uniq.some((u) => similarity(u.claim!, row.claim) >= 0.7)) continue;
    uniq.push({
      claim: row.claim,
      kind: row.kind,
      scope: input.cwd || "global",
      scene: input.scene || "any",
      source: "extract",
      evidence: "任务交付自动提炼",
    });
    if (uniq.length >= 3) break;
  }
  return uniq;
}

export function exportMemoriesMarkdown(memories: MemoryRecord[]) {
  const groups: Record<string, MemoryRecord[]> = {};
  for (const m of memories) {
    const key = m.status;
    (groups[key] ||= []).push(m);
  }
  const parts = ["# 数字牛马记忆导出", ""];
  for (const status of ["active", "draft", "conflict", "archived"]) {
    const rows = groups[status];
    if (!rows?.length) continue;
    parts.push(`## ${status}`, "");
    for (const m of rows) {
      parts.push(`- **${KIND_LABEL[m.kind]}** (${m.scene}/${m.scope}) \`${m.id}\`: ${m.claim}`);
      if (m.evidence) parts.push(`  - 证据：${m.evidence}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

/** Back-compat wrappers used by older call sites / tests during cutover. */
export function retention(m: Obj, now = Date.now()) {
  const rec = migrateMemory(m, now);
  if (rec.pinned || rec.kind === "preference" || rec.kind === "correction") return 1;
  const idle = Math.max(0, now - Math.max(rec.lastUsedAt || 0, rec.updatedAt, rec.createdAt)) / 86400000;
  const base = 5 * (0.5 + rec.usefulness) * (0.5 + rec.confidence);
  return Math.exp(-idle / Math.max(1, base));
}

export function recallMemory(
  state: { memories: any[] },
  task: string,
  now = Date.now(),
  reinforce = true,
) {
  const migrated = migrateMemories(state.memories, now);
  state.memories = migrated.memories;
  const pruned = pruneMemories(state.memories as MemoryRecord[], now);
  state.memories = pruned.memories;
  const hit = recallMemories(state.memories as MemoryRecord[], task, {
    now,
    touchUsed: reinforce,
  });
  if (reinforce) {
    for (const m of hit) {
      const rel = relevance(task, m.claim);
      if (rel >= 0.22) applyFeedback(m, "success", now);
      else if (rel >= MEMORY_RELEVANCE_FLOOR) applyFeedback(m, "unused", now);
    }
  }
  return hit;
}
