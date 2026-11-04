/** /new: start a new model context (the 沟通会话, or a group's 旁白 and member sessions); the visible history stays. */
export const NEW_SESSION_NOTICE = "已开启新会话，之前的对话不再作为上下文";
/** "/new" alone or "/new <text>" (the text is then handled in the new context); anything else is an ordinary message. */
export function newCommand(text: unknown): { rest: string } | undefined {
  const match = typeof text === "string" ? /^\s*\/new(?:\s+([\s\S]*))?$/.exec(text) : null;
  return match ? { rest: (match[1] || "").trim() } : undefined;
}
