import type { Store } from "./store";
import type { Obj } from "./util";

/**
 * An employee's tasks and runs live in their own tables (employee_tasks, employee_runs), not in the employee record.
 * loadRows reads them into a loaded record and remembers what was read; saveRows writes back only rows that changed,
 * were added or were removed since then. A record loaded without rows writes neither, and a write never drops a task
 * added meanwhile by someone else.
 */
const ROWS = Symbol("employee rows");
type Rows = { tasks: Map<string, string>; runs: Map<number, string>; runIds: WeakMap<Obj, number> };

export async function loadRows(store: Store, employee: string, state: Obj) {
  const rows: Rows = { tasks: new Map(), runs: new Map(), runIds: new WeakMap() };
  const [tasks, runs] = await Promise.all([store.employeeTasks(employee), store.employeeRuns(employee)]);
  state.tasks = tasks.map((row) => { rows.tasks.set(row.id, row.data); return JSON.parse(row.data); });
  state.runs = runs.map((row) => {
    const run = JSON.parse(row.data);
    rows.runs.set(row.id, row.data);
    rows.runIds.set(run, row.id);
    return run;
  });
  Object.defineProperty(state, ROWS, { value: rows });
  return state;
}

/** The employee record without its row-backed lists, for the employee table. */
export function baseRecord(state: Obj) {
  return Object.fromEntries(Object.keys(state).filter((key) => key !== "tasks" && key !== "runs").map((key) => [key, state[key]]));
}

export async function saveRows(store: Store, employee: string, state: Obj, active: (task: Obj) => boolean) {
  const rows: Rows | undefined = (state as any)[ROWS];
  if (!rows) return;
  const kept = new Set<string>();
  for (const task of state.tasks as Obj[]) {
    const data = JSON.stringify(task);
    kept.add(task.id);
    if (rows.tasks.get(task.id) !== data) await store.putEmployeeTask(employee, task.id, active(task), task.createdAt || Date.now(), data);
    rows.tasks.set(task.id, data);
  }
  for (const id of [...rows.tasks.keys()]) if (!kept.has(id)) { await store.deleteEmployeeTask(id); rows.tasks.delete(id); }
  const keptRuns = new Set<number>();
  for (const run of state.runs as Obj[]) {
    const data = JSON.stringify(run);
    let id = rows.runIds.get(run);
    if (id === undefined) { id = await store.insertEmployeeRun(employee, String(run.taskId || ""), data); rows.runIds.set(run, id); }
    else if (rows.runs.get(id) !== data) await store.updateEmployeeRun(id, data);
    rows.runs.set(id, data);
    keptRuns.add(id);
  }
  for (const id of [...rows.runs.keys()]) if (!keptRuns.has(id)) { await store.deleteEmployeeRun(id); rows.runs.delete(id); }
}
