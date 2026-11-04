import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref, computed, watch, nextTick } from "vue";
import { ADMIN_PAGES, ROUTE_ROOTS, parseRoute, formatRoute } from "../web/src/router.js";
import { SPA_ROOTS, spaPage } from "../server/core/spa";

test("router: paths round-trip through parse and format, tabs and selected items included", () => {
  const paths = [
    "/employees/e1", "/employees/e1/tasks", "/employees/e1/tasks/t1", "/employees/e1/sessions/s1", "/employees/e1/settings",
    "/employees/e1/memories", "/employees/e1/vault", "/employees/new", "/groups/g1", "/groups/g1/work", "/groups/g1/members",
    "/groups/new", "/chat", "/chat/s1", "/resources", "/settings", "/settings/scenes", "/debug", "/debug/s9", "/experiences/r1", "/account",
    "/employees/%E7%89%9B%20%2F1",
  ];
  for (const path of paths) assert.equal(formatRoute(parseRoute(path)), path, path);
  assert.deepEqual(parseRoute("/employees/e1/tasks/t1"), { view: "employee", employee: "e1", tab: "tasks", task: "t1" });
  assert.deepEqual(parseRoute("/groups/g1/work"), { view: "group", group: "g1", sub: "work" });
  assert.deepEqual(parseRoute("/employees/%E7%89%9B%20%2F1"), { view: "employee", employee: "牛 /1" });
  assert.equal(formatRoute({ view: "employee", employee: "e1", tab: "chat" }), "/employees/e1", "chat is the default tab");
  assert.equal(formatRoute({ view: "settings", sub: "" }), "/settings");
});

test("router: unknown paths and tabs fall back to the page or the default view; old ?employee= links still open", () => {
  assert.deepEqual(parseRoute("/"), { view: "employee" });
  assert.deepEqual(parseRoute("/nope/x"), { view: "employee" });
  assert.deepEqual(parseRoute("/employees/e1/bogus"), { view: "employee", employee: "e1" });
  assert.deepEqual(parseRoute("/groups/g1/bogus"), { view: "group", group: "g1" });
  assert.deepEqual(parseRoute("/settings/bogus"), { view: "settings" });
  assert.deepEqual(parseRoute("/resources/x"), { view: "resources" });
  assert.deepEqual(parseRoute("/?employee=e1"), { view: "employee", employee: "e1" });
  assert.deepEqual(parseRoute("/employees/%E0%A4%A"), { view: "employee", employee: "%E0%A4%A" }, "bad escapes do not throw");
  assert.equal(formatRoute({ view: "employee" }), "/");
  assert.equal(formatRoute({ view: "whatever" }), "/");
});

test("server SPA fallback: app pages get index.html; API, assets, files and other paths keep their 404s", () => {
  assert.deepEqual([...SPA_ROOTS].sort(), [...ROUTE_ROOTS].sort(), "server and router agree on the page roots");
  for (const path of ["/employees/e1", "/employees/e1/tasks/t1", "/groups/g1/work", "/settings/scenes", "/debug/s1", "/account", "/chat"]) assert(spaPage("GET", path), path);
  assert(spaPage("HEAD", "/resources"));
  for (const path of ["/", "/api/x", "/api/events", "/assets/a.js", "/extension/x", "/clients/x.zip", "/employees/x.js", "/foo"]) assert(!spaPage("GET", path), path);
  assert(!spaPage("POST", "/employees/e1"));
  const route = readFileSync("server/routes/[...].ts", "utf8");
  assert(route.includes("spaPage(") && route.includes('"/index.html"') && route.includes("statusCode: 404"));
  assert(!readFileSync("web/vite.config.js", "utf8").includes("base:"), "absolute /assets URLs work from nested paths");
});

