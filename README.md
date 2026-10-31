# Vega

Vue **3.6.0-rc.14 / Vapor** 前端 + **Nitro 2.13.5 / Node.js 24** 服务端。前后端一次构建、同源部署；业务状态保存于 **SQLite**，不依赖 Go、Rust、Tauri 或原项目目录运行。

## 运行

```powershell
npm ci
npm run build
$env:NITRO_HOST = '127.0.0.1'
$env:NITRO_PORT = '8080'
$env:VEGA_DB = 'D:/data/vega-nitro.db'
$env:VEGA_TOKEN = '<至少16个字符的随机访问令牌>'
npm start
```

访问 `http://127.0.0.1:8080`。首次打开时，使用`VEGA_TOKEN`（未配置则看启动日志中的初始化令牌）创建首个管理员，之后使用**用户名和密码**登录；初始化令牌不再能访问普通API。登录由HttpOnly、SameSite=Strict Cookie保存，固定12小时有效，刷新页面和服务重启后仍有效；改密码/停用/改角色会撤销旧登录。部署请复制**整个 `.output`**（包括 `server` 与 `public`），在部署机安装匹配平台的原生 `sharp` 依赖。`npm run dev` 启动 Nitro；单独开发前端可运行 `npm run dev:web`，其 `/api` 代理到本机 8080。

Node >=24.10，使用内置 `node:sqlite`，无需另装数据库。默认数据库为工作目录的 `vega.db`，支持通过 `VEGA_DB` 指定位置。**不会自动转换或覆盖 Go 版/原 Nova 的数据库**；检测到不兼容数据库会拒绝启动，请指定新文件。

## 账号、登录与权限

首次创建管理员后，进入「账号与权限」添加账号、停用/启用、调整角色或重置密码；没有开放注册，也没有内置默认密码。用户名3–64个英文字符/数字/点/下划线/连字符，密码至少12字符、最多256个UTF-8字节。密码采用随机salt的scrypt存储，Cookie中的随机会话令牌只以SHA-256摘要保存于SQLite，密码和登录Cookie不返回到账号列表。

| 角色 | 网站权限 |
|---|---|
| 管理员 `admin` | 系统配置、订阅/技能、数字员工、密码本、Chrome和团队管理；创建/停用账号、修改权限，查看全部会话，并授予其他账号会话只读权限 |
| 操作用户 `operator` | 通过网站新建和运行自己的对话/Stage/Fire，查看自己的任务结果；不能直接调用管理员专属网站接口。已提交任务的内部工具集与运行机制不按网页角色裁剪 |
| 只读用户 `viewer` | 只能查看管理员明确授权的会话、其图片和实时事件；不能发消息、停止任务、创建会话或执行工具 |

会话、Stage/fork/Fire衍生会话按创建账号归属，实时SSE和截图BLOB也校验会话访问权限；分享只授予查看，不授予执行。衍生会话继承创建时的查看授权，之后单独管理。旧版本无归属的会话/截图只有管理员可见，不会因升级自动公开给新账号。SQLite新增账号/登录表，升级前仍建议备份数据库。

注销只撤销本次网页登录。密码修改/管理员重置、角色变更或停用只撤销该账号的网站登录与实时查看连接，**不会取消或暂停任何已经提交的内部任务**；最后一个启用的管理员不能被停用或降级。内部agent、数字员工、定时任务和恢复流程不依赖是否有人在线，保持原工具集/执行机制；只有网站上明确调用停止/取消等业务操作才改变执行状态。登录有失败尝试和并发KDF限流，用户名或密码错误统一返回失败；网站修改API要求CSRF token并检查Origin，不依赖前端隐藏按钮。

**能够通过网站提交内部任务的账号必须可信**：网站RBAC只保护登录、页面/API和数据查看，不是内部agent的工具授权系统，更不是操作系统级多租户沙箱。内部bash/文件/MCP和员工工具保持原能力，可能访问同一容器或服务器。隔离不可信任务应单独运行容器/实例和数据卷，不能靠网页角色实现。只读用户没有提交任务或执行工具的网站入口。

### HTTPS与反向代理

