export type ChatAuthor = { kind: "user" | "employee"; id: string; name: string };
export type ChatQuote = { seq: number; role: string; text: string; author?: ChatAuthor; taskId?: string };
export type ChatTaskRef = {
  id: string;
  title: string;
  status?: string;
  chainId?: string;
  chainSeq?: number;
  employeeId?: string;
  intent?: "follow_up" | "retry" | "fork";
};

type QuoteSource = {
  seq?: number;
  role: string;
  text?: string;
  displayText?: string;
  author?: ChatAuthor;
  notice?: boolean;
  images?: readonly unknown[];
  files?: readonly { name: string }[];
  tasks?: readonly { id: string; title: string }[];
  stepOutput?: boolean | { label: string };
};

export function quoteOf(message: QuoteSource): ChatQuote | undefined {
  const { seq, role, author, tasks } = message;
  if (!seq || !Number.isSafeInteger(seq) || seq < 1 || message.notice || (role !== "user" && role !== "assistant")) return;
  const text = (message.displayText || message.text || "").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim()
    || [message.images?.length ? "[图片]" : "", message.files?.length ? message.files.map((file) => file.name).join("、") : ""].filter(Boolean).join(" ")
    || (typeof message.stepOutput === "object" && message.stepOutput.label) || tasks?.[0]?.title;
  if (!text) return;
  return {
    seq, role, text: text.length > 160 ? text.slice(0, 160) + "…" : text,
    ...(author ? { author: { kind: author.kind, id: author.id, name: author.name } } : {}),
    taskId: tasks?.length === 1 ? tasks[0].id : undefined,
  };
}
