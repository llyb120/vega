import {
  defineEventHandler,
  getQuery,
  setHeader,
  send,
  setResponseStatus,
} from "h3";
import { app } from "../../../../core/application";
export default defineEventHandler((event) => {
  setHeader(event, "Cache-Control", "no-store");
  setHeader(event, "Referrer-Policy", "no-referrer");
  setHeader(event, "Content-Type", "text/html; charset=utf-8");
  setHeader(
    event,
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  try {
    const q = getQuery(event);
    if (typeof q.state !== "string" || typeof q.code !== "string")
      throw Error("missing callback");
    app().engine.catalog.auth.receiveCallback(q.state, q.code);
    return send(
      event,
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录完成</title><body style="font-family:system-ui;padding:48px"><h1>授权已收到</h1><p>返回 Vega 即可完成登录，可以关闭此窗口。</p></body></html>',
    );
  } catch {
    setResponseStatus(event, 400);
    return send(
      event,
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录未完成</title><body><h1>登录链接已失效</h1><p>请返回 Vega 重新开始登录。</p></body></html>',
    );
  }
});