公网部署必须使用HTTPS，配置`VEGA_PUBLIC_URL=https://vega.example.com`（仅origin，不带路径）。服务将使用Secure Cookie，并以该origin检查请求；不要信任任意客户端传入的Forwarded头。反代保留Host、关闭SSE缓冲。直接本地HTTP开发可不设置此变量，Cookie不会错误地带Secure导致无法登录。

原`VEGA_TOKEN`现在仅用于**首个管理员初始化**和只返回就绪/扩展连接状态的`GET /api/health`，不再是普通网站API的管理员后门。容器启动/健康检查已改用health入口，不需要保存网站账号密码；Token轮换不撤销SQLite中的账号登录。

## Linux / Docker 自动安装扩展

项目根目录的 `Dockerfile` 会在Linux内构建Nitro和原生依赖，并运行同容器的专用无头Chromium。启动参数自动加载现有扩展，等待配对后报告就绪；无需手工打开扩展管理页，只发布8080，不暴露CDP/回环桥接端口。SQLite、浏览器登录态与工作目录通过卷持久化。

```sh
docker build --pull -t vega:local .
docker run -d --name vega --shm-size=1g \
  -p 127.0.0.1:8080:8080 \
  -e VEGA_TOKEN='替换成至少16字符的随机令牌' \
  -v vega-data:/data -v vega-workspace:/workspace vega:local
```

这是**自动加载容器里的扩展，不会改宿主浏览器**。默认保留Chromium沙箱，宿主限制namespace/sandbox时会停止并报错，不静默降低安全性；数据卷和basic password store的浏览器登录态须保护。完整操作、权限和沙箱说明见 [`docker/README.md`](docker/README.md)。

## 本次迁移范围

| 模块 | 实现 |
|---|---|
| Lyra agent | 持久会话、流式文本/思考/工具事件、取消、执行中插入消息、模型重试/场景候选降级、工具最多 4 并发、1 基 `_after`、文件身份冲突与串行屏幕资源、只读模式、技能索引和 `/skill:name` |
| provider | OpenAI Chat Completions、Responses、Anthropic Messages；多工具分片、原生参数、厂商 thinking 格式、签名思考/无签名重试、缓存断点、图片历史、输出预算、代理动态切换 |
| Responses | 每会话 4 scope / 总计 512 的 30 分钟 continuation 缓存、前缀/认证指纹、lease 防旧请求覆盖、无效 previous_response_id 仅完整重试一次、场景/压缩后重置 |
| 本地订阅 | CodeBuddy、WorkBuddy、Devin 原生接入，及 Codex / Claude Code 只读 CLI 订阅或自定义 API；不是用通用 API 地址冒充专有协议 |
| 场景 / Stage | 场景在同一会话切模型、显式 caller follow-up；普通聊天结束/失败恢复原场景，员工同任务保留编码场景。Stage 独立历史，每轮引用来源的用户提示词和结论 |
| 上下文 | 自动摘要与 billion-context/acp-kernel 风格 ACP；稳定原子单元引用、45%/75% 压力/增长提醒、T1/T2/T3 精炼、92%/输入硬上限应急截断与机械轮廓、provider usage 实测锚点；原文/嵌套账本可逆，fork 复制账本但隔离状态 |
| 内置命令 | `/skill:name`、`/plan`、`/easy`、`/setup`、`/stage`；SQLite 配置虚拟路径有当轮显式授权/修改分区约束；`/fire ... /target ...` 为独立执行/验收链，最多20轮，可暂停/重启后显式续做 |
| 工具 | read / bash / edit / write / change_working_directory、同会话持久 MCP 渐进发现、Chrome、employee。**不提供 Polaris / Jianlai** |
| 数字员工 | 用户拥有的职责/备注、不定时/北京时间固定时刻/完成后间隔/动态检查，任务业务 key 去重，最多 3 并发、1 个电脑任务；完整计划、进度、审批、补充、挂起、续做、重新派发、任务时间线；星轨已按要求移除 |
| 员工会话 | 与普通聊天隔离：任务固定主会话 + 独立固定 Chrome 会话，仅从员工看板打开执行记录，不混入普通会话列表/默认选中项；relay 交接后结束本轮、结果自动回任务主会话；defer 保存恢复点、释放名额，到期只检查原作业 |
| 记忆 / 密码本 | 相关性检索、强化/衰减/永久重要性、300 条记忆上限；AES-256-GCM、使用条件/用途审计、X25519 跨机加密支援、任务专属临时条目与清理 |
| StarLink | 原 v2 HTTP + SSE 中转协议、群组/设备/纪元/游标、gzip 与旧 `_z` 信封、messageId 幂等重传、成员派单、交代人审批/补充、加密凭据支援与任务时间线 |
| Chrome | 原版 0.1.14 扩展与 DOM 脚本；稳定 tag、多实例/多浏览器、iframe/OOPIF、Shadow DOM、DOM/ref、真实 CDP 输入、焦点/遮挡/像素前检、截图分片/裁剪/长图、上传下载、DevTools、run 短程计划、经验图谱 |

