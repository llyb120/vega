export type TaskEdgeKind = "follow_up" | "retry" | "fork" | "subtask";

export type TaskChainFields = {
  chainId?: string;
  parentId?: string;
  edgeKind?: TaskEdgeKind;
  retryOf?: string;
  chainSeq?: number;
  branchLabel?: string;
};

export type ChainTaskLike = TaskChainFields & {
  id: string;
  text?: string;
  status: string;
  createdAt?: number;
  finishedAt?: number;
};

export type ChainNode<T extends ChainTaskLike = ChainTaskLike> = {
  id: string;
  task?: T;
  missing?: boolean;
  depth: number;
  parentId?: string;
  isLast: boolean;
  guides: boolean[];
  hasBranch: boolean;
  edgeKind?: TaskEdgeKind;
  retryOfSeq?: number;
};

export type TaskListGroup<T extends ChainTaskLike = ChainTaskLike> =
  | { kind: "single"; task: T }
  | {
      kind: "chain";
      chainId: string;
      headTask: T;
      nodes: ChainNode<T>[];
      count: number;
      branchCount: number;
      branched: boolean;
      hasActive: boolean;
      hasAttention: boolean;
    };

const ENDED_STATUSES = new Set(["done", "failed", "cancelled", "stopped", "sealed"]);
const ATTENTION_STATUSES = new Set(["waiting", "approval"]);
const ACTIVE_STATUSES = new Set(["running", "recovering", "queued", "deferred", "waiting", "approval"]);

const EDGE_LABELS: Record<TaskEdgeKind, string> = {
  follow_up: "后续",
  retry: "重做",
  fork: "分支",
  subtask: "子任务",
};

/** Human-readable Chinese label for a task chain edge relation. */
export function chainEdgeLabel(kind?: TaskEdgeKind): string {
  return kind ? EDGE_LABELS[kind] || kind : "";
}

/** Deterministic order of tasks inside a chain: chainSeq ascending, then createdAt ascending. */
export function sortChainTasks<T extends ChainTaskLike>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const seqA = typeof a.chainSeq === "number" ? a.chainSeq : Number.MAX_SAFE_INTEGER;
    const seqB = typeof b.chainSeq === "number" ? b.chainSeq : Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/** Return all tasks belonging to a chainId, sorted in chain order. */
export function chainTasks<T extends ChainTaskLike>(tasks: readonly T[], chainId?: string): T[] {
  if (!chainId) return [];
  return sortChainTasks(tasks.filter((task) => task.chainId === chainId));
}

/** Walk parentId upward from taskId, returning [root, ..., parent] with cycle protection. */
export function chainAncestors<T extends ChainTaskLike>(tasks: readonly T[], taskId: string): T[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const out: T[] = [];
  const visited = new Set<string>([taskId]);
  let current = byId.get(taskId);
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    out.unshift(parent);
    current = parent;
  }
  return out;
}

/** Whether a flattened chain has branches (multiple roots or any node with >1 children). */
export function isBranchedChain<T extends ChainTaskLike>(nodes: readonly ChainNode<T>[]): boolean {
  let rootCount = 0;
  const childCount = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parentId) rootCount++;
    else childCount.set(node.parentId, (childCount.get(node.parentId) || 0) + 1);
  }
  if (rootCount > 1) return true;
  for (const count of childCount.values()) if (count > 1) return true;
  return false;
}

