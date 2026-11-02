import { check } from "./auth";
import type { Store } from "./store";

export const CHAT_PAGE_MAX = 500;

function seqParam(query: URLSearchParams, name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (!query.has(name)) return undefined;
  const raw = query.get(name)!, value = Number(raw);
  check(/^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= min && value <= max, 400, `Invalid ${name}`);
  return value;
}

/**
 * Optional, backward-compatible pagination for an employee chat.
 * Without parameters the full history is returned exactly as before.
 * `limit` (1–500) with optional `before` returns the newest messages older than `before`;
 * `after` returns every message newer than `after` (used to append after stream events).
 */
export function chatHistory(store: Store, session: string, query: URLSearchParams) {
  const limit = seqParam(query, "limit", 1, CHAT_PAGE_MAX), before = seqParam(query, "before", 1), after = seqParam(query, "after", 0);
  if (limit === undefined && before === undefined && after === undefined) return { messages: store.messages(session) };
  check(after === undefined || (before === undefined && limit === undefined), 400, "after cannot be combined with before or limit");
  return store.messagePage(session, { before, after, limit: limit ?? 100 });
}