这是所请求的 agent/provider/工具/Stage/员工与 Chrome 的迁移，不是整个 Nova 桌面产品的重做；桌面窗口、Jianlai、Polaris、原产品其它小应用发布/桌面装饰/会话漫游等不属于此应用。

## 配置模型

设置页通过表单管理服务商、接口地址、密钥和模型，支持获取/搜索/手动添加模型与修改能力、长度参数；场景模型通过下拉选择，支持档位和备用顺序，浏览器场景只显示图片模型。高级请求头/厂商参数按需展开。底层仍支持旧`provider.options.baseURL/apiKey/headers`与顶层写法、嵌套分类、`limit.context/output`、`modalities.input`和`variants`。密钥可用`{env:NAME}`/`${NAME}`引用；`__stored_secret__`保留已有密钥。经验图谱独立导航，设置排在最后；界面不再提供目录配置或技术机制说明。

```json
{
  "model": "openai/gpt-4.1",
  "provider": {
    "openai": {
      "api": "openai-completions",
      "options": {"baseURL": "https://api.openai.com/v1", "apiKey": "{env:OPENAI_API_KEY}"},
      "models": {
        "gpt-4.1": {"limit": {"context": 128000, "output": 8192}, "modalities": {"input": ["text", "image"]}}
      }
    }
  },
  "scenes": {"lightweight": ["openai/gpt-4.1"], "coding": ["openai/gpt-4.1"], "computer": ["openai/gpt-4.1"]},
  "contextMode": "auto",
  "mcp": {},
  "image": {"baseURL": "", "apiKey": "", "models": []}
}
```

场景数组按顺序降级；电脑场景须支持图片。变体 ID 为 `provider/model/variant/high`。厂商目录支持原项目的 30 个 preset，账号目录优先于 models.dev 能力补全；Coding Plan 等没有 `/models` 的端点可回退 models.dev，但不能用目录补回账号无权限模型。

### 专有订阅

设置 →「服务商」选择CodeBuddy/WorkBuddy/Devin，点击登录会立即打开窗口、绑定本次来源/站点并自动检查结果，成功后直接导入账号模型。远程Devin默认回调网站的`/api/providers/callback/devin`，不再要求用户浏览器访问服务器的127.0.0.1端口；公网部署需设置正确的`VEGA_PUBLIC_URL`并使用HTTPS。回调独立校验一次性state/PKCE，轮询绑定发起管理员，错误/过期state不能交换Token。若官方限制回调地址，可改用手动回调登录并粘贴登录后完整跳转地址。CodeBuddy/WorkBuddy使用服务端轮询，不依赖客户端本机安装CLI；仅在点击「读取服务端已有登录」时使用部署端已有凭据。网站新登录优先于部署端旧CLI会话。真实账号及第三方回调白名单仍需在目标部署验收，协议夹具不能代替它。

- **CodeBuddy**：CLI 环境/登录优先，缺少时使用应用内登录；续期、账号/企业请求头、`/v3/config` 和本地 product 默认模型合并、CLI 可用模型过滤、reasoning summary、重复工具 ID/包装 JSON 归一化。
- **WorkBuddy**：独立认证与模型目录，不能误用 CodeBuddy 的账号；自动查找 `resources/app.asar.unpacked/cli`，使用 WorkBuddy 自己的 Electron helper 只读解密登录。设置页可指定安装目录/`WorkBuddy.exe`/内置 CLI 路径；`WORKBUDDY_EXE` 可显式指定解密运行时。
- **Devin**：读取 CLI TOML 或应用内登录；直接执行 Connect/Protobuf 推理，校验 gzip 帧、trailer、停止原因与工具完整性；CLI 不可用时使用原项目的版本化模型快照。**Adaptive 自动路由与参考项目一样不支持，必须选具体模型。**
- **Codex / Claude Code**：按 CLI 配置识别自定义 API，否则在每次请求前只读订阅认证。官方端点固定，不执行 apiKeyHelper，不代替 CLI 轮换 refresh token；过期须先在 CLI 更新。macOS 支持原项目覆盖的钥匙串形态，其它 keyring 后端不会猜测。

