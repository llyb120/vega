# Vega 桌面客户端（Wails）

用 Wails 包一层现有的 Vega 网页，做成 Grok Bot 那样的桌面聊天窗口：左侧牛马列表，右侧对话。

本机托盘客户端 `local/`（vega-local）不会被替换。配对、Master、桌面操控和蝴蝶气泡仍然走它；这个窗口只负责聊天。

## 运行网页新布局（不启动 Wails）

在仓库根目录：

```bash
npm run dev:web          # 前端，/api 代理到本机 8080
npm run dev              # 另开一个终端跑 Vega 服务（默认 8080）
```

浏览器打开 Vite 提示的地址，即可看到新的左右栏布局。

## 运行 Wails 桌面窗口

需要本机已安装 Go 1.22+（推荐 1.26/1.27）和 Wails CLI：

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
export PATH="$(go env GOPATH)/bin:$PATH"
```

Linux 还需要 GTK3 与 WebKitGTK 4.1 的开发包，例如 Debian/Ubuntu：

```bash
sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev
```

然后在 `desktop/` 里：

```bash
cd desktop
# Debian/Ubuntu 13 等只有 WebKitGTK 4.1 的系统需要加上 -tags webkit2_41
wails dev -tags webkit2_41
wails build -tags webkit2_41   # 输出在 desktop/build/bin/
```

若发行版仍提供 `libwebkit2gtk-4.0-dev`，可以省略 `-tags webkit2_41`。

和本机托盘客户端一样，正式使用请从网站「资源」页下载安装包（ZIP）。包里除了可执行文件，还有本站的 `instance.json`；解压后一起放在同一目录再启动，窗口会直接打开这个站点，不用填写地址。缺少 `instance.json` 时会拒绝启动，请回到站点重新下载，不要只拷走可执行文件。

本地开发可以在 `desktop/` 下放一份 `instance.json`，或设置环境变量后启动：

```bash
export VEGA_ORIGIN=http://127.0.0.1:8080
wails dev -tags webkit2_41
```

把编译产物放到网站的客户端目录后，下载接口会按站点打 ZIP（例如 `web/dist/clients/vega-desktop-windows-amd64.exe`）。

## 编译 Windows（windows/amd64）

在 Linux 或 Windows 上都可以交叉/本机编译可执行文件：

```bash
cd desktop
wails build -platform windows/amd64
```

产物在 `desktop/build/bin/vega-desktop.exe`。在 Windows 上运行需要已安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 一般已自带）。

如需生成 NSIS 安装包，在 **Windows** 上加 `-nsis`（需要已安装 [NSIS](https://nsis.sourceforge.io/)）：

```bat
cd desktop
wails build -platform windows/amd64 -nsis
```

在 Linux 上加 `-nsis` 会因为没有 NSIS 而跳过或失败，但不影响 `.exe` 本身。

## 和现有仓库的关系

- 前端还是 `web/src`，不要在 `desktop/` 里再写一套聊天页。
- 桌面模式通过 `window.__VEGA_DESKTOP__` / `window.runtime` 识别，标题栏右侧会出现最小化、最大化、关闭。
- 不要改 `local/`。
