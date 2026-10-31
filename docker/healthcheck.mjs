import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function apiAddress(env = process.env) {
  const port = Number(env.NITRO_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("NITRO_PORT must be 1–65535");
  if (typeof env.VEGA_TOKEN !== "string" || env.VEGA_TOKEN.length < 16)
    throw Error(
      "Set VEGA_TOKEN to a random access token with at least 16 characters",
    );
  return `http://127.0.0.1:${port}/api/health`;
}

export async function connected(env = process.env) {
  const response = await fetch(apiAddress(env), {
    headers: { Authorization: `Bearer ${env.VEGA_TOKEN}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  return (await response.json()).connected === true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = (await connected()) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
