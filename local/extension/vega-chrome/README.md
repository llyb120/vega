# Vega Chrome 扩展

Vega 自己的 Chrome 扩展。它只与 Vega 客户端配对：扩展身份（manifest `key` 决定扩展 ID）和本机回环端口段都独立于 Nova，两边同时安装也不会互相连接或抢占同一个浏览器。

## 加载

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选 `local/extension/vega-chrome`（部署产物在 `.output/public/extension/vega-chrome`，资源页也能下载 ZIP）。
3. 启动 Vega 本机客户端（`vega-local`）；扩展自动连接，无需地址、配置文件或密钥。
4. 点扩展图标只显示当前激活页的 tag，点「复制 tag」后发给 Agent。所有标签默认允许操作，无需逐页授权。

客户端的「连接授权 → 浏览器扩展 → 更新浏览器扩展」可以把扩展重新装到本机 Chrome：客户端把内置的扩展文件解压到自己的数据目录，再让一个牛马在电脑会话里用 appuse 打开 `chrome://extensions` 加载它。

## 身份与端口

- 扩展 ID 由 `manifest.json` 的 `key` 决定，当前为 `bhiemmbmefifaloapbcopihahhckolce`。客户端（`local/browser.go`）和服务端桥接（`server/core/chrome-bridge.ts`）只接受这个 Origin；换 key 必须同步这两处。
- 客户端监听 `127.0.0.1:47753–47762` 里第一个空闲端口。Nova 的扩展只发现 `47653–47662`，Vega 的扩展只发现 `47753–47762`，因此扩展不会连到对方客户端。
- 配对时桥接必须返回 `{"app":"vega"}`；没声明的端口（例如别的本机程序）一律忽略：不轮询、不发命令。
- `VEGA_CHROME_PORT` 可指定单一回环端口（0 表示系统分配，仅供测试）；扩展只自动发现上面这段默认范围。
- 断线、新启动的实例每 30 秒重试一次；打开扩展弹窗也会触发发现。命令结果只回传给发起它的实例，单条命令串行执行。
- `version` 随扩展升级递增：客户端读到更高的版本会把扩展自身重载一次。

## 能力

整页 DOM、iframe、滚动区域、整页分片截图、点击、填写、键盘、滚动、拖动、等待、多标签与导航、下载查询、DevTools 记录。`chrome_act` 等工具返回最新观察供验证并继续。没有辅助模型，不使用 Playwright，不依赖 `9222` 远程调试端口（CDP 走 `chrome.debugger`）。

## 测试

```sh
node --test local/extension/vega-chrome/worker.test.mjs
```

测试用模拟 `chrome` 命名空间覆盖轮询、断线重连、不重放、截图缩放、DevTools 与无痕窗口；真实 Chrome 的端到端验证需另装扩展。
