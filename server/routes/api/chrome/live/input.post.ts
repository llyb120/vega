import { defineEventHandler, getRequestURL } from "h3";
import { employeeLive } from "../../../../core/application";
import { check } from "../../../../core/auth";
import { bodyJSON } from "../../../../core/http-auth-routes";
import { principal } from "../../../../core/http-auth";
import type { Obj } from "../../../../core/util";

// Upstream half of the browser stream: every user gesture is one small POST, in order.
export default defineEventHandler(async (event) => {
  const body = await bodyJSON(event, 1 << 20),
    who = principal(event),
    hub = await employeeLive(getRequestURL(event).searchParams.get("employeeId") || undefined);
  check(typeof body.channel === "string" && body.message && typeof body.message === "object", 400, "Invalid realtime message");
  await hub.messageByChannel(body.channel, who, body.message as Obj);
  return { ok: true };
});
