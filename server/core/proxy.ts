import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EnvHttpProxyAgent } from "undici";
const exec = promisify(execFile);
type Settings = { httpProxy?: string; httpsProxy?: string; noProxy?: string };
const address = (s: string) => (s.includes("://") ? s : "http://" + s);
export function windowsProxy(text: string): Settings {
  const values = Object.fromEntries(
    [
      ...text.matchAll(
        /^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/gm,
      ),
    ].map((m) => [m[1], m[2].trim()]),
  );
  if (!values.ProxyEnable || Number(values.ProxyEnable) !== 1) return {};
  const server = values.ProxyServer || "",
    parts = Object.fromEntries(
      server
        .split(";")
        .filter((s) => s.includes("="))
        .map((s) => s.split("=")),
    );
  let http = parts.http || (!server.includes("=") ? server : ""),
    https = parts.https || (!server.includes("=") ? server : "");
  const noProxy = (values.ProxyOverride || "")
    .split(";")
    .filter((s) => s && s !== "<local>")
    .join(",");
  return {
    httpProxy: http ? address(http) : undefined,
    httpsProxy: https ? address(https) : undefined,
    noProxy,
  };
}
export function macProxy(text: string): Settings {
  const value = (name: string) =>
    new RegExp("^\\s*" + name + "\\s*:\\s*(.+)$", "m").exec(text)?.[1].trim();
  const settings: Settings = {};
  if (value("HTTPEnable") === "1" && value("HTTPProxy") && value("HTTPPort"))
    settings.httpProxy =
      "http://" + value("HTTPProxy") + ":" + value("HTTPPort");
  if (value("HTTPSEnable") === "1" && value("HTTPSProxy") && value("HTTPSPort"))
    settings.httpsProxy =
      "http://" + value("HTTPSProxy") + ":" + value("HTTPSPort");
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/m.exec(
    text,
  )?.[1];
  if (exceptions)
    settings.noProxy = [...exceptions.matchAll(/\d+\s*:\s*(\S+)/g)]
      .map((m) => m[1])
      .join(",");
  return settings;
}
export async function settings(): Promise<Settings> {
  const env = process.env,
    http = env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY,
    https =
      env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  let platform: Settings = {};
  if (!http && !https) {
    try {
      if (process.platform === "win32") {
        const { stdout } = await exec(
          "reg.exe",
          [
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
          ],
          { timeout: 2000, maxBuffer: 65536, windowsHide: true },
        );
        platform = windowsProxy(stdout);
      } else if (process.platform === "darwin") {
        const { stdout } = await exec("/usr/sbin/scutil", ["--proxy"], {
          timeout: 2000,
          maxBuffer: 65536,
        });
        platform = macProxy(stdout);
      }
    } catch {}
  }
  return {
    httpProxy: http || platform.httpProxy,
    httpsProxy: https || platform.httpsProxy,
    noProxy: [
      env.no_proxy || env.NO_PROXY || platform.noProxy || "",
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]
      .filter(Boolean)
      .join(","),
  };
}
let fingerprint = "",
  cached: EnvHttpProxyAgent | undefined;
export async function dispatcher() {
  const current = await settings(),
    key = JSON.stringify(current);
  if (!cached || fingerprint !== key) {
    const old = cached;
    cached = new EnvHttpProxyAgent(current);
    fingerprint = key;
    void old?.close();
  }
  return cached;
}
