import { test } from "node:test";
import assert from "node:assert/strict";
import { MasterRuntimes, CLOUD_MASTER } from "../server/core/master-runtime";

function setup() {
  const objects = new Map<string, any>();
  const store: any = {
    async object(kind: string, key: string) { return objects.get(kind + ":" + key); },
    async objects(kind: string) { return [...objects].filter(([key]) => key.startsWith(kind + ":")).map(([, value]) => value); },
    async save(kind: string, key: string, value: any) { objects.set(kind + ":" + key, JSON.parse(JSON.stringify(value))); },
  };
  const online: any[] = [];
  const agents: any = {
    list(userId: string) {
      return online.filter((item) => item.userId === userId).map((item) => ({ id: item.clientId, name: item.name, cwd: item.cwd, platform: item.platform }));
    },
  };
  const events: any[] = [];
  const employees = [
    { id: "e1", name: "甲", ownerId: "u1" },
    { id: "e2", name: "乙", ownerId: "u1" },
  ];
  const runtimes = new MasterRuntimes(store, agents, (value) => events.push(value));
  runtimes.listEmployees = async (ownerId: string) => employees.filter((item) => item.ownerId === ownerId).map((item) => ({ id: item.id, name: item.name }));
  runtimes.employeeInfo = async (employeeId: string) => employees.find((item) => item.id === employeeId);
  return { store, online, agents, events, employees, runtimes };
}

test("不同牛马可以有不同的文件系统和浏览器 Master", async () => {
  const { runtimes, online } = setup();
  const client = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  online.push({ userId: "u1", clientId: client, name: "本机", cwd: "/tmp", platform: "linux" });
  await runtimes.setMaster("e1", "fs", client);
  await runtimes.setMaster("e1", "browser", CLOUD_MASTER);
  await runtimes.setMaster("e2", "fs", CLOUD_MASTER);
  await runtimes.setMaster("e2", "browser", client);
  assert.equal(runtimes.peek("e1", "u1").fsMaster, client);
  assert.equal(runtimes.peek("e1", "u1").browserMaster, CLOUD_MASTER);
  assert.equal(runtimes.peek("e2", "u1").fsMaster, CLOUD_MASTER);
  assert.equal(runtimes.peek("e2", "u1").browserMaster, client);
  const view = await runtimes.view("u1");
  assert.equal(view.employees.length, 2);
  assert.ok(view.nodes.some((node) => node.id === CLOUD_MASTER));
  assert.ok(view.nodes.some((node) => node.id === client));
});

test("选定一头牛马的 Master 不影响其它牛马", async () => {
  const { runtimes, online } = setup();
  const client = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  online.push({ userId: "u1", clientId: client, name: "本机", cwd: "/tmp", platform: "linux" });
  await runtimes.setMaster("e1", "fs", client);
  await runtimes.setMaster("e2", "fs", client);
  await runtimes.setMaster("e1", "fs", CLOUD_MASTER);
  assert.equal(runtimes.peek("e1", "u1").fsMaster, CLOUD_MASTER);
  assert.equal(runtimes.peek("e2", "u1").fsMaster, client, "乙的 Master 必须保持不变");
});

test("未配置或空缺时把云端当作 Master", async () => {
  const { runtimes } = setup();
  const peek = runtimes.peek("e1", "u1");
  assert.equal(peek.fsMaster, CLOUD_MASTER);
  assert.equal(peek.browserMaster, CLOUD_MASTER);
  assert.equal(peek.updatedAt, 0);
});

test("旧的 prefer/browser 只给尚未配置的牛马做缺省，不能覆盖已配好的值", async () => {
  const { runtimes, online } = setup();
  const client = "cccccccccccccccccccccccccccccccc";
  online.push({ userId: "u1", clientId: client, name: "本机", cwd: "/tmp", platform: "linux" });
  await runtimes.setMaster("e1", "fs", CLOUD_MASTER);
  await runtimes.applyClientReport("u1", client, { prefer: "client", browser: "local" });
  assert.equal(runtimes.peek("e1", "u1").fsMaster, CLOUD_MASTER, "已配置的甲不能被旧上报覆盖");
  assert.equal(runtimes.peek("e2", "u1").fsMaster, client, "未配置的乙可以用缺省");
  assert.equal(runtimes.peek("e2", "u1").browserMaster, client);
  await runtimes.applyClientReport("u1", "dddddddddddddddddddddddddddddddd", { prefer: "cloud", browser: "cloud" });
  assert.equal(runtimes.peek("e2", "u1").fsMaster, client, "第二次上报不能改写已经播种的乙");
});

test("只有云端是这头牛马的 Master 时才允许借网桥", async () => {
  const { runtimes, online } = setup();
  const client = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  online.push({ userId: "u1", clientId: client, name: "本机", cwd: "/tmp", platform: "linux" });
  await runtimes.setMaster("e1", "fs", client);
  await runtimes.setMaster("e1", "browser", client);
  await runtimes.setMaster("e2", "fs", CLOUD_MASTER);
  assert.equal(runtimes.cloudMayBorrow("e1", "u1"), false);
  assert.equal(runtimes.cloudMayBorrow("e2", "u1"), true);
  assert.equal(await runtimes.ownerMayBorrow("u1"), true);
});

test("没有在线客户端时两端都由云端当 Master，客户端掉线后写回云端", async () => {
  const { runtimes, online } = setup();
  const client = "1234567890abcdef1234567890abcdef";
  online.push({ userId: "u1", clientId: client, name: "本机", cwd: "/tmp", platform: "linux" });
  await runtimes.setMaster("e1", "fs", client);
  await runtimes.setMaster("e1", "browser", client);
  assert.equal(runtimes.peek("e1", "u1").fsMaster, client);
  online.splice(0);
  assert.equal(runtimes.peek("e1", "u1").fsMaster, CLOUD_MASTER, "不在线时生效中的 Master 是云端");
  assert.equal(runtimes.peek("e1", "u1").browserMaster, CLOUD_MASTER);
  await runtimes.releaseUnavailable("u1");
  const second = "abcdef1234567890abcdef1234567890";
  online.push({ userId: "u1", clientId: second, name: "另一台", cwd: "/tmp", platform: "linux" });
  assert.equal(runtimes.peek("e1", "u1").fsMaster, CLOUD_MASTER, "写回云端后，别的客户端上线不会把已掉线的 Master 找回来");
  await assert.rejects(() => runtimes.setMaster("e1", "fs", client), /在线/);
  await runtimes.setMaster("e1", "fs", second);
  assert.equal(runtimes.peek("e1", "u1").fsMaster, second);
});
