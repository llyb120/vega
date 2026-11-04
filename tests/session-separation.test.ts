import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { resolveModel } from "../server/core/config";

test("ordinary conversations do not depend on employee state, schedule or task runtime; explicit delegation stays independent", async () => {
  const store = await Store.open(":memory:"),
    engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const config = {
    scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
    model: "p/m",
    provider: {
      p: {
        api: "openai-completions",
        baseURL: "https://fixture.test/v1",
        models: { m: { supportsImages: true } },
      },
    },
  };
  await store.put("config", config);
  const session = await store.newSession({ title: "ordinary" }),
    taskSession = await store.newSession({
          title: "employee",
          taskId: "existing-task",
        });
  const tools = await Tools.create(engine, session, config, new AbortController().signal, () => {}),
    model = resolveModel(config),
    originalState = engine.employee.state.bind(engine.employee),
    events: any[] = [];
  engine.events.on("event", (event) => events.push(event));
  engine.providers.chat = async (_model, _system, history) => {
    assert(!JSON.stringify(history).includes("[牛马任务"));
    return { role: "assistant", text: "ordinary reply" };
  };
  try {
    engine.employee.state = () => {
      throw Error("Employee storage is temporarily unavailable");
    };
    await engine.run(session.id, {
      role: "user",
      text: "just a normal conversation",
    });
    assert.equal((await store.messages(session.id)).at(-1)?.text, "ordinary reply");
    assert(!(await store.session(session.id)).taskId);
    assert(
      events
        .filter((event) => event.session === session.id)
        .every((event) => !event.taskId),
    );
    const rules = await tools.rules(model);
    assert(rules.includes("普通会话"));
    assert(rules.includes("不需要牛马启用"));
    assert((await tools.definitions(model)).some((tool) => tool.name === "chrome_act"));
    assert(!(await tools.definitions(model)).some((tool) => tool.name.startsWith("vault_")), "a plain session belongs to no employee and has no vault");
    assert(!rules.includes("[密码本]"));
    const readOnlyTools = await Tools.create(engine, await store.newSession({ title: "readonly", readOnly: true }), config, new AbortController().signal, () => {});
    assert(
      !(await readOnlyTools.definitions(model)).some((tool) => tool.name.startsWith("vault_")),
    );
    engine.employee.state = originalState;
    const delegated = await tools.execute(
      {
        id: "delegate",
        name: "employee_task_create",
        arguments: {
          instructions: "explicitly delegated independent task",
        },
      },
      model,
    );
    assert(
      (await engine.employee
                .state())
        .tasks.some((task) => task.id === delegated.value.id),
    );
    assert(!(await store.session(session.id)).taskId);
    assert.equal((await store.messages(session.id)).length, 2);
    assert.equal((await store.messages(taskSession.id)).length, 0);
    await assert.rejects(async () => await store.stage(taskSession.id));
    await assert.rejects(async () => await store.fork(taskSession.id));
    const stage = await store.stage(session.id);
    assert(!stage.taskId);
    assert.equal(stage.stageSource, session.id);
    assert(!(await store.fork(session.id)).taskId);
    const taskTools = await Tools.create(engine, taskSession, config, new AbortController().signal, () => {});
    assert(
      (await taskTools.rules(model)).includes("当前会话属于牛马任务"),
    );
    assert(
      !(await taskTools.definitions(model)).some((tool) => ["vault_request", "vault_send"].includes(tool.name)),
    );
    await engine.run(taskSession.id, {
      role: "user",
      text: "separate worker input",
    });
    assert(
      events
        .filter((event) => event.session === taskSession.id)
        .every((event) => event.taskId === "existing-task"),
    );
  } finally {
    engine.employee.state = originalState;
    await engine.close();
    await store.close();
  }
});
