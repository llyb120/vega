import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Employee } from "../server/core/employee";
test("completed records and business keys are not silently deleted when history exceeds200", async () => {
  const store = await Store.open(":memory:"),
    employee = new Employee(store, new Vault(store), {
      run: async () => {},
      cancel: () => {},
      isRunning: () => false,
      send: async () => {},
      emit: () => {},
      config: () => ({ scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] }, model: "p/m" }),
    });
  employee.closed = true;
  try {
    await employee.update((s) => {
            for (let i = 0; i < 201; i++)
              s.tasks.push({
                id: "old-" + i,
                key: "business-" + i,
                text: "finished task " + i,
                status: "done",
                profile: "lightweight",
                cwd: process.cwd(),
                owner: { token: "", name: "" },
                createdAt: i,
                finishedAt: i,
              });
          });
    const added = await employee.execute("", {
      action: "add",
      kind: "todo",
      text: "new task",
    });
    await employee.update(
            (s) => (s.tasks.find((t) => t.id === added.value.id)!.status = "running"),
          );
    const job = (await employee.state()).tasks.find((t) => t.id === added.value.id)!;
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(job);
    const duplicate = await employee.execute("", {
      action: "add",
      kind: "todo",
      key: "business-0",
      text: "must not repeat",
    });
    assert.equal(duplicate.value.id, "old-0");
    assert.equal(duplicate.value.exists, true);
    assert.equal((await employee.state()).tasks.length, 202);
    assert((await employee.state()).tasks.some((t) => t.id === "old-0"));
  } finally {
    employee.close();
    await store.close();
  }
});
