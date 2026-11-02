// Windowed employee chat history: the newest page loads first, older pages are prepended on demand,
// and stream events only fetch messages after the last known sequence instead of the whole history.
export const CHAT_PAGE_SIZE = 60;

/** Merge two seq-sorted message lists, preferring the incoming copy of any duplicate. */
export function mergeMessages(current, incoming) {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * @param {{ api: Function, path: () => string, messages: {value:any[]}, running: {value:boolean}, hasMore: {value:boolean}, pageSize?: number }} options
 */
export function createChatHistory({ api, path, messages, running, hasMore, pageSize = CHAT_PAGE_SIZE }) {
  let session = "", stream = 0, queue = Promise.resolve(), generation = 0;
  const enqueue = (job) => { const next = queue.then(job, job); queue = next.catch(() => {}); return next; };
  const lastSeq = () => messages.value.at(-1)?.seq ?? 0;

  async function fetchLatest() {
    const version = stream, current = generation;
    const result = await api(`${path()}?limit=${pageSize}`);
    if (current !== generation) return [];
    session = result.session?.id || "";
    messages.value = result.messages;
    hasMore.value = !!result.hasMore;
    if (version === stream) running.value = !!result.running;
    return result.messages;
  }
  /** Fetch messages newer than what we hold. `apply` runs in the same tick as the merge (no intermediate render). */
  async function fetchNewer(apply, syncRunning = true) {
    if (!session) { const added = await fetchLatest(); apply?.(added); return added; }
    const version = stream, current = generation;
    const result = await api(`${path()}?after=${lastSeq()}`);
    if (current !== generation) return [];
    if (result.session?.id && result.session.id !== session) { generation++; const added = await fetchLatest(); apply?.(added); return added; }
    const known = new Set(messages.value.map((message) => message.seq));
    const added = result.messages.filter((message) => !known.has(message.seq));
    messages.value = mergeMessages(messages.value, result.messages);
    if (version === stream && !apply && syncRunning) running.value = !!result.running;
    apply?.(added);
    return added;
  }
  async function fetchOlder() {
    const first = messages.value[0]?.seq;
    if (!hasMore.value || !first) return [];
    const current = generation;
    const result = await api(`${path()}?before=${first}&limit=${pageSize}`);
    if (current !== generation || messages.value[0]?.seq !== first) return [];
    messages.value = mergeMessages(result.messages, messages.value);
    hasMore.value = !!result.hasMore;
    return result.messages;
  }
  return {
    lastSeq,
    /** Any stream event makes in-flight snapshots of `running` stale. */
    touch() { stream++; return stream; },
    get stream() { return stream; },
    load: () => { generation++; session = ""; return enqueue(fetchLatest); },
    /** `syncRunning: false` for stream-driven fetches: only `done` (via `apply`) may end the typing state. */
    newer: (apply, syncRunning) => enqueue(() => fetchNewer(apply, syncRunning)),
    older: () => enqueue(fetchOlder),
  };
}
