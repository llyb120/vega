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
  const store = new Store(":memory:"),
    engine = new Engine(
      store,
      new Catalog(store, new Subscriptions(store, "")),
      new Chrome(store, new ChromeBridge(), ""),
    );
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
  store.put("config", config);
  const session = store.newSession({ title: "ordinary" }),
    taskSession = store.newSession({
      title: "employee",
      taskId: "existing-task",
    });
  const tools = new Tools(
      engine,
      session,
      config,
      new AbortController().signal,
      () => {},
    ),
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
    assert.equal(store.messages(session.id).at(-1)?.text, "ordinary reply");
    assert(!store.session(session.id).taskId);
    assert(
      events
        .filter((event) => event.session === session.id)
        .every((event) => !event.taskId),
    );
    const rules = tools.rules(model);
    assert(rules.includes("普通会话"));
    assert(rules.includes("不需要牛马启用"));
    assert(tools.definitions(model).some((tool) => tool.name === "chrome_act"));
    assert(!tools.definitions(model).some((tool) => tool.name.startsWith("vault_")), "a plain session belongs to no employee and has no vault");
    assert(!rules.includes("[密码本]"));
    const readOnlyTools = new Tools(
      engine,
      store.newSession({ title: "readonly", readOnly: true }),
      config,
      new AbortController().signal,
      () => {},
    );
    assert(
      !readOnlyTools.definitions(model).some((tool) => tool.name.startsWith("vault_")),
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
      engine.employee
        .state()
        .tasks.some((task) => task.id === delegated.value.id),
    );
    assert(!store.session(session.id).taskId);
    assert.equal(store.messages(session.id).length, 2);
    assert.equal(store.messages(taskSession.id).length, 0);
    assert.throws(() => store.stage(taskSession.id));
    assert.throws(() => store.fork(taskSession.id));
    const stage = store.stage(session.id);
    assert(!stage.taskId);
    assert.equal(stage.stageSource, session.id);
    assert(!store.fork(session.id).taskId);
    const taskTools = new Tools(
      engine,
      taskSession,
      config,
      new AbortController().signal,
      () => {},
    );
    assert(
      taskTools.rules(model).includes("当前会话属于牛马任务"),
    );
    assert(
      !taskTools.definitions(model).some((tool) => ["vault_request", "vault_send"].includes(tool.name)),
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
    store.close();
  }
});