// The App.vue routing block, run against plain refs.
const source = readFileSync("web/src/App.vue", "utf8");
const block = source.slice(source.indexOf("const pageTabs = ref("), source.indexOf("// Last, once all the state it reads exists."));
function app(href: string, { admin = false, employees = ["ea", "eb"], groups = ["g1"] } = {}) {
  const history: string[] = [], location = new URL(href);
  const window = { location, history: {
    pushState: (_s: any, _t: string, path: string) => { location.href = new URL(path, location).href; history.push("push " + path); },
    replaceState: (_s: any, _t: string, path: string) => { location.href = new URL(path, location).href; history.push("replace " + path); },
  } };
  const c: any = {
    ref, computed, watch, nextTick, window, ADMIN_PAGES, parseRoute, formatRoute,
    user: ref({ id: "alice" }), isAdmin: ref(admin), canExecute: ref(true), view: ref("employee"),
    selectedEmployee: ref("ea"), creatingEmployee: ref(false), employeeTab: ref("chat"), employeeTaskFocus: ref(""), employeeSession: ref(""),
    selectedGroup: ref(""), current: ref(null), sessions: ref([{ id: "s1" }]), employee: ref({ id: "ea" }),
    employees: ref(employees.map((id) => ({ id }))), groups: ref(groups.map((id) => ({ id }))),
    employeeTabs: ref([["chat"], ["tasks"], ["duties"], ["settings"]]),
    attempt: (fn: any) => fn(), selectSession: async (s: any) => { c.current.value = s; c.view.value = "chat"; },
    openGroup: (id: string) => { c.selectedGroup.value = id; c.view.value = "group"; },
    chooseEmployee: async (id: string) => { c.selectedEmployee.value = id; c.employee.value = { id }; c.employeeTab.value = "chat"; c.employeeSession.value = ""; c.employeeTaskFocus.value = ""; c.creatingEmployee.value = false; c.view.value = "employee"; },
    openEmployee: (session = "") => { c.employeeSession.value = session; c.view.value = "employee"; },
    openEmployeeTask: async (id: string) => { if (id === "t1") { c.employeeTab.value = "tasks"; c.employeeTaskFocus.value = id; } },
  };
  Object.assign(c, vm.runInNewContext(block + "\n({ applyRoute, routeChanged, syncRoute, setPageTab, pageSub, routePath, start() { routeReady = true; } })", c));
  return { c, history, location };
}
async function boot(href: string, options?: any) {
  const s = app(href, options);
  await s.c.applyRoute(parseRoute(href));
  s.c.start(); s.c.syncRoute(true);
  return s;
}

test("App routing: refresh restores page and tab; tab and page switches push; back/forward reapplies without pushing", async () => {
  const s = await boot("https://vega.test/employees/eb/tasks/t1");
  assert.deepEqual([s.c.selectedEmployee.value, s.c.employeeTab.value, s.c.employeeTaskFocus.value], ["eb", "tasks", "t1"]);
  assert.deepEqual(s.history, [], "an exact path needs no rewrite");
  s.c.employeeTaskFocus.value = ""; s.c.employeeTab.value = "duties"; await nextTick();
  s.c.openGroup("g1"); await nextTick();
  s.c.setPageTab("work"); await nextTick();
  assert.deepEqual(s.history, ["push /employees/eb/duties", "push /groups/g1", "push /groups/g1/work"]);
  s.location.href = "https://vega.test/employees/eb/duties";
  s.c.routeChanged(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([s.c.view.value, s.c.employeeTab.value], ["employee", "duties"]);
  s.location.href = "https://vega.test/groups/g1/work";
  s.c.routeChanged(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([s.c.view.value, s.c.selectedGroup.value, s.c.pageSub.value], ["group", "g1", "work"]);
  assert.equal(s.history.length, 3, "popstate does not add entries");
  const settings = await boot("https://vega.test/settings/scenes", { admin: true });
  assert.deepEqual([settings.c.view.value, settings.c.pageSub.value], ["settings", "scenes"]);
  settings.c.view.value = "resources"; await nextTick();
  settings.c.view.value = "settings"; await nextTick();
  assert.equal(settings.c.pageSub.value, "scenes", "each page keeps its own tab when you come back");
  assert.equal(settings.location.pathname, "/settings/scenes");
});

test("App routing: unknown or forbidden ids and pages fall back to the default view with replaceState; old links normalize", async () => {
  for (const [href, path] of [
    ["https://vega.test/groups/gone", "/employees/ea"], ["https://vega.test/settings/scenes", "/employees/ea"],
    ["https://vega.test/employees/hidden/tasks", "/employees/ea/tasks"], ["https://vega.test/employees/ea/vault", "/employees/ea"],
    ["https://vega.test/?employee=eb", "/employees/eb"], ["https://vega.test/nope", "/employees/ea"], ["https://vega.test/", "/employees/ea"],
  ]) {
    const s = await boot(href);
    assert.deepEqual(s.history, ["replace " + path], href);
  }
});
