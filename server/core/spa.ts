// History-router fallback: the web app's page paths (router.js ROUTE_ROOTS) answer with index.html,
// so a refresh on /employees/:id or /settings/scenes lands on the app. API, assets, the extension
// and anything that looks like a file keep their own 404s.
export const SPA_ROOTS = ["employees", "groups", "chat", "resources", "usage", "browser", "experiences", "debug", "settings", "account"];
export function spaPage(method: string, pathname: string) {
  if (method !== "GET" && method !== "HEAD") return false;
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 0 && SPA_ROOTS.includes(parts[0]) && !/\.[a-z0-9]+$/i.test(parts.at(-1)!);
}