支持原项目的 `CODEBUDDY_CONFIG_DIR`、`WORKBUDDY_CONFIG_DIR`、`NOVA_*_AUTH_FILE`、`NOVA_*_PACKAGE`、`*_MODEL`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DEVIN_CONFIG_HOME` 等定位方式。HTTP(S)/ALL/NO_PROXY 环境变量优先，否则读取 Windows/macOS 静态系统 HTTP(S) 代理，下一次请求重新判断；不跟随专有订阅请求的重定向。

### Chrome

1. Chrome 与 Nitro 桥接必须在同一电脑/回环环境，运行 Nitro。
2. 打开 `chrome://extensions`，开启开发者模式，加载项目 `extensions/nova-chrome`；部署产物在 `.output/public/extension/nova-chrome`。
3. 扩展按原固定 ID 自动配对端口 47653–47662。`NOVA_CHROME_PORT` 可指定单一回环端口。现有 Nova 和 Vega 可同时连接同一扩展，命令与回执按实例/客户端隔离。
4. 无痕操作须在扩展详情开启无痕权限；多浏览器同时连接时优先 Chrome。控制目标始终是已观察到的稳定 tag，不猜当前激活页。

只操控网页，**没有桌面工具或原生系统对话框能力**。截图/完整 DOM 与大输出可按返回的 `sqlite:` 路径回读；二进制存在 SQLite。文件上传限当前工作目录内的普通文件并校验真实路径。输入/提交超时会报告不确定性，不能自动重放。电脑任务使用服务端操作系统的只读空闲/锁屏信息（Windows Win32、macOS IOHID/CGSession、Linux loginctl）；锁屏或无法确认状态时保留排队，解锁后续做。执行中检测到新的用户活动/锁屏会让出资源、保留同一 Chrome 会话并进入冷却。网页心跳只作补充，不冒充 OS 状态；没有引入 Jianlai 或任何输入模拟。服务须运行在扩展所在的交互式用户会话中，Linux 须能读取图形登录 session 的状态。

### 浏览器查看与远程操作

管理员登录后点击左侧「浏览器」：选择tab后通过同源WS/WSS持续更新视口画面，不再等待每次操作后的单张截图。默认只查看，点击「远程操作」后可点击、双击、右键、连续拖动、滚动、文字输入与常用按键，也可前进/后退、重载及跳转HTTP(S)网址。手机默认滑动用于查看画面，拖动网页目标须选择拖动模式；中文/输入法可在文字框输入后发送，不自动回车。画面使用内存中的JPEG截图流，最高约10帧/秒，实际速度随页面、网络和扩展响应变化，**不是高帧率视频或桌面远程控制**。无需升级现有Chrome扩展。

WS连接先通过带CSRF校验的POST取得15秒有效、一次性且绑定管理员登录的票据；握手同时校验Cookie和Origin，注销/撤权会关闭已连接通道。慢客户端每次只保留一张待确认画面，不积压帧或点击；实时画面不写入SQLite。输入按连接序号去重，并校验用户实际显示过的帧、网页/视口和焦点，断线和结果不确定时不重放；原HTTP截图/操作接口仍保留，继续使用原像素校验规则。

手动控制期间独占共享Chrome操作锁，agent的后续Chrome操作等待，不取消任务；退出、断线、页面隐藏或30秒未操作会释放控制权，并在必要时松开鼠标。手动操作会使同页agent的旧观察失效，但纯查看不会覆盖agent的ref/截图。获取后台/最小化标签画面可能会显示Chrome窗口并切到该页。

