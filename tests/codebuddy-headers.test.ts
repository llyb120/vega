import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { codebuddyRequestHeaders } from "../server/core/provider";

test("CodeBuddy headers share a fresh message id and omit Conversation-ID when there is no session", () => {
  const headers = codebuddyRequestHeaders();
  assert.equal(headers["X-Request-ID"], headers["X-Conversation-Message-ID"]);
  assert.match(headers["X-Request-ID"], /^[0-9a-f]{32}$/);
  assert.equal(headers["X-Agent-Type"], "main");
  assert.equal(headers["X-Conversation-ID"], undefined);
  assert.equal(headers["X-Session-ID"], undefined);
  assert.equal(headers["X-Conversation-Request-ID"], undefined);
  assert.equal(headers["X-Root-Request-ID"], undefined);
});

test("CodeBuddy session headers are stable and turn-level ids are the first 32 hex chars of sha256(session)", () => {
  const session = "sess-stable-key";
  const a = codebuddyRequestHeaders(session);
  const b = codebuddyRequestHeaders(session);
  const digest = createHash("sha256").update(session).digest("hex").slice(0, 32);
  assert.equal(a["X-Conversation-ID"], session);
  assert.equal(a["X-Session-ID"], session);
  assert.equal(a["X-Conversation-Request-ID"], digest);
  assert.equal(a["X-Root-Request-ID"], digest);
  assert.equal(b["X-Conversation-ID"], session);
  assert.equal(b["X-Conversation-Request-ID"], digest);
  assert.notEqual(a["X-Request-ID"], b["X-Request-ID"], "message ids are fresh each request");
  assert.equal(a["X-Request-ID"], a["X-Conversation-Message-ID"]);
});
