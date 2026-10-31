export function groupTurns(messages) {
  const turns = [];
  let current;
  for (const message of messages) {
    if (message.role === "user" || !current) {
      current = { user: null, body: [] };
      turns.push(current);
    }
    if (message.role === "user") current.user = message;
    else current.body.push(message);
  }
  return turns.map((turn) => {
    let conclusion = -1;
    for (let i = turn.body.length - 1; i >= 0; i--) {
      if (turn.body[i].role !== "assistant" || !turn.body[i].text?.trim()) break;
      conclusion = i;
    }
    return {
      ...turn,
      process: conclusion < 0 ? turn.body : turn.body.slice(0, conclusion),
      conclusion: conclusion < 0 ? [] : turn.body.slice(conclusion),
    };
  });
}

export function timelineOf(messages) {
  const groups = [];
  let previousRole = "";
  for (const m of messages) {
    const last = groups.at(-1);
    if (m.role === "tool") {
      if (last?.kind === "tools") last.items.push(m);
      else
        groups.push({
          kind: "tools",
          key: `tools-${m.seq ?? groups.length}`,
          items: [m],
        });
    } else {
      groups.push({
        kind: "message",
        key: `${m.role}-${m.seq ?? groups.length}`,
        message: m,
        continuation: m.role === "assistant" && previousRole === "assistant",
      });
      previousRole = m.role;
    }
  }
  return groups;
}
