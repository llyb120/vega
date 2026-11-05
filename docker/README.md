# Docker：自动加载容器内 Chromium 扩展

镜像包含 Nitro、Linux 原生构建的前端/`sharp`、Debian Chromium 和现有 Nova Chrome 扩展。只运行一个容器：受信启动器管理系统身份，网站服务降权为 UID 1000，云端文件工具、shell、技能、MCP 子进程和 Chromium 使用所属用户的独立 UID/GID。浏览器按需启动并自动加载扩展，不要求先启动公共浏览器。

**这是容器里的专用浏览器，不是给宿主机或访问网页的客户端浏览器静默安装扩展。** 使用 Debian Chromium 而不是受近年扩展命令行限制影响的品牌版 Google Chrome，不篡改用户 Preferences，也不需要签名私钥或 Web Store 发布。

## 字体

镜像内置常用字体，网页截图和导出 PDF 不出现方块字：Noto（含中日韩 CJK、等宽、彩色 emoji）、文泉驿微米黑/正黑、DejaVu、Liberation 与 Croscore（与 Arial/Times/Courier 等宽）、Carlito/Caladea（与 Calibri/Cambria 等宽）、Symbola（符号）。`docker/fonts.conf` 把网页常写的微软雅黑、PingFang SC、宋体、黑体、Segoe UI 等字体名映射到对应的 Noto 字体。

## 构建和启动（Linux）

在项目根目录执行：

```sh
docker build --pull -t vega:local .

# 首次生成访问令牌；保留已有文件，不要覆盖生产凭据。
if [ ! -e .env.docker ]; then
  (umask 077; printf 'VEGA_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env.docker)
fi

docker run -d --name vega --restart unless-stopped \
  --shm-size=1g \
  -p 127.0.0.1:8080:8080 \
  --env-file .env.docker \
  -v vega-data:/data \
  -v vega-workspace:/workspace \
  vega:local
```

访问 `http://127.0.0.1:8080`。首次使用`.env.docker`中的`VEGA_TOKEN`初始化管理员用户名和密码，后续使用账号登录并在「账号与权限」管理其他用户；此Token不再允许绕过账号访问普通API。Docker模式要求显式设置至少16字符的初始化/健康检查令牌，不能将真实密码写进镜像。跨设备访问使用HTTPS反向代理，并在`.env.docker`中设置`VEGA_PUBLIC_URL=https://你的域名`以启用Secure Cookie和精确Origin校验，不直接暴露无TLS的管理API。

```sh
docker logs vega
docker inspect --format '{{.State.Health.Status}}' vega
```

成功启动日志包含 `Per-user cloud execution ready`；`healthy`通过专用`/api/health`确认身份执行器可用。首次浏览器操作才启动该用户/牛马的 Chromium，并检查扩展连接。

- 只发布 **8080**；扩展桥接固定在容器内 `127.0.0.1:47653`，不发布桥接或远程调试端口。
- `tini` 管理子进程；Nitro 退出时停止执行器并退出容器。单个用户的浏览器退出不拖垮网站，后续操作按原恢复机制处理；SIGTERM 关闭执行进程组。
- 不挂宿主机 X11/Wayland socket，不挂 Docker socket，不使用 `--privileged`。

## 客户端下载

镜像构建会在独立 Go 阶段交叉编译 Windows x64、Linux x64/ARM64、macOS Intel/Apple Silicon 五个客户端，并在前端构建前放入 `web/public/clients/`，最终随 Nitro 静态资源发布。登录后打开主导航「资源」即可下载；文件来自当前部署，与镜像内服务使用同一份源码，不依赖 GitHub Release，也不复制宿主机已编译的客户端。Windows 保留系统托盘和无控制台窗口，Linux/macOS 为命令行版本。Go 编译器不会进入运行镜像。

升级客户端前先退出旧进程。Linux/macOS 下载后需 `chmod +x 文件名` 再执行 `./文件名`；文件未签名，Windows/macOS 可能要求用户确认来源。首次在同一台电脑打开网站登录并确认本地站点授权，之后保持客户端运行即可。

## 数据和权限

| 路径 | 内容 |
|---|---|
| `/data/vega.db` | 会话、任务、配置与技能资源的 SQLite 权威存储 |
| `/data/.vega-identities/users.sqlite` | 受信启动器独占的用户ID→UID/GID映射，SQLite/MySQL部署都必须保留 |
| `/workspace/.vega-users/<用户ID>/workspace` | 该用户的默认云端工作区，权限0700 |
| `/workspace/.vega-users/<用户ID>/home` | 私有 HOME，包含技能缓存、浏览器 Profile 和下载 |
| `/workspace/.vega-users/<用户ID>/tmp` | 私有临时目录，SSH 临时私钥正常结束/重启时清理 |
| `/data/chromium`、`/data/downloads`、`/data/skill-cache`、旧 `/workspace` 内容 | 旧数据原位保留，不自动迁移给某个用户 |

重建或删除容器不会删除命名卷。不要用多个运行中的容器同时共享同一个 Chromium profile。浏览器登录态**不会自动导入宿主机**，在容器浏览器中登录后由 profile 卷保留；订阅 CLI 凭据同样不会从宿主机自动复制。

