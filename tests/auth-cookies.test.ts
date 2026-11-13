import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as h3 from "h3";
import * as auth from "../server/core/auth";
import {
  publicOrigin,
  sameOrigin,
  setLogin,
  clearLogin,
} from "../server/core/http-auth";
function event(headers: Record<string, string> = {}, secure = false) {
  const values: Record<string, any> = {};
  const res = {
    setHeader: (k: string, v: any) => (values[k.toLowerCase()] = v),
    getHeader: (k: string) => values[k.toLowerCase()],
    removeHeader: (k: string) => delete values[k.toLowerCase()],
  };
  return {
    event: {
      node: {
        req: {
          headers: { host: "vega.test", ...headers },
          socket: { encrypted: secure },
        },
        res,
      },
      context: {},
    } as any,
    values,
  };
}
test("native extension requests reach their own device-credential authentication", async () => {
  const source = readFileSync("server/core/http-auth.ts", "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "h3") return h3;
    if (name === "./auth") return auth;
    if (name === "./application") return { app: () => ({ auth: { authenticate: async () => undefined }, token: "fixture" }), authenticated: () => false };
    throw Error("Unexpected dependency " + name);
  }, module, module.exports);
  const request = event().event;
  request.method = "POST";
  await module.exports.gate(request, "/api/local-agent/extension");
  await assert.rejects(module.exports.gate(request, "/api/local-agent/other"), { statusCode: 401 });
});

test("login cookies are HttpOnly/SameSite Strict and Secure follows a pinned public HTTPS origin, not spoofed forwarded headers", () => {
  const previous = process.env.VEGA_PUBLIC_URL;
  try {
    delete process.env.VEGA_PUBLIC_URL;
    let v = event({ "x-forwarded-proto": "https" });
    assert.equal(publicOrigin(v.event), "http://vega.test");
    setLogin(v.event, "cookie-fixture", Date.now() + 3600000);
    let cookie = String(v.values["set-cookie"]);
    assert(cookie.includes("HttpOnly"));
    assert(cookie.includes("SameSite=Strict"));
    assert(!cookie.includes("; Secure"));
    v = event({}, true);
    setLogin(v.event, "fixture", Date.now() + 3600000);
    assert(String(v.values["set-cookie"]).includes("Secure"));
    process.env.VEGA_PUBLIC_URL = "https://public.example";
    v = event({ host: "internal:8080", origin: "https://public.example" });
    sameOrigin(v.event);
    setLogin(v.event, "fixture", Date.now() + 3600000);
    assert(String(v.values["set-cookie"]).includes("Secure"));
    assert.throws(
      () => sameOrigin(event({ origin: "https://evil.example" }).event),
      { statusCode: 403 },
    );
    assert.throws(
      () => sameOrigin(event({ "sec-fetch-site": "cross-site" }).event),
      { statusCode: 403 },
    );
    process.env.VEGA_PUBLIC_URL = "https://public.example/subpath";
    assert.throws(() => publicOrigin(v.event), { statusCode: 500 });
  } finally {
    if (previous === undefined) delete process.env.VEGA_PUBLIC_URL;
    else process.env.VEGA_PUBLIC_URL = previous;
  }
});
