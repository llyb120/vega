# 实时通道：HTTP + SSE

所有实时连接都是「下行 SSE + 上行普通 POST」。没有 WebSocket，也没有定时轮询：每条上行消息都是一次独立请求，每条下行消息一到达就写出。

## 共享约定

- 下行：`GET <path>` 返回 `text/event-stream`（`Cache-Control: no-store`、`X-Accel-Buffering: no`）。每条事件是一行 `data: <json>\n\n`，心跳是注释行 `: keepalive\n\n`（15 秒）。
- 车道（lane）：一条 HTTP 响应是一条有序字节流，一个大帧会挡住它后面的所有事件，所以每个通道由若干车道组成。
  - 车道 0 = 控制车道：`ready`、`mode`、`input_result`、`error`、`closed` 等，严格有序，永不拆分。
  - 车道 ≥1 = 数据车道：大载荷（截图帧、token 增量、客户端任务），可以分散，也可以按 key 粘在同一车道保序。
  - 打开车道 0 不需要 `channel`/`lane` 参数（缺省即 0），服务端建立通道后第一条消息固定是 `{"type":"channel","channel":"<id>"}`。
  - 打开车道 k≥1：`?channel=<id>&lane=k`，其余参数与车道 0 相同但不需要一次性票据（用 cookie/Bearer 重新验证同一个身份）。
  - 服务端要扩容时在任一车道上发 `{"type":"lane","open":k}`，对端随后打开该车道；缩容时发 `{"type":"lane","close":k}`。
  - 扩容时机：车道 0 的积压加上这条载荷达到高水位（512 KiB）时，服务端请求第一条数据车道；已有一条以上数据车道但全部积压时，再请求下一条。一次只请求一条，等对端打开或 5 秒放弃后才再请求。
  - 对端没打开数据车道时，数据载荷退回车道 0 发送（不能因为没扩容就丢画面）。
- 结束：服务端主动结束时每个车道最后一条都是 `{"type":"closed","code":<close code>,"reason":"..."}`。对端把 `code` 当作原来的 WebSocket 关闭码处理（4401 登录失效、4403 未授权、4429 连接过多、4408 网络拥堵、1000/1001 正常、1011 异常）。没有收到 `closed` 就断流，等同于 1006（网络中断），由调用方自己决定重连。
- 上行：`POST <path>`，body `{"channel":"<id>","message":{...}}`，返回 `{"ok":true}` 或 `4xx {"message":"..."}`。同一通道的上行消息按到达顺序处理。
- 车道数量上限由服务端按通道设置（浏览器截图/事件/客户端任务 3，中继隧道 1）。

## 各通道

### 事件 `/api/events`

- `POST /api/events` → `{ticket}`（不变，一次性、15 秒有效）。
- `GET /api/events?ticket=..&since=..&sessions=a,b[&channel=..&lane=n]` → SSE。
- 车道 0 用票据打开并消费票据；车道 ≥1 用 `channel` + cookie 重新验证同一身份。
- 订阅会话变化：页面用新的 `sessions` 参数重开车道 0（`since` 保留，服务端按游标补发），没有上行 POST。
- 数据车道：`text_delta`/`thinking_delta`/`tool_start`/`context_budget`，按 `session` 粘车道。

### 浏览器实时 `/api/chrome/live`

- `POST /api/chrome/live` `{tabTag}` → `{ticket}`（不变）。
- `GET /api/chrome/live?ticket=..[&employeeId=..][&channel=..&lane=n]` → SSE。
- `POST /api/chrome/live/input` `{channel, message}`（cookie + CSRF）→ 交给对应 `LiveSession.message()`。
- 数据车道：`{"type":"frame"}`。

### 本机客户端 `/api/local-agent/socket`

- `GET /api/local-agent/socket?lane=n[&channel=..]`（`Authorization: Bearer <设备凭据>`）→ SSE。
- `POST /api/local-agent/socket`（同一个 Bearer）`{channel, message}` → 交给 `ClientSockets.message()`。
- 数据车道：下发的任务（`transport.send(job)`），每个任务独立，可分散。

### 流量中继 `/api/local-agent/relay`

- `GET /api/local-agent/relay`（Bearer + `X-Vega-Relay: <flowId>`）→ SSE，**只有一个车道**（隧道字节必须严格有序，不扩容）。
- `POST /api/local-agent/relay`（Bearer + `X-Vega-Relay`）`{"data":"<base64 帧>"}` → 交给 `NetworkRelay.message()`；帧格式不变：`[0]<数据>`、`[1]<确认>`、`[2]<就绪>`。
- 下行数据：`{"type":"relay","data":"<base64 帧>"}`。

### 本机配对 `POST http://127.0.0.1:47673/agent`（桌面客户端本地端口）

- 网页用 `fetch(url, {method:"POST", headers:{"Content-Type":"text/plain"}, body: JSON.stringify({type:"auth",ticket,userId})})` 发起；`Origin` 头由浏览器自动带上，客户端仍按它做站点授权。
- 响应是 SSE：先 `authorizing`，再 `backend_connecting`，最后 `{"type":"paired","instance","userId","clientId","connected":true}` 或 `{"type":"status","code":...}`，随后流结束。语义与现在的 WebSocket 版本一致。
- CORS：响应必须带回 `Access-Control-Allow-Origin: <请求的 Origin>`（请求是 `text/plain` 的简单请求，不触发预检）。

## 部署与升级

- 服务端、网页与桌面客户端没有协议向后兼容：三者要一起换到本次提交。旧客户端连新服务端会在握手处报 `realtime channel rejected: <status>`；新客户端连旧服务端会报 `405 Method Not Allowed`。
- 看到 `GET /api/local-agent/socket`（或 `/relay`）返回 `405 POST required`，说明跑的还是旧服务端：旧版没有这两个 GET 路由，请求落到底座 `/api/[...path]`，那里第一句就是 `check(method === "POST", 405)`。同理旧版对 `/api/events` 的 GET 会返回 403。先确认服务端确实重建并重启，再查别的。
- 反向代理的要求（不缓冲 SSE、读超时高于 15 秒心跳、透传 `Authorization` 与 `X-Vega-Relay`）分别在 `README.md` 和 `local/README.md`。