网站账号仍在「账号与权限」创建。首次进入可执行工作台时自动分配 UID/GID（从10001起，避开已有系统账号），创建禁止交互登录的 `vega_u<UID>` 系统账号；重建镜像时按映射恢复，不回收旧 UID。用户私有目录外还有 root 拥有的组可遍历保护目录，因此任务不能靠 chmod 自己的工作区把它开放给其他用户。

入口需要容器内 root 管理身份，随后网站服务降权到 `node`（UID/GID1000），并将 HOME/USER/LOGNAME 设置为该服务账号，避免 CLI 配置探测误读 `/root`；任务清空额外组/capabilities并禁止提权。**不要覆盖入口或使用 `--user` 强制普通身份，也不需要 `--privileged`、Docker socket 或宿主机管理权限。** 身份执行器失败时请求报错，不以公共身份重试。云端 MCP 不继承或插值网站服务的环境变量；所需环境变量/凭据在对应牛马的 MCP 配置中显式提供。

升级前备份两个卷。启动器会收紧旧数据顶层条目的组/其他用户权限，保留内容和原属主；遇到顶层符号链接或未知 UID 的旧数据会拒绝启动，需管理员先处理。牛马的旧隐式服务端默认目录和沟通会话自动指向所属用户的私有工作区，聊天记录保留；已有任务绑定和显式项目路径不会自动转换，需确认文件归属后迁移，或在私有工作区新建任务。旧浏览器登录态也不会自动复制给新用户。

继续使用原来的两个命名卷即可；卷必须真实支持 POSIX UID/GID 和权限，设置后校验不符会拒绝启动。不要将多个服务共用的项目目录直接作为整个 `/workspace` bind mount：上述权限收紧会影响宿主文件。迁移既有项目应按用户 UID 放入其私有 workspace，保留身份数据库与工作区卷成对备份；不要挂整个 home、SSH目录、系统根目录或其他用户卷。

镜像构建后、挂生产卷之前可运行权限自检：

```sh
docker run --rm --entrypoint node vega:local /app/docker/isolation-check.mjs
```

该检查用临时目录验证不同 UID、文件/shell/符号链接/切目录越权拒绝、启动器不可访问、环境清理、浏览器管道、重启后身份稳定和身份数据库丢失时拒绝启动。Windows 单元测试不能替代此 Linux 检查。文件权限隔离不隔离网络、进程可见性、CPU/内存或内核；不要把凭据放在命令行参数里，强对抗代码仍需更强执行沙箱。

`/data` 中含会话、配置和敏感浏览器登录态。无桌面 keyring，Chromium 使用 basic password store；必须保护数据卷和备份，不能把本机加密当成数据库/卷被窃取后的保障。密码本可通过 `.env.docker` 设置独立 `VEGA_VAULT_KEY`（32字节 Base64 或64位hex），保存在数据库外，升级时保持不变。

## Chromium 沙箱

**默认保留 Chromium 沙箱，没有失败后自动加 `--no-sandbox`。** 宿主内核/容器运行时必须允许 Chromium 所需的 namespace/sandbox。某些 Docker 的 seccomp、AppArmor 或 user namespace 策略会拦截它；此时 Chromium 会退出，启动器会停止 Nitro 并报错，而不是假装扩展已安装。

优先按宿主安全策略允许非特权 Chromium 沙箱，不要直接授予 `--privileged` 或整个 `SYS_ADMIN`。如果只是隔离的可信测试环境，并且明确接受浏览器沙箱缺失的风险，可在启动参数中**显式**增加：

```sh
-e VEGA_CHROMIUM_NO_SANDBOX=1
```

此开关会在日志中告警。容器隔离不等于 Chromium 渲染器沙箱；关闭后访问恶意网页可能危及同容器的服务、数据库和挂载项目，不建议用于生产。

## 数字牛马与系统状态

启动器只给同容器 Nitro 设置 `VEGA_BROWSER_MODE=isolated`：该模式明确声明控制对象是容器私有 Chromium，没有可抢占的宿主桌面，因此不依赖 `loginctl`/锁屏状态、不弹桌面接管倒计时。普通 Linux/Windows/macOS 运行方式不变，仍按实际桌面状态排队。不要对连接真实用户浏览器的常规部署设置此变量。

## 更新和限制

重新构建镜像、保留数据卷后替换容器即可；扩展随镜像更新，下一次启动仍自动加载。镜像在 Linux 中执行 `npm ci` 和构建，不复制本机 `.output`/`node_modules`，避免把 Windows 的 `sharp` 二进制带进 Linux；`.dockerignore` 只允许构建输入，排除数据库和密钥。

无头镜像不附带 VNC/noVNC 桌面，也不能操作系统原生对话框。人工需要可视浏览器时应另行部署受控桌面，不能把这个镜像当作宿主浏览器的自动安装器。构建/启动需要能访问 npm、Go 模块代理和 Debian 软件源；Linux Chromium 的实际扩展加载与沙箱兼容性仍须在目标 Docker 环境验收。