远程部署仍只需现有网站端口。反向代理须为`/api/chrome/live`转发WebSocket的HTTP/1.1 Upgrade/Connection并保留Host；公网请配置正确的`VEGA_PUBLIC_URL`并使用HTTPS/WSS，**不要暴露Chrome调试端口或回环扩展端口**。断线后点击刷新重新连接，不自动补发上次操作。

### MCP、技能和团队

- MCP 配置为 `{"server": {"command":"node", "args":["server.js"], "env":{}}}` 或 `{"server":{"url":"https://example/mcp","headers":{}}}`。先 list → describe → call；定义变化须重新 describe。只读模式须由用户配置本地 `readOnlyTools` 允许列表，远端 `readOnlyHint` 不是授权。
- 不提供独立图片生成/改图服务。聊天附图、视觉模型、read图片和Chrome截图不受影响；旧图片服务配置不再使用，历史图片保留。
- 技能在设置页选择本地ZIP上传，不需要填写服务器目录；**正文和附属脚本/参考资源一起存入SQLite**，同名覆盖须确认。运行时按内容摘要物化可再生缓存，不自动运行导入脚本；拒绝目录穿越、链接和超限资源。原服务端目录/ZIP/SKILL.md导入API与`VEGA_SKILLS_DIR`仍保留供已有部署兼容，不在界面暴露目录配置。先展示元数据，按需读取正文，支持`/skill:name`。
- `relay: {"server":"https://relay.example","token":"{env:RELAY_TOKEN}","groups":"team-a"}` 接入原中转站。员工页 → 团队员工，只有公开的员工可接指令；对方的补充请求必须来自曾经交代过任务的成员。仅交代人可补充/审批其任务，凭据用密码本加密传回。

员工每天时刻、工作时段和`nextAt`统一按**北京时间 Asia/Shanghai**解释，列表中的日期也按北京时间显示；不再取服务器或浏览器本地时区。旧固定时刻职责升级后按北京时间运行；旧星轨数据保留，但事件职责不再触发，需改成手动/固定/动态安排。

界面适配手机与平板：小屏使用可展开的完整导航及会话列表，内容区独立滚动；触控按钮至少44px，表单输入保持16px以避免iOS自动放大，保留页面缩放。聊天手机回车换行、点击发送，桌面保留Enter发送并防止中文输入法误发；软键盘/地址栏变化按可视视口调整，刘海及底部安全区留白。服务商登录在本标签短期保存不含凭据的发起信息，切回或重载后继续同一次登录；服务端完成回执短期幂等，不重复交换授权码。浏览器截图可打开原图放大。移动回归使用独立Chrome触控模拟，覆盖320–1024px、横屏及键盘缩小视口；未进行iPhone/Safari、Android实体手机实机验收。

浏览器页只默认显示站点名，完整URL按需展开且限高；截图区自然纵向排布，标签栏独立横向滚动。禁用整体回弹只施加到页面边界，不对所有内层元素禁用滑动传递。移动回归包含长URL、40个标签、纵向/横向原生触屏滑动及“重新派发”的确认与取消，避免只检查DOM宽度却遗漏实际操作。

普通会话不依赖数字员工启用、工作时间或员工看板加载；普通聊天无需员工progress/relay流程。只有用户明确“交给员工”或管理员工数据时调用employee，派单不会把当前普通会话转换成任务。查看员工主/电脑记录使用独立只读页面，普通会话的历史和未发送内容保持原样；员工流式事件和错误不刷新或覆盖普通聊天，续做/审批/停止统一回员工看板。

## billion-context / ACP 与查漏记录

配置`"contextMode":"acp"`启用模型主动管理：模型收到稳定`[m00001]`引用与`<context-budget>`提示，用`compress`选择已完成单元并写摘要；可把`bN`作为边界精炼到T2/T3。`decompress`恢复原文及子块，`search_context`返回命中片段，`recall`按预算带回原文和工具配对，较长原文可用`read sqlite:message/序号`按行读取。账本、应急投影和token校准均保存在SQLite，不会覆写消息。

这是**历史虚拟化/分层压缩机制**，不是将模型原生窗口提升到十亿token。字符估算、图像占位成本和实测锚点之外的增长仍是估算；应急机械压缩会明确标注细节缺失，原文可回读。与所参考的Lyra一样，不实现上游kernel未被使用的young/old标签和默认关闭的按块数触发器。已有Vega数据库的旧块仍可恢复；新的压缩使用原子单元、至少40字摘要和70%收益校验，保护最近2个单元及未完成工具调用。

