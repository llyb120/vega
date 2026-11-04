import { defineEventHandler } from "h3";
import { app } from "../../core/application";
import { principal } from "../../core/http-auth";

export default defineEventHandler(async (event) =>
  await app().eventsSocket.ticket(principal(event)),
);
