# DSH 0.2.3-alpha.1 核心升级审查

> **历史审查**。2026-11-23 复核确认，上游 alpha.2 已修复 Loader 导出缺失。CodeBuddy 图片契约仍需在 TUI 适配。本文保留 alpha.1 的验证记录，并更新 PTC 输出和搜索包名。 [alpha.2 实施方案](design-task-upgrade-dsh-0-2-3-alpha-2.md)

- 审查日期为 2026-11-22。
- TUI 基线为 `dsh-native-tui` 的 `main`（`9a930ae`），运行核心为 `0.2.2-rc.5`。
- 上游对比范围为 `dsh-v0.2.2-rc.5` 到 `dsh-v0.2.3-alpha.1`（`d98f5d685192`）。[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.1) · [上游差异](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.5...dsh-v0.2.3-alpha.1)

**结论。日用 TUI 继续使用 `0.2.2-rc.5`。** 隔离安装的 alpha.1 发布包在解析 Cordis Loader 导出时退出，TUI 单独更新依赖也会遇到 CodeBuddy 图片接口编译错误。下表的 Host 能力以依赖发布和 TUI 接入验收通过为前提。

## 随 Host 升级获得的能力

| 能力 | TUI 影响 |
| --- | --- |
| 切换模型后的上下文溢出恢复 | 挂载 `compaction-basic` 的预设可继承修复。自动恢复和 `/compact` 默认用最近成功回答的模型生成摘要。自动检查阈值公式和默认余量沿用原配置。 |
| 图片请求 | DeepSeek 官方路由获得并发上传、限流重试、超时退避及取消处理。pi 路由在发模型前按尺寸和编码字节硬上限缩图，保留原附件。CodeBuddy 有独立适配器，须同步迁移。 |
| 网页抓取和子代理 | `web_fetch` 返回更明确的网络失败原因，子代理模型选择与并发容量修复由 Host 提供。`/agents` 读 Host 的子代理服务。直接消费 `list_agents` 工具结果的脚本需改读 `result.agents`，容量来自 `running` 与 `limit`。 |
| Node PTC | 未显式配置运行模式时默认使用 scoped REPL，支持跨调用变量，并限制超量结果。迁移顶层 `return` 时，使用 `inspect(...values)` 输出模型需要读取的值。执行器省略函数返回值和末尾表达式值。需要原函数体语义的 profile 可显式设置 `executionMode: per-call`。Python PTC 已移除。 |
| 有条件生效 | MCP 按需加载配置为 `toolLoading: on-demand`，实验性 SQLite 需显式配置，默认存储仍为 JSONL。启用 HMR 的 profile 支持监听 `--patch` 覆盖文件。Git 插件源、连接器、`/office` 和 standard 预设的 `cordis_inspect` 需要 TUI 组合显式挂载。 |

## 可移植到终端的功能

