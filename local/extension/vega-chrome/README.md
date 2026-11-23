# Vega Chrome 扩展

Vega 自己的 Chrome 扩展（v0.2.5）。它只与 Vega 客户端/服务端配对：扩展身份（manifest `key` 决定扩展 ID）和本机回环端口段都独立于 Nova，两边同时安装也不会互相连接或抢占同一个浏览器。

## 加载

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选 `local/extension/vega-chrome`（部署产物在 `.output/public/extension/vega-chrome`，资源页也能下载 ZIP）。
3. 启动 Vega 本机客户端（`vega-local`）；扩展自动连接，无需地址、配置文件或密钥。
4. 点扩展图标只显示当前激活页的 tag，点「复制 tag」后发给 Agent。所有标签默认允许操作，无需逐页授权。

客户端的「连接授权 → 浏览器扩展 → 更新浏览器扩展」可以把扩展重新装到本机 Chrome：客户端把内置的扩展文件解压到自己的数据目录，再请一位热心市民在电脑会话里用 appuse 打开 `chrome://extensions` 加载扩展。

## 身份与端口

- 扩展 ID 由 `manifest.json` 的 `key` 决定，当前为 `bhiemmbmefifaloapbcopihahhckolce`。客户端（`local/browser.go`）和服务端桥接（`server/core/chrome-bridge.ts`）只接受这个 Origin；换 key 必须同步这两处。
- 客户端监听 `127.0.0.1:47753–47762` 里第一个空闲端口。Nova 的扩展只发现 `47653–47662`，Vega 的扩展只发现 `47753–47762`，因此扩展不会连到对方客户端。
- 扩展先轻量探测 `GET /health`（要求 `ok === true && app === "vega"`），再通过 `POST /pair` 获取一次性会话令牌，随后升级持久 WebSocket `/ws?clientId=...&token=...` 并从宿主下发单一真相 `page_runtime.js`；若仅配对 HTTP 测试桥接，自动回退 `/poll` + `/reply`。
- `VEGA_CHROME_PORT` 可指定单一回环端口（0 表示系统分配，仅供测试）；扩展只自动发现上面这段默认范围。
- 断线后指数退避重连，打开扩展弹窗也会触发发现。单条命令串行执行且永不自动重放。
- `version` 随扩展升级递增：宿主在 `hello` 消息携带更高版本号时，扩展自动重载一次。

## 能力

通过 1-RTT 复合浏览器原语提供统一指针驱动的页面观察（视口 DOM、SVG/图标语义、iframe 与浮层提升、主滚动容器识别、JPEG 截图）、拟人化平滑光标动画、`browser_act` 多步原子动作、轻量页面脚本执行、`browser_debug` DevTools 控制台与网络抓包，以及保留的原始 `cdp` / `set_proxy` 与 miniapp 启动器支持。

## 测试

```sh
node --test local/extension/vega-chrome/worker.test.mjs
```
