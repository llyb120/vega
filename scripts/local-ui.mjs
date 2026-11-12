/**
 * The desktop window's page is embedded in the Go client, so it cannot import the web app's modules.
 * These two are pure, dependency-free renderers, and the client must draw exactly what the website
 * draws (same markdown, same bot faces); copy them with the `export` keyword stripped, then expose the
 * globals the client's classic scripts use (an extra shim instead of a hand-kept duplicate).
 * The avatar preset ids/colours come from shared/employee-avatars.ts so they cannot drift either.
 */
import { readFileSync, writeFileSync } from "node:fs";

function sharedArray(path, name) {
  const source = readFileSync(path, "utf8");
  const match = new RegExp(`export const ${name} = \\[(.*?)\\] as const;`, "s").exec(source);
  if (!match) throw Error(`${path} lost ${name}`);
  return match[1];
}

const shapes = [...sharedArray("shared/employee-avatars.ts", "BOT_AVATAR_SHAPES").matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]);
const colors = [...sharedArray("shared/employee-avatars.ts", "BOT_AVATAR_COLORS").matchAll(/id: "([a-z]+)", name: "[^"]*", hex: "([^"]+)"/g)].map((match) => [match[1], match[2]]);
if (shapes.length !== 18 || colors.length !== 12) throw Error("employee avatar table changed shape");

const shims = {
  "local/ui/bot-avatar.js": `
/* Global shim for the client's classic scripts: the module above only exports bare bindings. */
window.BotAvatar = (() => {
  const SHAPES = ${JSON.stringify(shapes)};
  const COLORS = ${JSON.stringify(colors)};
  const parseBotAvatar = (value) => {
    if (typeof value !== "string") return undefined;
    const match = /^bot:([a-z]+):([a-z]+)$/.exec(value);
    if (!match || !SHAPES.includes(match[1])) return undefined;
    const color = COLORS.find((entry) => entry[0] === match[2]);
    return color && { shape: match[1], color: color[0], hex: color[1] };
  };
  const defaultBotAvatar = (seed = "") => {
    let hash = 2166136261;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const color = COLORS[(hash >>> 8) % COLORS.length];
    return { shape: SHAPES[hash % SHAPES.length], color: color[0], hex: color[1] };
  };
  return { BOT_SHAPE_GEOMETRY, BOT_POSES, LOOK_POSES, MESSAGE_POSE, projectFace, shade, nextPose, holdDuration, blinkPlan, SHAPES, COLORS, parseBotAvatar, defaultBotAvatar };
})();
`,
  "local/ui/markdown.js": "\n/* Global shim for the client's classic scripts. */\nwindow.renderMarkdown = renderMarkdown;\nwindow.filesArchiveBase = filesArchiveBase;\n",
};

for (const [from, to] of [["web/src/markdown.js", "local/ui/markdown.js"], ["web/src/bot-avatar.js", "local/ui/bot-avatar.js"]]) {
  const source = readFileSync(from, "utf8");
  if (!/^export /m.test(source)) throw Error(from + " lost its exports");
  writeFileSync(to, "/* Copied from " + from + " by scripts/local-ui.mjs — do not edit. */\n" + source.replace(/^export /gm, "") + shims[to]);
  console.log("wrote " + to);
}
