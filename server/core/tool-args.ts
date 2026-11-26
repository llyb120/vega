type Obj = Record<string, any>;

/**
 * The only leniency left for model-filled arguments: an optional field that is null, or that holds the
 * empty value its own declared lower bound rejects (0 with minimum ≥ 1, "" with minLength ≥ 1,
 * [] with minItems ≥ 1), counts as omitted. Optional objects with required fields whose provided
 * keys are all known and themselves omittable (e.g. `{ dir: "", entry: "", title: "" }`) also count
 * as omitted. Every other value ("" / 0 / false / [] included) is real.
 */
export function omittable(schema: Obj | undefined, v: unknown): boolean {
  if (
    v === null || v === undefined ||
    (v === 0 && typeof schema?.minimum === "number" && schema.minimum >= 1) ||
    (v === "" && typeof schema?.minLength === "number" && schema.minLength >= 1) ||
    (Array.isArray(v) && !v.length && typeof schema?.minItems === "number" && schema.minItems >= 1)
  ) return true;
  if (
    schema?.type === "object" &&
    schema.properties &&
    Array.isArray(schema.required) &&
    schema.required.length > 0 &&
    !!v && typeof v === "object" && !Array.isArray(v)
  ) {
    const entries = Object.entries(v as Obj);
    return entries.length > 0 && entries.every(([k, val]) => k in schema.properties && omittable(schema.properties[k], val));
  }
  return false;
}

/** Top-level pass for the generic tools (read, bash, mcp …); scheduling metadata `_after` never reaches executors. */
export function omitPlaceholders(args: Obj, schema?: { properties?: Obj; required?: string[] }): Obj {
  const properties = schema?.properties || {}, required = new Set(schema?.required || []);
  const out: Obj = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "_after") continue;
    if (!required.has(k) && k in properties && omittable(properties[k], v)) continue;
    out[k] = v;
  }
  return out;
}