/** Flatten a chain's tasks into a rooted forest in DFS order for non-recursive tree rendering. */
export function flattenChainTree<T extends ChainTaskLike>(tasksInChain: readonly T[]): ChainNode<T>[] {
  const ordered = sortChainTasks(tasksInChain);
  if (!ordered.length) return [];
  const byId = new Map<string, T>();
  for (const task of ordered) byId.set(task.id, task);

  // Collect missing intermediate parents as placeholder entries so sibling branches remain grouped.
  const placeholders = new Map<string, { id: string; order: number }>();
  for (let i = 0; i < ordered.length; i++) {
    const pid = ordered[i].parentId;
    if (pid && !byId.has(pid) && !placeholders.has(pid)) {
      placeholders.set(pid, { id: pid, order: i });
    }
  }

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  const addChild = (parentKey: string, childId: string) => {
    const list = childrenOf.get(parentKey);
    if (list) list.push(childId);
    else childrenOf.set(parentKey, [childId]);
  };

  for (const pid of placeholders.keys()) roots.push(pid);
  for (const task of ordered) {
    if (task.parentId && task.parentId !== task.id && (byId.has(task.parentId) || placeholders.has(task.parentId))) {
      addChild(task.parentId, task.id);
    } else {
      roots.push(task.id);
    }
  }

  const out: ChainNode<T>[] = [];
  const visited = new Set<string>();

  const visit = (nodeId: string, depth: number, parentId: string | undefined, isLast: boolean, guides: boolean[]) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const task = byId.get(nodeId);
    const kids = (childrenOf.get(nodeId) || []).filter((cid) => !visited.has(cid));
    const retryTarget = task?.retryOf ? byId.get(task.retryOf) : undefined;
    out.push({
      id: nodeId,
      task,
      missing: !task,
      depth,
      parentId,
      isLast,
      guides,
      hasBranch: kids.length > 1,
      edgeKind: task?.edgeKind,
      retryOfSeq: typeof retryTarget?.chainSeq === "number" ? retryTarget.chainSeq : undefined,
    });
    const nextGuides = depth === 0 ? guides : [...guides, !isLast];
    for (let i = 0; i < kids.length; i++) {
      visit(kids[i], depth + 1, nodeId, i === kids.length - 1, nextGuides);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    visit(roots[i], 0, undefined, i === roots.length - 1, []);
  }
  // Safety pass in case of disconnected cycles in malformed historical data.
  for (const task of ordered) {
    if (!visited.has(task.id)) visit(task.id, 0, undefined, true, []);
  }
  return out;
}

function pickHeadTask<T extends ChainTaskLike>(visibleMembers: readonly T[], allMembers: readonly T[]): T {
  const rank = (t: T) =>
    ATTENTION_STATUSES.has(t.status) ? 0
    : t.status === "running" || t.status === "recovering" ? 1
    : ACTIVE_STATUSES.has(t.status) ? 2
    : t.status === "done" ? 3
    : 4;
  const pool = visibleMembers.length ? visibleMembers : allMembers;
  return [...pool].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const seqA = typeof a.chainSeq === "number" ? a.chainSeq : 0;
    const seqB = typeof b.chainSeq === "number" ? b.chainSeq : 0;
    if (seqA !== seqB) return seqB - seqA;
    return (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0);
  })[0]!;
}

/** Group visible tasks by chainId while showing full chain context from allTasks. */
export function groupTasksByChain<T extends ChainTaskLike>(visibleTasks: readonly T[], allTasks: readonly T[]): TaskListGroup<T>[] {
  const byChainAll = new Map<string, T[]>();
  const byChainVisible = new Map<string, T[]>();
  for (const task of allTasks) {
    if (!task.chainId) continue;
    const list = byChainAll.get(task.chainId);
    if (list) list.push(task);
    else byChainAll.set(task.chainId, [task]);
  }
  for (const task of visibleTasks) {
    if (!task.chainId) continue;
    const list = byChainVisible.get(task.chainId);
    if (list) list.push(task);
    else byChainVisible.set(task.chainId, [task]);
  }

  const emittedChains = new Set<string>();
  const groups: TaskListGroup<T>[] = [];
  for (const task of visibleTasks) {
    if (!task.chainId) {
      groups.push({ kind: "single", task });
      continue;
    }
    const members = byChainAll.get(task.chainId) || [task];
    if (members.length <= 1) {
      groups.push({ kind: "single", task });
      continue;
    }
    if (emittedChains.has(task.chainId)) continue;
    emittedChains.add(task.chainId);
    const nodes = flattenChainTree(members);
    const branched = isBranchedChain(nodes);
    const parentIds = new Set(nodes.map((n) => n.parentId).filter(Boolean));
    const leafCount = nodes.filter((n) => !n.missing && !parentIds.has(n.id)).length;
    groups.push({
      kind: "chain",
      chainId: task.chainId,
      headTask: pickHeadTask(byChainVisible.get(task.chainId) || [], members),
      nodes,
      count: members.length,
      branchCount: Math.max(1, leafCount),
      branched,
      hasActive: members.some((m) => !ENDED_STATUSES.has(m.status)),
      hasAttention: members.some((m) => ATTENTION_STATUSES.has(m.status)),
    });
  }
  return groups;
}
