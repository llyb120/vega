// A phase is a view of existing, permission-filtered transcript rows, not another session.
const scenes = new Map([["code_agent", "coding"], ["browser_agent", "computer"]]);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
export function agentPhases(messages) {
  const phases = new Map(), pending = new Map();
  let legacy;
  const phaseFor = (seq, name) => {
    if (!phases.has(seq)) phases.set(seq, { seq, name, status: "unconfirmed", rows: [] });
    return phases.get(seq);
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i], call = m.role === "assistant" && m.calls?.length === 1 && m.calls[0];
    let p = m.agentPhase && phaseFor(m.agentPhase.seq, m.agentPhase.name);
    const root = !p && call && scenes.has(call.name) && (!m.toolScene || m.toolScene === "lightweight");
    if (root) {
      legacy = undefined;
      p = phaseFor(m.seq, call.name);
      p.callId = call.id;
      p.task = call.arguments?.task;
    } else if (m.role === "tool") {
      p ||= pending.get(m.callId);
      pending.delete(m.callId);
    } else if (!p && legacy) {
      // Old records: only accept a matching tool scene, or a reply followed by the runtime return receipt.
      if (m.toolScene === scenes.get(legacy.name) || (m.role === "assistant" && messages[i + 1]?.role === "user" && messages[i + 1]?.text?.startsWith("[Runtime: scene result is completed data,"))) p = legacy;
      else if (m.role === "user" && m.text?.startsWith("[Runtime: scene result is completed data,")) {
        legacy.status = "returned";
        legacy = undefined;
      } else legacy = undefined;
    }
    if (!p) continue;
    p.rows.push(m);
    for (const c of m.calls || []) pending.set(c.id, p);
    if (m.phaseReturned) p.status = "returned";
    if (m.role === "tool" && m.name === p.name && (!p.callId || m.callId === p.callId)) {
      const receipt = parse(m.text);
      p.executor = receipt?.executor;
      if (typeof receipt?.phaseSession === "string") p.phaseSession = receipt.phaseSession;
      if (receipt?.evidence && typeof receipt.evidence === "object") p.evidence = receipt.evidence;
      if (typeof receipt?.result === 'string') p.resultSeq = m.seq;
      if (m.error) p.status = receipt?.status === "queued" ? "queued" : "error";
      else if (receipt?.status === "blocked") p.status = "blocked";
      else if (receipt?.status === "interrupted_by_steer") p.status = "interrupted";
      else if (receipt?.executor) p.status = "returned";
      else if (!m.agentPhase && receipt?.scene === scenes.get(p.name)) legacy = p;
    }
  }
  return [...phases.values()];
}

export function phaseIndex(messages) {
  return agentPhases(messages).map(({ rows, ...phase }) => ({ ...phase, messageSeqs: rows.map(m => m.seq) }));
}
