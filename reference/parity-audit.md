# Lyra 机制查漏与补齐

参考版本：`nova-client-master` 提交 `70435a97747086c0e4517d9116b6f6ccd59b15e0`。本清单区分“具有同名入口”“接入真实执行路径”和“实账号/实环境验证”，不能用测试数量替代外部联调。

## 本轮确认并补齐的遗漏

| 对照原入口 | 原遗漏 | 当前接入及验证 |
|---|---|---|
| `lyra/context/acp.rs::acp_view/units/apply_range` | ref 未注入出站消息，保护尾部按固定消息数而非原子单元，摘要无收益门槛 | 稳定 m 引用；用户单元、完整工具调用/结果及结论单元；最近2单元/最早未闭合调用保护；摘要>=40字、替换视图<=70%；相交块整块并入、各范围独立提交；验证哈希失效时回退原文 |
| `acp_nudge/tier_groups` | 没有压力/增长节奏和T1/T2/T3提示 | 45%/75%压力带、50k增长参考、22.5k低水位节奏、每层提示戳持久化；选择原文压缩或块摘要精炼，压缩成功清空戳；专项测试实际覆盖T2/T3选择 |
| `acp_emergency` 与 `turn::run_turn_inner` | ACP逼近窗口或上游溢出时直接失败 | 92%/预留输出+256协议余量硬上限；先缩短旧工具输出、再机械轮廓；明确 degraded，不推断成功；固定开销或受保护工作不可释放时停止，不循环盲重试 |
| `context::record_usage/prompt_tokens` | 只有字符估算 | provider input/cacheRead/cacheWrite实测锚点+增量估算；模型/档位/传输配置改变重置；账本和校准SQLite持久化；状态明确显示估算/锚点是否适用 |
| `context::compact` | 自动模式对过大历史用一次摘要请求 | 分批有界摘要，限制摘要输出，保留当前投影而不展开旧块/图片；摘要失败才走明确的应急轮廓；取消不继续摘要 |
| `history::for_prompt` | 未完整修复孤儿/缺失工具结果，旧DOM一直重送 | 发送投影补不确定结果、移除孤儿，裁剪已完成OpenAI reasoning和同tab旧DOM；原始消息、工具状态和documentPath不改写 |
| `turn` 的413与output recovery | 请求体超限和思考耗尽缺少各自恢复分支 | 旧图投影只恢复一次；输出长度耗尽只临时降低/关闭思考一次，120s上限；不执行截断工具，不重放已完成工具，不改全局模型设置 |
| `skills::install_skill_path/install_skill_zip` | 仅导入单个SKILL.md，脚本/资源相对路径失效 | 目录/ZIP/SKILL.md整包导入，资源BLOB入SQLite，按摘要物化可再生缓存；同名覆盖确认；支持默认Nova/Lyra技能目录只读发现；拒绝穿越/链接/大小和数量超限，不自动执行导入脚本 |
| `prompt::load_skills/expand_skill_command` | ACP ref前缀会挡住 `/skill:name`；切cwd后索引未刷新 | ref兼容显式skill调用；按描述先读正文；每个请求重新加载当前cwd技能与AGENTS；资源根目录随索引提供 |
| `mcp::McpSession` | 每轮结束关闭连接、describe状态不能跨轮保持 | 按会话+配置+cwd保留客户端/发现状态；并发初始化归一；配置/cwd改变、取消/删除/服务关闭释放；定义变化仍须重新describe；只读仍需本地允许表 |
| `scene::Routing` | 暴露不可用场景/同模型重复切换，只读分析无法借coding | 只列可用coding/computer目标；栈内场景不重入；无效候选可跳过；同模型不额外请求；只读切换不提升文件/命令权限；员工电脑仍必须隔离relay |
| `runtime::fork_session/rollout` | fork仅复制消息，不复制压缩账本 | fork复制块/嵌套关系与投影，清除模型usage/continuation，恢复块不影响来源；不继承员工任务或Fire流程身份 |
| `read.rs` | 读文件截断后 nextOffset 会跳过未交付正文 | 2000行/50KiB有界交付；nextOffset基于实际行边界；超长首行明确报告且不跳过；@/home/原版文件名变体定位 |
| `turn` 主循环 | 人为80步上限会中止原版允许继续的长轮次 | 移除人为上限；保留每步取消检查、provider重试次数、屏幕互斥与工具依赖保护；长轮次专项检查不触发额外真实模型费用 |
| `src/builtinPrompts.ts`、`store.ts::tryBuiltinPrompt` | plan/easy/setup/image命令未接到B/S配置和工具 | 恢复提示词展开；setup只可在当前用户显式授权下写SQLite虚拟配置，且限制修改分区；模型/图片API密钥脱敏保留；参考图按附件顺序准备可读本地缓存 |
| `store.ts::startFireRelay/advanceFireRelay` | 客户端Fire独立工作流未迁移 | Nit​ro持久化执行/独立验收链；/target逐项验收、最后一行判据、最多20次；只由最后阶段续做，旧阶段不分叉；停止/错误/重启暂停，不自动重放外部操作 |
| 相关界面 | 后端能力不等于可见可用 | Vapor设置页整包技能/覆盖确认，聊天页上下文状态/应急降级提示、Fire阶段切换与停止，配置保存后刷新模型 |

## 保持已有实现并复核的范围

- 三种标准provider协议、CodeBuddy/WorkBuddy/Devin原生认证/目录/推理、Codex/Claude只读登录、Responses lease/continuation、原生thinking格式和代理策略。
- read/bash/edit/write、最多4并发、`_after`、文件身份互斥、工具参数验证、MCP、图片生成/编辑、原Chrome扩展与隔离世界脚本。
- Stage独立历史引用、普通场景恢复/员工保留编码场景、取消、steer、SQLite存储、中断后的工具不确定性记录。
- 员工职责/任务/星轨/记忆、ask/help/defer/relay、原任务续做、密码本本地和跨机加密、StarLink原v2协议与用户归属。

## 有意差异与验证边界

- m引用以Vega SQLite的1起始seq编号；原Rust使用0起始下标。引用在Vega内部稳定，不需要转换原Nova私有数据库；旧Vega块ID继续可恢复。
- SQLite是会话/投影/资源的权威存储；技能/输入图片的物化文件只是可再生缓存，不覆盖用户源目录。ZIP/目录导入有安全预算，依赖和`.env`等非技能资源不打包。
- billion-context指可逆历史虚拟化，不是给模型提供十亿token的原生窗口；源Lyra也未实现kernel未使用的young/old标签与默认关闭的按块数触发器，本迁移同样不添加。
- 仅在完整结果验证后执行工具；不复刻原Rust“流尚未结束时提前派发read”的延迟优化。这不会少工具功能，避免失败流被误当作成功。
- 按用户要求不提供Polaris/Jianlai；Nova其它桌面外壳、会话漫游、时间机器和小应用发布不是Lyra agent/provider/工具/Stage的内部实现。Fire虽是客户端编排，本轮也补齐了，不以它冒充原生agent工具。
- Windows OS空闲/锁屏、独立Chrome和实际Nitro部署可本地实机验证。macOS/Linux未实机；真实付费订阅、真实图片计费服务、生产StarLink未联调，协议夹具不能替代这些验收。

关键回归位于 `tests/acp*.test.ts`、`context-regression`、`migration-gaps`、`skills-bundle`、`fire`，并复跑原有provider/员工/Chrome/部署测试。此文件只列已核对的源入口与明确边界，不承诺未来源版本中的未知功能自动等价。
