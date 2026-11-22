# 编码与浏览器阶段工具

轻量主控是唯一指挥官与证据裁决者：直接处理轻量查询、制定与更新计划（`task_progress`）、向用户求助/审批与最终交付（`task_complete`），不在主控直接调用 `chrome_*`，也不再暴露重叠的 `switch_scene`。

- **`code_agent({task})`**：整块委派编码、源码审查、深入排错与构建测试（模型模式或 `codex` / `antigravity` CLI 统一为隔离执行）。子阶段仅具备编码相关工具，不包含 `task_*`、`browser_agent`、`switch_scene` 或 `spawn_agent`。
- **`browser_agent({task})`**：委派真实浏览器渲染、交互、登录与截图取证（隔离执行）。子阶段仅具备 `chrome_*`、`read`（读存档）与密码本工具，**不提供通用 `bash`**；遇代理/网络超时、扩展不可用、短信验证码/2FA 或需用户审批时快速失败并以 `[BLOCKED]` 交回主控。

两个阶段不能互相调用；主控根据返回的结构化硬证据决定下一步（例如编码返回改动与单测退出码后再派发 `browser_agent` 验收；浏览器返回缺陷复现证据且原任务已授权修复时再派发 `code_agent`）。

在设置的场景页，选择 **编码 → 执行方式**，然后保存场景。`model`（默认）使用配置的编码模型；`codex`、`antigravity` 分别要求执行端账号的 PATH 中已有且已登录的 `codex`、`agy`。旧版桌面 IDE 的启动命令不能代替支持 `--print` 的 agy。轻量和浏览器仍使用各自配置的模型。

## 硬证据回执、查看与导出

无论模型模式还是 CLI 模式，`code_agent` / `browser_agent` 完成后都在主会话落一条紧凑的工具回执（主控上下文零污染、前缀缓存稳定），其中包含：

- `status`：`completed` / `blocked` / `error` / `interrupted_by_steer` / `queued`
- `executor`：`model/<selection>`、`codex` 或 `antigravity`
- `result`：专家的精简客观结论（不代写面向用户的长篇报告）
- `evidence`：由运行时直接从真实工具回执采集的不可伪造证据（`code_agent` 含 `filesChanged`、`commands` 及退出码、`failedCommands`；`browser_agent` 含 `visitedUrls`、`tabs`、`screenshots`、`documentPaths`、`errors`）
- `phaseSession`（模型模式）：独立落库的完整子阶段会话 ID，与主任务共享文件存档目录、浏览器标签与工作区写锁

会话时间线上每次委托对应一张可展开的阶段卡，展示结论、硬证据摘要、步骤清单（最多 80 项），并可一键打开对应的完整子阶段记录。调试会话的 JSON 导出保留主会话完整 `messages`、`agentPhases` 索引，并在存在隔离模型子阶段时附带 `phaseTranscripts`（按 `phaseSession` 索引完整子阶段消息，不污染主会话消息表）；旧版同会话阶段记录保持向后兼容。导出可能包含项目路径、命令参数和页面数据，分享前应检查。

CLI 只收到编码交接文本，不转发完整会话或 Vega 密码本。绑定客户端就在该客户端运行；隔离云工作区在该用户的隔离环境运行。CLI 使用自己的账号和供应商，启用前确认允许发送该项目数据。不会自动安装、登录、跨设备或换模型。每次交接为一次非交互执行，最长 10 分钟；超时或中断先检查工作区，不能据此认定没有写入。审批、网页操作和对外提交留给 Vega，不给 CLI 传入跳过权限的参数。
