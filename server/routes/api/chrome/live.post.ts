import { defineEventHandler, createError } from "h3";
import { app } from "../../../core/application";
import { check } from "../../../core/auth";
import { bodyJSON } from "../../../core/http-auth-routes";
import { principal } from "../../../core/http-auth";
export default defineEventHandler(async (event) => {
  try {
    const body = await bodyJSON(event, 1024);
    check(
      Object.keys(body).every((key) => key === "tabTag"),
      400,
      "只接受tabTag",
    );
    return await app().browserLive.ticket(principal(event), body.tabTag);
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 400,
      statusMessage: String(error.message || "Invalid request").slice(0, 400),
    });
  }
});
