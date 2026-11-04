import type { Store } from "./store";
import type { Obj } from "./util";

/**
 * An employee's tasks and runs live in their own tables (employee_tasks, employee_runs), not in the employee record.
 * attachRows gives a loaded employee record `tasks` and `runs` properties that read their rows only when first used;
 * saveRows writes back only rows that changed, were added or were removed since they were read. A record whose tasks
 * and runs were never touched writes neither, and a write never drops a task added meanwhile by someone else.
 */
const ROWS = Symbol("employee rows");
type Lazy<T> = { value?: T[]; seen?: Map<string | number, string> };
type Rows = { tasks: Lazy<Obj>; runs: Lazy<Obj>; runIds: WeakMap<Obj, number> };

export function attachRows(store: Store, employee: string, state: Obj) {
  const rows: Rows = { tasks: {}, runs: {}, runIds: new WeakMap() };
  const load = (name: "tasks" | "runs") => {
    const lazy = rows[name];
    if (lazy.seen) return;
    lazy.seen = new Map();
    const list = name === "tasks" ? store.employeeTasks(employee) : store.employeeRuns(employee);
    const value = list.map((row) => {
      lazy.seen!.set(row.id, row.data);
      const item = JSON.parse(row.data);
      if (name === "runs") rows.runIds.set(item, row.id as number);
      return item;
    });
    lazy.value ??= value;
  };
  for (const name of ["tasks", "runs"] as const)
    Object.defineProperty(state, name, {
      enumerable: true,
      configurable: true,
      get: () => { load(name); return rows[name].value; },
      // Replacing the list still needs the original rows, to know which ones to delete.
      set: (value: Obj[]) => { load(name); rows[name].value = value; },
    });
  Object.defineProperty(state, ROWS, { value: rows });
  return state;
}

/** The employee record without its row-backed lists, for the employee table. */
export function baseRecord(state: Obj) {
  return Object.fromEntries(Object.keys(state).filter((key) => key !== "tasks" && key !== "runs").map((key) => [key, state[key]]));
}

export function saveRows(store: Store, employee: string, state: Obj, active: (task: Obj) => boolean) {
  const rows: Rows | undefined = (state as any)[ROWS];
  if (!rows) return;
  const { tasks, runs } = rows;
  if (tasks.seen && tasks.value) {
    const kept = new Set<string>();
    for (const task of tasks.value) {
      const data = JSON.stringify(task);
      kept.add(task.id);
      if (tasks.seen.get(task.id) !== data) store.putEmployeeTask(employee, task.id, active(task), task.createdAt || Date.now(), data);
      tasks.seen.set(task.id, data);
    }
    for (const id of [...tasks.seen.keys()]) if (!kept.has(id as string)) { store.deleteEmployeeTask(id as string); tasks.seen.delete(id); }
  }
  if (runs.seen && runs.value) {
    const kept = new Set<number>();
    for (const run of runs.value) {
      const data = JSON.stringify(run);
      let id = rows.runIds.get(run);
      if (id === undefined) { id = store.insertEmployeeRun(employee, String(run.taskId || ""), data); rows.runIds.set(run, id); }
      else if (runs.seen.get(id) !== data) store.updateEmployeeRun(id, data);
      runs.seen.set(id, data);
      kept.add(id);
    }
    for (const id of [...runs.seen.keys()]) if (!kept.has(id as number)) { store.deleteEmployeeRun(id as number); runs.seen.delete(id); }
  }
}
