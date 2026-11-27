import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Message } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Employee } from "../server/core/employee";
import { promptHistory } from "../server/core/history";
test("completed records and business keys are not silently deleted when history exceeds200", async () => {
  const store = await Store.open(":memory:"),
    employee = new Employee(store, new Vault(store), {
      run: async () => {},
      cancel: () => {},
      isRunning: () => false,
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

test("promptHistory rolls off old browser elements/text and appuse controls/images per stream", () => {
  const rows: Message[] = [];
  const pushBrowser = (id: string, tab: string) => {
    rows.push(
      { role: "assistant", calls: [{ id, name: "browser_view", arguments: {} }] },
      {
        role: "tool",
        name: "browser_view",
        callId: id,
        text: `[m${String(rows.length + 1).padStart(5, "0")}] ` + JSON.stringify({
          tab,
          snapshotId: id,
          elements: `[1] button "Btn ${id}" @(10,20)`,
          text: `body ${id}`,
          images: [{ path: `${id}.jpg`, frameStream: `${tab}:viewport` }],
        }),
        images: [{ mime: "image/jpeg", path: `${id}.jpg` }],
      },
    );
  };
  const pushAppuse = (id: string, stream: string, asString: boolean) => {
    rows.push(
      { role: "assistant", calls: [{ id, name: "appuse_view", arguments: {} }] },
      {
        role: "tool",
        name: "appuse_view",
        callId: id,
        text: JSON.stringify({
          snapshotId: id,
          status: "executed",
          elements: asString ? `[1] button "${id}" @(100,80)` : [`[1] button "${id}" @(100,80)`],
          images: [{ imageId: stream, frameStream: stream, path: `${id}.jpg` }],
        }),
        images: [{ mime: "image/jpeg", path: `${id}.jpg` }],
      },
    );
  };

  pushBrowser("b1", "C1");
  pushBrowser("b2", "C1");
  pushBrowser("b3", "C1");
  pushAppuse("a1", "monitor-0", false);
  pushAppuse("a-other", "monitor-1", true);
  pushAppuse("a2", "monitor-0", true);
  pushAppuse("a3", "monitor-0", false);

  const projected = promptHistory(rows);
  const oldBrowser = JSON.parse(projected[1].text!.replace(/^\[m\d+\]\s*/, ""));
  assert.equal(oldBrowser.elements, undefined);
  assert.equal(oldBrowser.text, undefined);
  assert.equal(oldBrowser.domOmitted, "该标签仅保留最近两次 DOM；旧观察正文已省略。");
  assert.equal(oldBrowser.images, undefined);
  assert.match(oldBrowser.imagesOmitted, /截图已移出上下文：b1\.jpg/);
  assert.equal(projected[1].images?.length, 0);

  const keptBrowser = JSON.parse(projected[3].text!.replace(/^\[m\d+\]\s*/, ""));
  assert.match(keptBrowser.elements, /Btn b2/);
  assert.equal(projected[3].images?.length, 1);

  const oldAppuse = JSON.parse(projected[7].text!);
  assert.equal(oldAppuse.elements, undefined);
  assert.equal(oldAppuse.elementsOmitted, "仅保留最近两次桌面控件清单；旧控件列表已省略。");
  assert.equal(oldAppuse.images, undefined);
  assert.match(oldAppuse.imagesOmitted, /桌面截图已移出上下文：a1\.jpg/);
  assert.equal(projected[7].images?.length, 0);

  const otherMonitor = JSON.parse(projected[9].text!);
  assert.match(otherMonitor.elements, /a-other/);
  assert.equal(projected[9].images?.length, 1);

  const recentAppuse = JSON.parse(projected[11].text!);
  assert.match(recentAppuse.elements, /a2/);
  assert.equal(projected[11].images?.length, 1);
  assert.deepEqual(promptHistory(projected), projected);
});

test("historyImages retains up to 6 distinct mediaReady URLs in one tab while preserving 2-frame cap for regular pages", () => {
  const rows: Message[] = [];
  const pushMedia = (id: string, url: string) => {
    rows.push(
      { role: "assistant", calls: [{ id, name: "browser_tabs", arguments: { action: "goto", url } }] },
      {
        role: "tool",
        name: "browser_tabs",
        callId: id,
        text: JSON.stringify({
          tab: "C7",
          url,
          snapshotId: id,
          mediaReady: { contentType: "image/png", naturalWidth: 1000, naturalHeight: 800 },
          images: [{ path: `${id}.jpg`, frameStream: "C7:viewport" }],
        }),
        images: [{ mime: "image/jpeg", path: `${id}.jpg` }],
      },
    );
  };
  const pushPage = (id: string, url: string) => {
    rows.push(
      { role: "assistant", calls: [{ id, name: "browser_view", arguments: { tab: "C7" } }] },
      {
        role: "tool",
        name: "browser_view",
        callId: id,
        text: JSON.stringify({
          tab: "C7",
          url,
          snapshotId: id,
          elements: `[1] button "${id}"`,
          text: `page ${id}`,
          images: [{ path: `${id}.jpg`, frameStream: "C7:viewport" }],
        }),
        images: [{ mime: "image/jpeg", path: `${id}.jpg` }],
      },
    );
  };

  pushMedia("m-dup-old", "https://example.test/1.png");
  pushMedia("m-1", "https://example.test/1.png");
  pushMedia("m-2", "https://example.test/2.png");
  pushMedia("m-3", "https://example.test/3.png");
  pushPage("p-1", "https://example.test/p1");
  pushPage("p-2", "https://example.test/p2");
  pushPage("p-3", "https://example.test/p3");

  const projected = promptHistory(rows);
  const kept = projected.flatMap((m) => (m.images || []).map((im) => im.path));
  assert.deepEqual(kept, ["m-1.jpg", "m-2.jpg", "m-3.jpg", "p-2.jpg", "p-3.jpg"]);
  assert.deepEqual(promptHistory(projected), projected);
});
