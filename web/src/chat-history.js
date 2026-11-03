// Windowed employee chat history: cached messages render first, then stream events append server deltas.
export const CHAT_PAGE_SIZE = 60;

/** Merge two seq-sorted message lists, preferring the incoming copy of any duplicate. */
export function mergeMessages(current, incoming) {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * @param {{ api: Function, path: () => string, messages: {value:any[]}, running: {value:boolean}, hasMore: {value:boolean}, pageSize?: number, cache?: any }} options
 */
export function createChatHistory({ api, path, messages, running, hasMore, pageSize = CHAT_PAGE_SIZE, cache }) {
  let session = "", stream = 0, queue = Promise.resolve(), generation = 0, disposed = false;
  const enqueue = (job) => { const next = queue.then(job, job); queue = next.catch(() => {}); return next; };
  const lastSeq = () => messages.value.at(-1)?.seq ?? 0;
  const valid = (current) => !disposed && current === generation && (!cache || cache.valid());
  const contiguous = (rows) => rows.every((row, i) => i === 0 || row.seq === rows[i - 1].seq + 1);
  function reset() { session = ""; messages.value = []; hasMore.value = false; running.value = false; }
  async function request(url, current) {
    try { return await api(url); }
    catch (error) {
      if (valid(current) && [401, 403, 404].includes(error.status)) {
        reset(); generation++;
        void cache?.clear();
      }
      throw error;
    }
  }
  function changed(result) {
    return (result.session?.id && result.session.id !== session) || (Number.isSafeInteger(result.lastSeq) && result.lastSeq < lastSeq());
  }
  async function replaceHistory(result) {
    reset();
    void cache?.put(result.session?.id, [], true);
    return fetchLatest();
  }
  async function fetchLatest() {
    const version = stream, current = generation;
    if (!valid(current)) return [];
    const result = await request(`${path()}?limit=${pageSize}`, current);
    if (!valid(current)) return [];
    session = result.session?.id || "";
    messages.value = result.messages;
    hasMore.value = !!result.hasMore;
    if (version === stream) running.value = !!result.running;
    void cache?.put(session, result.messages, true);
    return result.messages;
  }
  /** Fetch messages after the newest confirmed seq; apply merges replies and typing state in the same tick. */
  async function fetchNewer(apply, syncRunning = true) {
    if (!session) { const added = await fetchLatest(); apply?.(added); return added; }
    const version = stream, current = generation;
    if (!valid(current)) return [];
    const result = await request(`${path()}?after=${lastSeq()}`, current);
    if (!valid(current)) return [];
    if (changed(result)) { const added = await replaceHistory(result); apply?.(added); return added; }
    const known = new Set(messages.value.map((message) => message.seq));
    const added = result.messages.filter((message) => !known.has(message.seq));
    messages.value = mergeMessages(messages.value, result.messages);
    if (version === stream && !apply && syncRunning) running.value = !!result.running;
    void cache?.put(session, result.messages);
    apply?.(added);
    return added;
  }
  async function fetchOlder() {
    const first = messages.value[0]?.seq, current = generation;
    if (!hasMore.value || !first || !valid(current)) return [];
    const saved = await cache?.read(first, pageSize);
    if (!valid(current)) return [];
    if (saved?.session === session && saved.messages.at(-1)?.seq === first - 1 && contiguous(saved.messages)) {
      messages.value = mergeMessages(saved.messages, messages.value);
      hasMore.value = saved.messages[0].seq > 1;
      return saved.messages;
    }
    const result = await request(`${path()}?before=${first}&limit=${pageSize}`, current);
    if (!valid(current) || messages.value[0]?.seq !== first) return [];
    if (changed(result)) return replaceHistory(result);
    messages.value = mergeMessages(result.messages, messages.value);
    hasMore.value = !!result.hasMore;
    void cache?.put(session, result.messages);
    return result.messages;
  }
  return {
    lastSeq,
    touch() { stream++; return stream; },
    get stream() { return stream; },
    load(onCached) {
      const current = ++generation;
      session = "";
      return enqueue(async () => {
        if (!valid(current)) return [];
        const saved = await cache?.read(undefined, pageSize);
        if (!valid(current)) return [];
        if (saved?.messages.length && contiguous(saved.messages)) {
          session = saved.session;
          messages.value = saved.messages;
          hasMore.value = saved.messages[0].seq > 1;
          await onCached?.();
          if (!valid(current)) return [];
          return fetchNewer();
        }
        return fetchLatest();
      });
    },
    /** syncRunning: false for stream-driven fetches: only done (via apply) may end typing. */
    newer: (apply, syncRunning) => enqueue(() => fetchNewer(apply, syncRunning)),
    older: () => enqueue(fetchOlder),
    dispose() { disposed = true; generation++; },
  };
}
