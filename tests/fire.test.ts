import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Fire, parseFire } from "../server/core/fire";
import { sleep } from "../server/core/util";
test("Fire executes independent work/judge stages, rejects unverifiable work and terminates only on a final verdict", async () => {
  const store = await Store.open(":memory:"),
    root = await store.newSession(),
    prompts: string[] = [];
  let calls = 0;
  const fire = new Fire(
    store,
    async (session, message) => {
      assert.equal(
        (await store.messages(session)).length,
        0,
        "A phase inherited another phase transcript",
      );
      prompts.push(message.text || "");
      await store.append(session, message);
      calls++;
      await store.append(session, {
                role: "assistant",
                text:
                  calls === 2
                    ? "Missing real evidence\nFIRE_REJECTED"
                    : calls === 4
                      ? "Verified actual artifact\nFIRE_ACCEPTED"
                      : "Implemented result",
              });
    },
    () => {},
    () => {},
  );
  try {
    await fire.start(
            root.id,
            "/fire complete fixture\n/target actual artifact exists",
          );
    await fire.running.get(root.id);
    const state = (await fire.get(root.id))!;
    assert.equal(state.status, "accepted");
    assert.equal(state.phases.length, 4);
    assert(prompts[1].includes("不是完成证据") || prompts[1].includes("不"));
    assert(prompts[2].includes("Missing real evidence"));
    assert.equal((await store.sessions()).length, 4);
    assert(!(await store.session(state.latest)).stageSource);
    assert.equal(
      await fire.resume(root.id, { role: "user", text: "old phase must not branch" }),
      false,
    );
  } finally {
    await fire.close();
    await store.close();
  }
});
test("Fire cancellation and restart preserve latest phase and never automatically resubmit", async () => {
  const store = await Store.open(":memory:"),
    root = await store.newSession();
  let reject!: (e: Error) => void;
  const fire = new Fire(
    store,
    async (s, m) => {
      await store.append(s, m);
      await new Promise<void>((_, no) => (reject = no));
    },
    () => reject?.(Error("paused")),
    () => {},
  );
  try {
    await fire.start(root.id, "/fire one task");
    for (let i = 0; i < 20 && !reject; i++) await sleep(1);
    await fire.pause(root.id);
    await fire.running.get(root.id);
    assert.equal((await fire.get(root.id))!.status, "paused");
    const restored = new Fire(
      store,
      async () => {
        throw Error("must not run on recovery");
      },
      () => {},
      () => {},
    );
    const state = (await fire.get(root.id))!;
    state.status = "running";
    await store.save("fire", root.id, state);
    await restored.recover();
    assert.equal((await restored.get(root.id))!.status, "paused");
    assert.equal(restored.running.size, 0);
    assert.equal((await store.sessions()).length, 1);
    await restored.close();
    assert.throws(() => parseFire("/fire x\n/target a\n/target b"));
    assert.throws(() => parseFire("/fire x\n/target"));
    assert.throws(() => parseFire("/fire"));
    assert.deepEqual(parseFire("/fire x\n/target a\nb"), {
      goal: "x",
      criteria: "a\nb",
    });
  } finally {
    await fire.close();
    await store.close();
  }
});
