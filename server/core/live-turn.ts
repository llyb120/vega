export type LiveTool = { id: string; name: string; status: "running" | "done" | "error" };
export type LiveTurn = {
  /** When this turn's stream started. Stable so the client can update one bubble. */
  at: number;
  text: string;
  thinking: string;
  /** Latest tool_progress line. Arguments are never copied here. */
  progress: string;
  tools: LiveTool[];
};

const TEXT_LIMIT = 32000;
const THINKING_LIMIT = 8000;
const PROGRESS_LIMIT = 500;

const clip = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join("") : value;
};

/**
 * In-memory partial turn for the session the engine is already streaming.
 * Device tokens cannot open the cookie event stream, so the chat history
 * response reads this snapshot. message_end drops text that is now stored;
 * done/error drops the turn so a later poll cannot duplicate it.
 */
export class LiveTurns {
  private rows = new Map<string, LiveTurn>();
  ingest(event: { type: string; session?: string; data?: any }) {
    const session = event.session;
    if (!session) return;
    if (event.type === "done" || event.type === "error") {
      this.rows.delete(session);
      return;
    }
    const row = this.rows.get(session) || { at: Date.now(), text: "", thinking: "", progress: "", tools: [] };
    switch (event.type) {
      case "message_start":
        this.rows.set(session, { at: Date.now(), text: "", thinking: "", progress: "", tools: [] });
        return;
      case "text_delta":
        row.text = clip(row.text + String(event.data || ""), TEXT_LIMIT);
        break;
      case "thinking_delta":
        row.thinking = clip(row.thinking + String(event.data || ""), THINKING_LIMIT);
        break;
      case "tool_progress":
        row.progress = clip(String(event.data || ""), PROGRESS_LIMIT);
        break;
      case "tool_start": {
        const name = String(event.data?.name || "tool");
        const id = String(event.data?.id || name);
        row.tools = [...row.tools.filter((tool) => tool.id !== id), { id, name, status: "running" }];
        break;
      }
      case "tool_end": {
        const id = String(event.data?.call?.id || "");
        const status = event.data?.outcome?.error ? "error" : "done";
        row.tools = row.tools.map((tool) => (tool.id === id ? { ...tool, status } : tool));
        row.progress = "";
        break;
      }
      case "message_end":
        row.text = "";
        row.thinking = "";
        break;
      default:
        return;
    }
    this.rows.set(session, row);
    if (this.rows.size > 32) this.rows.delete(this.rows.keys().next().value!);
  }
  snapshot(session: string): LiveTurn | null {
    const row = this.rows.get(session);
    if (!row || (!row.text && !row.thinking && !row.progress && !row.tools.length)) return null;
    return {
      at: row.at,
      text: row.text,
      thinking: row.thinking,
      progress: row.progress,
      tools: row.tools.map((tool) => ({ ...tool })),
    };
  }
}