| 顺序 | 功能 | 现有入口与接入方式 |
| --- | --- | --- |
| 1 | 完整压缩摘要 | [transcript 投影](../src/ui/transcript.ts#L530)已读取 `compaction/summary` 并截取 800 字符。沿用详情入口，按摘要事件序号读取完整内容，覆盖自动、手动、失败和中断状态。 |
| 2 | 会话输入历史与模糊搜索 | 编辑器已记录发送历史，`SessionDrafts` 保存未发送文本和附件草稿。补按当前会话召回已发送文本，覆盖恢复会话及草稿保护。评估复用上游 `@deepseek-ai/dsh-util-text-search`，支持 `/cpt` 找到 `/compact` 及按名称、路径选择工作区。 [输入历史](../src/ui/app.ts#L653) · [SessionDrafts](../src/ui/session-drafts.ts) |
| 3 | MCP OAuth 和 Git 插件源 | [MCP 命令](../src/ui/commands/mcp.ts)接入 Host 授权进度、取消与退出授权，凭据刷新留在 Host。[插件命令](../src/ui/commands/plugins.ts#L66)通过 `pluginMarket` 浏览已配置的 Git 索引，安装继续走 `pluginManager`。 |
| 后续 | 会话未读、任务树、审阅入口 | 复用上游会话状态和任务数据，接入 TUI 的会话选择器与详情界面。Web 的侧栏、拖拽、远程登录和渲染性能改动由其客户端负责。 |

## 修复清单

### P0 · npm 发布依赖

`dsh-app-boot@0.2.3-alpha.1` 导入 `EntryValidationError`，而审查时 npm 上满足 `@deepseek-ai/cordis-plugin-loader@~1.1.0` 的版本只有 `1.1.0`，其发布包缺少该导出。上游标签中的 vendor 源码含该导出，Loader manifest 仍声明 `1.1.0`。发布工作流用仓库构建的 vendor tarball 做安装验收，无法覆盖纯 registry 解析到的旧 vendor 内容。应发布匹配的 vendor 包并更新依赖范围，再用纯 registry 安装验证 CLI 和 profile 启动。[启动代码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.1/packages/boot/app-boot/src/index.ts#L17) · [发布验收](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.1/.github/workflows/release-publish.yml#L119)

### P0 · CodeBuddy 请求图片

[适配器](../src/codebuddy/adapter.ts#L278)和[实际附件读取路径](../src/codebuddy/wire.ts#L261)使用旧 `maxBytes`。两处应共享 Host 的新 `ImageRequestTarget`，提供 `maxImageBytes` 硬上限和 `imageTargetBytes` 软目标。同步验证真实附件缩图和请求载荷，保留原附件。已有 DeepSeek 模型覆盖如配置了 `imageMaxBytes`，迁移为 `imageTargetBytes`。pi 的每图硬上限沿用 `requestImageMaxBytes`，需结合新的总预算分摊检查。

### P1 · worktree 当前目录

用两个目录的同名文件复现了 `/open` 读错文件。[命令路径入口](../src/ui/commands/shared.ts#L9)和[状态栏](../src/ui/app.ts#L279)取会话创建目录，Host 工作目录切换后仍显示或读取原项目。相对路径命令、Git 分支和标题应从 `workingDirectory.get(session)` 读取当前目录，保留 header 目录用于原始项目归属。交付物和变更摘要按其记录的轮次目录解析。验证进入和退出 worktree、工作区写入审批以及旧会话恢复。包含 `workspace-root/change` 的日志会被旧核心拒绝读取，试升与回退使用独立会话副本。[工作目录事件说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.1/docs/persistence-changes/2026-11-13-workspace-root-change.zh.md#L38)

### P1 · 短片段反复压缩

[既有排障记录](troubleshooting-context-compaction.md)中的 `summary is not smaller than the shadowed content` 对应短历史片段摘要失败。alpha.1 对区间选取和摘要大小校验仍走原有路径，下一模型步骤可能再次请求同一个过小区间。Host 应在请求摘要前跳过明显不足以缩减的片段，并限制同一片段的重复失败，保留最终缩减校验。需用隔离 mock 复现多步骤压力，再对本地 Qwen 会话复测。[区间选取](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.1/packages/compaction/compaction-basic/src/region.ts#L118) · [摘要校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.1/packages/compaction/compaction-basic/src/region.ts#L405)

### P1 · MCP 状态、升级探针与 profile 校验

- 已用 Host 接口替身复现 `/mcp list` 对 `waiting-authorization` 输出 `undefined`。更新[状态渲染](../src/ui/commands/mcp.ts#L317)与[连接恢复](../src/runtime/mcp-recovery.ts#L96)，使等待显式 OAuth 授权与传输中断有各自的处理。
- 升级探针把目标写死为 `0.2.2-rc.1`，实测传 alpha.1 会提前断言失败。PTC fixture 还使用旧顶层 `return`。升级时从显式目标版本校验，使用 `inspect(...values)` 覆盖进入模型消息的实际工具结果，并验证会话恢复。 [升级探针](../scripts/upgrade-core-e2e.mjs#L14)
- 同步核对 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与四套 preset。用隔离 profile 验证 Loader 配置校验、`/reload`、模型与搜索授权、存量 MCP。自定义组合需要挂载 `deepseekAuth`，旧 profile 需清理已移除的 `tool-working-directory` 或 Python PTC 条目。

## 验证记录与放行条件

| 已执行 | 结果 |
| --- | --- |
| npm registry 元数据和隔离 pnpm 安装 | 确认 `@deepseek-ai/dsh@0.2.3-alpha.1` 已发布，Node `24.22.3` 满足要求。隔离 CLI 的 `node …/lib/bin.js --version` 复现 Loader 导出错误。 |
| 仅更换临时 TUI 副本的核心依赖 | `tsc -p tsconfig.json --noEmit` 在 CodeBuddy 图片契约处报 `TS2345` 和 `TS2416`。 |
| 临时适配 CodeBuddy 的图片契约 | 使用原 1 MiB 验证硬上限与软目标，类型检查、`tsc -p tsconfig.build.json`、Vitest 共 129 个文件、1,865 项测试通过。 |
| TUI 命令探针 | 用替身和临时文件复现了 worktree 下的 `/open` 错目录，以及 MCP 待授权状态的 `undefined`。这两项未在真实 alpha.1 Host 上运行。 |

升级放行需要纯 registry 安装启动通过，随后在独立 `DSH_HOME` 验证 standard、ptc、minimal、cordis 的新建、旧会话恢复、模型路由、适用预设的工具往返和 reload。另验收 worktree 目录、MCP OAuth、CodeBuddy 图片、模型切换溢出和短片段重复摘要。当前真实 Host 端到端检查受发布包启动错误阻塞。检查期间的依赖与代码试改均在临时副本中进行。
