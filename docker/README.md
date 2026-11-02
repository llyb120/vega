# Docker：自动加载容器内 Chromium 扩展

镜像包含 Nitro、Linux 原生构建的前端/`sharp`、Debian Chromium 和现有 Nova Chrome 扩展。启动时先等 Nitro 就绪，再以独立持久化 profile 启动无头 Chromium，通过 `--load-extension` 自动加载扩展，无需打开扩展管理页。扩展的 manifest key 保留原固定 ID；启动器确认扩展已配对才报告就绪，健康检查也验证连接状态。

**这是容器里的专用浏览器，不是给宿主机或访问网页的客户端浏览器静默安装扩展。** 使用 Debian Chromium 而不是受近年扩展命令行限制影响的品牌版 Google Chrome，不篡改用户 Preferences，也不需要签名私钥或 Web Store 发布。

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

成功启动日志包含 `loaded and paired`。`healthy`通过专用`/api/health`检查服务和扩展连接，不登录网站、不持有管理员Cookie，也不执行网页输入或业务提交。

- 只发布 **8080**；扩展桥接固定在容器内 `127.0.0.1:47653`，不发布桥接或远程调试端口。
- `tini` 管理子进程；Nitro 或 Chromium 退出时容器会退出，Docker 重启策略可重新启动；SIGTERM 会关闭二者，不让孤儿浏览器留在后台。
- 不挂宿主机 X11/Wayland socket，不挂 Docker socket，不使用 `--privileged`。

## 客户端下载

镜像构建会在独立 Go 阶段交叉编译 Windows x64、Linux x64/ARM64、macOS Intel/Apple Silicon 五个客户端，并在前端构建前放入 `web/public/clients/`，最终随 Nitro 静态资源发布。登录后打开主导航「资源」即可下载；文件来自当前部署，与镜像内服务使用同一份源码，不依赖 GitHub Release，也不复制宿主机已编译的客户端。Windows 保留系统托盘和无控制台窗口，Linux/macOS 为命令行版本。Go 编译器不会进入运行镜像。

升级客户端前先退出旧进程。Linux/macOS 下载后需 `chmod +x 文件名` 再执行 `./文件名`；文件未签名，Windows/macOS 可能要求用户确认来源。首次在同一台电脑打开网站登录并确认本地站点授权，之后保持客户端运行即可。

## 数据和权限

| 路径 | 内容 |
|---|---|
| `/data/vega.db` | 会话、任务、配置与技能资源的 SQLite 权威存储 |
| `/data/chromium` | Chromium profile、cookie/登录态与扩展状态 |
| `/data/downloads` | 浏览器下载，使用受管策略关闭保存路径弹窗 |
| `/data/skill-cache` | 从 SQLite 技能资源再生的文件缓存 |
| `/workspace` | agent 的默认工作目录与代码/文件产物 |

重建或删除容器不会删除命名卷。不要用多个运行中的容器同时共享同一个 Chromium profile。浏览器登录态**不会自动导入宿主机**，在容器浏览器中登录后由 profile 卷保留；订阅 CLI 凭据同样不会从宿主机自动复制。

默认使用非 root 的 `node` 用户（UID/GID 1000）。命名卷会继承镜像目录权限；如改用 bind mount，先确保目录可由 UID 1000 读写，不要通过 root 启动或给整个宿主目录开放权限。要操作既有项目，可将 `vega-workspace` 替换为精确授权的项目 bind mount：

```sh
# 在上面的 docker run 中替换 /workspace 卷参数
--mount type=bind,src=/srv/my-project,dst=/workspace
```

所有工作台工具均在容器内运行，修改 bind mount 会直接改宿主文件。不要挂整个 home、SSH 目录、系统根目录或其他不相关凭据。

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