本轮还补上了：中断工具配对与孤儿修复、完成轮次OpenAI reasoning裁剪、每标签最近2份Chrome DOM投影、413旧图恢复、输出耗尽单次降思考且不重放工具、同会话MCP连接/describe状态保留、候选场景/同模型和只读路由、fork上下文账本、read的50KiB实际行边界与路径归一化。逐项来源和验收边界见`reference/parity-audit.md`。

`/setup`只允许更新provider/model/scenes；配置入口是`sqlite:config`，不会误改原Nova JSON文件。`/fire`是原客户端编排功能而非独立Lyra工具，现已接入Nitro持久工作流：独立验收，不将执行者自述当作证据，只由最后阶段续做，停止/错误/重启不自动重放外部操作。

## 安全与状态

工作台拥有服务端文件/命令/浏览器权限，**执行权限只给可信用户**，不是多租户沙箱。API使用账号Cookie认证、服务端角色/会话归属检查、CSRF/同源检查和请求/文件/流量预算，敏感配置脱敏返回。跨设备部署使用HTTPS并设置`VEGA_PUBLIC_URL`，反代保留`Host`并关闭SSE缓冲。

密码本与应用内订阅登录加密存于 SQLite。建议设置 `VEGA_VAULT_KEY` 为 32 字节 Base64 或 64 位 hex，并在数据库之外备份；不设置时随机生成并存在同一 DB，**只防误读/误传，不防拿到整个数据库的攻击者**。丢失外部密钥会使凭据不可恢复。普通 API 配置可以含明文密钥，优先环境变量引用。跨机 X25519 协议与原项目一样信任中转站不替换公钥，不具备带外身份认证。

任务中读取的密码只在当次运行的内存中供后续授权工具使用，写入会话/事件/计划前脱敏；原始 Token 不写进长期记忆。中断时会补齐不确定工具结果，续做不得自动重放外部提交；停止/失败/取消可以原任务续做，重新派发为新任务必须显式确认。

## 备份、参考与验收

重迁前的 Go 版备份：`D:/code/vega-go-backup-20261030-202628`，39 个文件逐一 SHA-256 一致，包含可执行文件和前端产物；排除了 `node_modules` 与 `.tmp` 缓存，清单在备份的 `BACKUP-MANIFEST.json`。

参考提交、文件摘要、原样移入资产的摘要在 `reference/`。运行时不依赖 `D:/code/nova-client-master`。Chrome worker/content/manifest/popup、隔离世界 DOM 脚本和工具 schema 保留原文；仅测试夹具修正了原目录路径、过期断言、显式扩展 reload 参数和清理定时器。工具注册时移除对被排除 Jianlai 的调用指引。

```powershell
npm run check
npm test
# 独立临时 profile 的真实 Chrome 验收
$env:VEGA_TEST_CHROME='1'
$env:VEGA_TEST_OS_PRESENCE='1'
# 默认自动发现 Chrome，也可设置 VEGA_CHROME_PATH；OS状态实机测试需交互式用户会话
npm test
# 构建产物 HTTP/SSE/SQLite 重启验收
npm run build
$env:VEGA_TEST_DEPLOYED='1'
npm test
```

测试覆盖原协议夹具、订阅隔离/PKCE/WorkBuddy 解密、三种标准流协议、Devin 原生工具往返、Responses 恢复、MCP stdio+HTTP、员工审批/交接/挂起、加密支援、上下文与真实 Chrome 的输入/上传/截图/提交。**没有使用真实付费订阅发起计费推理，也没有连接用户的真实团队生产中转站**，这些环境相关路径不应被自动测试数量冒充为实账号验收。

Vue 3.6 当前仍为 RC，已锁定版本；升级请复跑 Vapor 与浏览器测试。OS 状态已在 Windows 实机验证；macOS/Linux 只有适配器与契约测试，尚未在对应系统实机验收。生产依赖审计无已知告警；Nitro 构建链的 deepmerge 相关 3 个低危开发依赖告警暂保留，没有为消告警强行降级/破坏构建链。
