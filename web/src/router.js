// A tiny hash router: the address bar mirrors which page is open (/#/employees/e1/tasks), so refresh and links land
// on it. Only the hash changes while navigating, so mobile browsers show no page-loading bar.
// Paths only describe the page; App.vue checks that the ids exist and are visible before opening them.
export const PAGES = ["resources", "browser", "experiences", "debug", "settings", "account"];
export const ADMIN_PAGES = ["browser", "experiences", "debug", "settings"];
export const GROUP_PANELS = ["work", "members"];
/** Page sub-views kept in the path: a fixed list, or any id (the selected item) when true. */
const PAGE_SUBS = { settings: ["scenes"], debug: true, experiences: true };
const pageSub = (page, sub) => PAGE_SUBS[page] === true || PAGE_SUBS[page]?.includes(sub);
export const EMPLOYEE_TABS = ["tasks", "browser", "duties", "memories", "capabilities", "vault", "settings"];
/** First path segments that are app pages; the server answers old /employees/… links with index.html (then redirected). */
export const ROUTE_ROOTS = ["employees", "groups", "chat", ...PAGES];

const decode = (part) => { try { return decodeURIComponent(part); } catch { return part; } };
const encode = encodeURIComponent;

/** "/employees/e1/tasks/t1" → { view: "employee", employee: "e1", tab: "tasks", task: "t1" }. Unknown paths → the default page. */
export function parseRoute(href = "/") {
  const url = new URL(href, "http://x");
  const [root, id, sub, extra, ...rest] = url.pathname.split("/").filter(Boolean).map(decode);
  // Old mention links: /?employee=ID
  if (!root) { const old = url.searchParams.get("employee"); return old ? { view: "employee", employee: old } : { view: "employee" }; }
  if (root === "employees") {
    if (!id || rest.length) return { view: "employee", ...(id ? { employee: id } : {}) };
    if (id === "new" && !sub) return { view: "employee", creating: true };
    if (sub === "tasks" && extra) return { view: "employee", employee: id, tab: "tasks", task: extra };
    if (sub === "sessions" && extra) return { view: "employee", employee: id, session: extra };
    if (EMPLOYEE_TABS.includes(sub) && !extra) return { view: "employee", employee: id, tab: sub };
    return { view: "employee", employee: id };
  }
  if (root === "groups" && id && !extra) return { view: "group", group: id === "new" ? "" : id, ...(id !== "new" && GROUP_PANELS.includes(sub) ? { sub } : {}) };
  if (root === "chat" && !sub) return id ? { view: "chat", session: id } : { view: "chat" };
  if (PAGES.includes(root) && !sub) return { view: root, ...(id && pageSub(root, id) ? { sub: id } : {}) };
  return { view: "employee" };
}

/** The inverse of parseRoute for the page state App.vue holds. */
export function formatRoute(route) {
  const { view, employee, creating, tab, task, session, group, sub } = route;
  if (view === "employee") {
    if (creating) return "/employees/new";
    if (!employee) return "/";
    const base = "/employees/" + encode(employee);
    if (session) return base + "/sessions/" + encode(session);
    if (tab === "tasks" && task) return base + "/tasks/" + encode(task);
    return EMPLOYEE_TABS.includes(tab) ? base + "/" + tab : base;
  }
  if (view === "group") return group ? "/groups/" + encode(group) + (GROUP_PANELS.includes(sub) ? "/" + sub : "") : "/groups/new";
  if (view === "chat") return session ? "/chat/" + encode(session) : "/chat";
  if (!PAGES.includes(view)) return "/";
  return "/" + view + (sub && pageSub(view, sub) ? "/" + encode(sub) : "");
}

export const employeePath = (id) => "#/employees/" + encode(id);
/** The route path in a location: the hash (#/…), else an old path link (/employees/…, /?employee=ID). */
export function locationPath(location) {
  return location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname + location.search;
}
/** The path the address bar already shows in canonical form (/#/…), or null when it needs rewriting. */
export function canonicalPath(location) {
  return location.pathname === "/" && !location.search && location.hash.startsWith("#/") ? location.hash.slice(1) : null;
}
