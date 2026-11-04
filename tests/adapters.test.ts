import { test } from "node:test";
import assert from "node:assert/strict";
import { windowsProxy, macProxy } from "../server/core/proxy";
import { normalizeAction } from "../server/core/browser-actions";
import { estimate } from "../server/core/context";
test("system proxy adapters parse platform settings and protocol-specific bypasses", () => {
  const win = windowsProxy(
    "    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891\r\n    ProxyOverride    REG_SZ    *.example.test;<local>\r\n",
  );
  assert.equal(win.httpProxy, "http://127.0.0.1:7890");
  assert.equal(win.httpsProxy, "http://127.0.0.1:7891");
  assert.match(win.noProxy!, /example.test/);
  assert.deepEqual(windowsProxy("ProxyEnable REG_DWORD 0x0"), {});
  const mac = macProxy(
    "  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7890\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7891\n ExceptionsList : <array> {\n 0 : *.local\n }",
  );
  assert.equal(mac.httpProxy, "http://127.0.0.1:7890");
  assert.equal(mac.httpsProxy, "http://127.0.0.1:7891");
  assert.equal(mac.noProxy, "*.local");
});
test("Chrome action validation rejects the whole invalid batch before any input", () => {
  assert.deepEqual(
    normalizeAction({
      type: "press",
      frame: 0,
      ref: "ignored",
      key: "Ctrl+Shift+ArrowDown",
    }),
    { action: "press", key: "Ctrl+Shift+ArrowDown" },
  );
  assert.equal(normalizeAction({ action: "wait" }).ms, 250);
  for (const a of [
    { action: "fill", ref: "r" },
    { action: "fill", ref: "r", text: 5 },
    { action: "scroll", delta: 1201 },
    { action: "wait", ms: 10001 },
    { action: "press", key: "X" },
    { action: "click_at", x: NaN, y: 1 },
    { action: "drag", x: 1, y: 1, to_x: 2, to_y: 2, duration_ms: 2000 },
    { action: "click", ref: "r", invented: true },
  ])
    assert.throws(() => normalizeAction(a));
  assert.equal(
    estimate({ images: [{ mime: "image/png", data: "a".repeat(1 << 20) }] }) <
      2000,
    true,
  );
});
