type Obj = Record<string, any>;

/**
 * Some models (notably GPT-family) fill every optional schema field with a placeholder default:
 * "" strings, [] arrays, 0 numbers, {x:0,y:0,...} objects, false/true booleans and the first enum value.
 * The backend must treat those as "not provided" instead of validating them as real intent.
 */
const EMPLOYEE_FIELDS: Record<string, string[]> = {
  list: [],
  add: ["kind", "key", "text", "note", "profile", "enabled", "manual", "times", "everyMinutes", "nextAt", "nextCheckInMinutes", "events", "condition"],
  update: ["id", "text", "note", "profile", "enabled", "manual", "times", "everyMinutes", "nextAt", "nextCheckInMinutes", "events", "condition"],
  done: ["id"],
  ask: ["text"],
  help: ["text"],
  defer: ["text", "nextAt", "nextCheckInMinutes"],
  progress: ["text", "plan"],
  relay: ["scene", "text"],
  complete: ["text", "summary", "deliverableRef"],
  memory_search: ["query", "text", "status", "memoryScene", "scene", "scope", "memoryKind"],
  memory_propose: ["id", "claim", "text", "memoryKind", "evidence", "scope", "memoryScene", "scene", "pinned", "source"],
  memory_resolve: ["id", "resolveAction", "ids", "keepId", "signal", "text", "claim"],
  memory_pin: ["id", "pinned"],
  memory_forget: ["id"],
  vault_list: [],
  vault_get: ["id", "text", "url"],
  vault_save: ["id", "name", "condition", "content", "share"],
  vault_delete: ["id"],
  vault_request: ["text"],
  vault_send: ["id", "url"],
  orbit_list: [],
  orbit_add: ["text"],
  orbit_done: ["id", "done"],
  resume: ["id", "text"],
  answer: ["id", "text"],
  stop: ["id"],
};

const isPlainObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const zeroObject = (v: unknown) => isPlainObject(v) && Object.values(v).every((x) => x === 0 || x === "" || x == null);
const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length) || zeroObject(v);

/** The model filled most of the schema: treat placeholder-valued optional fields as absent. */
export function schemaFilled(args: Obj, properties: Obj = {}) {
  const keys = Object.keys(properties);
  const placeholders = keys.filter((k) => k in args && (empty(args[k]) || args[k] === 0)).length;
  if (placeholders >= 4) return true; // nobody clears four fields at once by hand
  const present = keys.filter((k) => k in args).length;
  return keys.length >= 5 && present >= 5 && present / keys.length > 0.6;
}

export function stripPlaceholderArgs(name: string, args: Obj, schema?: { properties?: Obj; required?: string[] }): Obj {
  const properties = schema?.properties || {}, required = new Set(schema?.required || []);
  const filled = schemaFilled(args, properties);
  const out: Obj = {};
  const fields = name === "employee" && typeof args.action === "string" ? EMPLOYEE_FIELDS[args.action] : undefined;
  for (const [k, v] of Object.entries(args)) {
    if (k === "_after") continue;
    // Only schema fields irrelevant to this action are dropped; anything else is passed through untouched.
    if (fields && k !== "action" && k in properties && !fields.includes(k)) continue;
    if (required.has(k) || k === "action") { out[k] = v; continue; }
    if (v == null || zeroObject(v)) continue;
    if (name === "employee") {
      // complete's deliverableRef: [] is the explicit "no separate body" answer.
      if (k === "deliverableRef") { out[k] = v; continue; }
      if (k === "nextCheckInMinutes" && v === 0) continue;
      const deliberate = args.action === "update" && !filled;
      // On a hand-written update "" / [] / 0 clear a field; in a schema fill they are only placeholders.
      if (!deliberate && (v === "" || (Array.isArray(v) && !v.length) || (k === "everyMinutes" && v === 0))) continue;
      if (filled && ((k === "enabled" && v === true) || (k === "manual" && v === false) || (k === "pinned" && v === false && args.action !== "memory_pin") || (k === "share" && v === false) || (k === "done" && v === false && args.action !== "orbit_done"))) continue;
      out[k] = v;
      continue;
    }
    if (filled && empty(v)) continue;
    out[k] = v;
  }
  return out;
}
