# DSH 0.2.3-alpha.2 核心升级实施方案

> 2026-11-23 实施。升级前 TUI 基线为 `main`（`9a930ae`），运行核心为 `0.2.2-rc.5`。
> 升级目标为 `0.2.3-alpha.2`。 [上游版本对比](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.5...dsh-v0.2.3-alpha.2)

## 结论

- alpha.2 已修复 Loader 发布包的 `EntryValidationError` 导出并通过隔离安装的 CLI 版本检查。CodeBuddy 图片契约和 Cordis 根 context 访问属于本仓库的 P0 适配项，须与依赖一起交付。 [alpha.1 历史审查](design-task-upgrade-dsh-0-2-3-alpha-1.md)
- 放行以 registry 安装的 alpha.2 Host、实际 TUI 安装包和 rc.5 会话副本为准。TUI 同步修复 worktree 和 MCP 状态，交付 MCP OAuth 及压缩摘要全文。
- 短片段反复压缩保留为已知上游问题。本轮记录复测结果并验证模型切换后的上下文溢出恢复。

## 事实基线（2026-11-23 核验）

| 事实 | 结果 |
| --- | --- |
| CLI 发布包 | Node `24.22.3` 下，alpha.1 解析到 Loader `1.1.0` 并因缺少 `EntryValidationError` 退出。纯 registry 安装的 alpha.2 解析到 `1.2.0-alpha.1`，`--version` 返回 `0.2.3-alpha.2`。 |
| alpha.2 运行时 | Cordis `~4.2.0-alpha.1`、Schemastery `~3.20.0-alpha.1`、plugin-loader/include/group `~1.2.0-alpha.1`、timer `~1.3.0-alpha.1` |
| alpha.2 Node | `^24.22.3 \|\| >=26.13.1` |
| TUI 临时副本类型检查 | 接入 alpha.2 发布包后，CodeBuddy 的旧图片类型报 `TS2345` 和 `TS2416`，`src/index.ts` 的 `ctx.root` 报 `TS2576`。运行时验证根 context 可通过 `ctx[Context.root]` 读取。 |
| 模糊搜索 | registry 已发布 `@deepseek-ai/dsh-util-text-search@0.2.3-alpha.2`。 |
| `workingDirectory` | `@deepseek-ai/dsh-working-directory` 提供 `get(session)`，由 `dsh-base` 挂载 |
| 交付物导出 | 用原目录和 worktree 各一份同名文件复现。只以 worktree 为 ZIP 的校验根时，原目录的交付物被跳过。 |
| 图片契约 | `ImageRequestTarget` 使用 `maxImageBytes` 和 `imageTargetBytes`，计量的是图片编码产物。 |
| MCP 授权 | 在 alpha.2 的 `dsh-base` 加 MCP manager 的隔离 profile 中，`startAuthorization` 因缺少 `webServer` 拒绝启动。 |
| PTC | 默认 scoped REPL 拒绝顶层 `return`。执行器省略函数返回值和末尾表达式值，用 `inspect(...values)` 输出模型需要读取的结果。 |
| 配置检查 | 无效的工作目录配置可以经 `--dump-config` 正常输出，实际启动时出现插件未激活诊断。 |
| 压缩 | alpha.2 仍执行“摘要不得大于被遮挡内容”校验，短片段问题未修 |

## 目标与非目标

### 本轮目标

1. 对齐依赖、lockfile、`minimumReleaseAgeExclude`、Node 与 CI，完成 Cordis 退出和 CodeBuddy 图片迁移。
2. 修复 worktree 目录、MCP 待授权状态与恢复，交付压缩摘要全文和 MCP OAuth。
3. 固化 registry 安装、四预设的打包产物启动及 rc.5 会话恢复验收，更新 README、AGENTS.md 和实施记录。

### 非目标

- 代码改动限于 TUI 仓库，安装与验收使用隔离 CLI 和 profile。
- 会话历史召回、模糊搜索、Git 插件源浏览、未读/任务树/审阅入口放到步骤 8 的后续批次。
- 不 commit、不 push、不打 tag；发布需用户另行确认。

## 实施步骤

先执行步骤 2 验证目标 CLI。步骤 1 与步骤 4 合并为一个可编译批次，完成后推进步骤 3、5、6、7。步骤 9 随实施和验收更新。步骤 8 独立排期。

### 步骤 1 · 依赖对齐与 Cordis 退出

- 在 `package.json` 中将 TUI 版本和全部 `@deepseek-ai/dsh-*` 直接、peer 及开发依赖对齐至 `0.2.3-alpha.2`。`@deepseek-ai/schemastery` 使用 `3.20.0-alpha.1`。`@deepseek-ai/cordis` 的 peer 范围使用 `~4.2.0-alpha.1`，开发依赖固定在 `4.2.0-alpha.1`。`engines.node` 改为 `^24.22.3 || >=26.13.1`。
- 在 `pnpm-workspace.yaml` 中同步 77 条 rc.5 的 `minimumReleaseAgeExclude`。Cordis 使用 `4.2.0-alpha.1`，plugin-loader/include/group 使用 `1.2.0-alpha.1`。根据锁文件同步 Schemastery `3.20.0-alpha.1`、timer `1.3.0-alpha.1`、Cosmokit `1.10.0-alpha.1` 及新增预发布依赖。
- 在 `.github/workflows/ci.yml` 和 `.github/workflows/release.yml` 中将 `node-version` 固定为 `24.22.3`。
- `pnpm-lock.yaml` 由 `pnpm install` 生成，不手改。
- `src/index.ts` 的退出回调通过 `ctx[Context.root].fiber` 获取根 fiber，并将 `Context` 改为运行时导入。沿用退出码、清理完成后退出和超时兜底，覆盖下文 CodeBuddy 图片迁移后再验收本批次。

修改清单后执行 `pnpm install` 生成锁文件。解析新预发布依赖时可临时用 `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0`。用 `pnpm why @deepseek-ai/cordis` 和 `pnpm why @deepseek-ai/schemastery` 核对两者各自只解析一个目标版本。

先执行 `pnpm check`，再用真实 Host 探针验证正常退出和根 fiber 清理，覆盖 `/reload` 后退出。需要检查合成配置时，在临时 profile 中使用 `--dump-config`。插件激活与配置诊断以实际启动为准。

### 步骤 2 · registry 安装检查

新增 `scripts/registry-install-smoke.mjs`。

- 读取仓库 `package.json.version` 或显式 `--version`。步骤 1 之前传入 `--version 0.2.3-alpha.2`。在 `.tmp/registry-install-<random>` 下以独立缓存创建仅含目标 CLI 的 pnpm 项目，从官方 registry 安装精确版本。
- 断言 `<dir>/node_modules/@deepseek-ai/dsh/package.json` 的版本与目标一致。
- 从实际安装的 CLI 和 `dsh-app-boot` 各自的包目录解析 Loader，验证运行时导出的 `EntryValidationError` 并记录实际解析版本。
- 用临时 `DSH_HOME` 运行 `node <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js --version`，断言退出码为 0 且报告的版本等于目标版本。
- 成功时输出 CLI 入口的绝对路径，供后续探针使用。失败时保留目录、解析路径、依赖树和进程输出。

用干净缓存验证 alpha.2 可重复通过。用 alpha.1 作负例，确认脚本报告 Loader 导出缺失。

门禁要求 CLI 仅从 registry 解析依赖。pnpm 存储、缓存、profile 和启动产物使用临时目录。TUI 安装包验收见放行步骤。

### 步骤 3 · 探针与 PTC fixture

- `scripts/upgrade-core-e2e.mjs` 和 `scripts/rc1-capabilities-e2e.mjs` 默认按仓库 `package.json` 的版本断言，允许以 `DSH_EXPECTED_CORE` 覆盖。断言失败时打印期望版本与 CLI manifest 版本。
- 将需要回传工具结果的单调用 fixture 改成 `inspect(await tools.x(...))`。覆盖 `upgrade-core-e2e.mjs` 及 `fake-tty-{interaction-modes,write-update-diff,tool-details,tool-keywords,transcript-presentation}.mjs`。
- 同步迁移 `rc1-capabilities-e2e.mjs` 中的 `return [...]` 和 `fake-tty-edit-group.mjs` 中的 `return results`。依次调用工具并分别 `inspect` 需要断言的结果，调整探针对模型消息形状的解析，继续验证未读编辑拒绝、真实磁盘变更和提交结果。核对其余 `run_code` fixture 的程序语法和回传断言。
- 自定义 profile 若依赖每次调用使用新函数体，可显式设置 `executionMode: per-call`。需要模型读取的结果仍通过 `inspect(...values)` 输出。 [PTC 执行器说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/core/tool-executor-ptc/README.zh.md)

验收以 `upgrade-core-e2e.mjs` 覆盖 standard、ptc、minimal、cordis，以 `rc1-capabilities-e2e.mjs` 覆盖 standard 和 ptc 的补丁、观察策略及计划任务。PTC 模式下断言模型收到 `UPGRADE_READ_OK` 等实际工具结果。设置错误的 `DSH_EXPECTED_CORE` 时，两个探针均在启动 Host 前报告版本不匹配。

### 步骤 4 · CodeBuddy 图片契约

- `src/codebuddy/wire.ts` 中的本地 `ImageRequestTarget` 对齐 `@deepseek-ai/dsh-attachment`，包含 `width`、`height`、`maxImageBytes` 和 `imageTargetBytes`。两个字节字段使用原常量 `MAX_REQUEST_BYTES`（1 MiB）。
- `src/codebuddy/adapter.ts` 的 `imageRequestTarget` 和 `AttachmentImageService.readImageRequest` 采用同一类型。适配器声明和真正读取附件的路径复用 `imageTargetOf`。
- README 记录配置迁移。`llm-deepseek` 将模型的 `imageMaxBytes` 改为 `imageTargetBytes`。`llm-pi-ai` 单图配置继续使用 `requestImageMaxBytes`，其中实际可用上限受 `maxRequestImageBytes` 和 `requestImageBudgetCount` 分摊约束。

类型检查与步骤 1 一起通过。`tests/codebuddy-adapter.spec.ts` 和 `tests/codebuddy-stream.spec.ts` 覆盖目标形状及读取参数。让本地大图经过真实 Host 附件服务，沿用 CodeBuddy 测试的 `fetch` 替身捕获适配器请求。解码单图的 base64 并断言图像字节 ≤ 1 MiB，核对原附件字节和缩图尺寸。以独立用例验证 base64 传输总预算及超限时的 offload。

### 步骤 5 · worktree 当前目录和历史文件归属

- 当前操作优先使用 `workingDirectory.get(session)`，覆盖 `/open`、`/preview`、文件浏览和附件相对路径、`/new`、workspaces 当前标记、skills 和审批展示。兼容缺少该服务的 profile 时使用 header 目录或启动目录。已挂载服务读取失败时，受影响的路径操作报告错误，界面显示目录暂不可用。
- `SessionDrafts.save` 的两处调用在保存时传入会话当时的目录，按该目录写索引。`findBlank` 依据请求的目标目录匹配，覆盖从不同 workspace 发起的 `/new` 和 `/workspaces use`。
- `session-events.ts` 在当前会话的 `workingDirectory` 投影变更后触发状态栏及标题刷新。skills 缓存以 Agent 和当前目录为键，异步读完后校验两者仍匹配。
- `/export` 的相对输出路径使用当前目录，导出元数据中的会话原始项目使用 header。`/export zip`、`/deliverables open` 和 `reveal` 使用交付物声明时的目录。按事件序号以 header 为起点回放 Host 写入的 `workspace-root/change`。旧 `working-directory/change` 可由模型触发，沿用上游兼容规则，忽略它对目录边界的影响。ZIP 对每份交付物分别做词法路径和真实路径边界校验。变更摘要使用 Host 当次记录的目录。

单测覆盖服务存在、缺失、抛错，草稿索引和两个目录同名交付物。验证 ZIP 包含切换前后的合法产物，拒绝指向声明目录之外的符号链接。隔离 Host 显式挂载 worktree 插件，验证进入和退出后 `/open`、状态栏、标题、skills 和写入审批。恢复 rc.5 会话时按 header 目录解释旧目录事件，恢复 alpha.2 会话时按最新的 Host 目录事件恢复。

### 步骤 6 · MCP 状态与 OAuth

- 在 `package.json` 加入 `@deepseek-ai/dsh-host-webserver@0.2.3-alpha.2`，在 bundle 的 Host 层增加默认禁用的 `mcp-oauth-webserver`，配置为 `host: 127.0.0.1`、`port: 0`。需要 OAuth 时在 profile patch 启用，或复用 profile 已启用的 `webServer`。需要预登记回调地址的 OAuth 提供方可在 profile 显式指定固定回环端口。README 给出 patch 和配置示例。
- `/mcp add` 为 Streamable HTTP 增加 OAuth 选项，使用稳定的 `oauth.credentialKey`（新配置默认 `mcp-client/<name>`），沿用已配置的键，支持填写可选 `clientId` 和 `scope`。OAuth 配置与手写 `Authorization` header 互斥。已有服务也可通过 Host 配置启用 OAuth。
- `src/ui/commands/services.ts` 补齐 `waiting-authorization` 和原因字段，并在 manager 视图独立读取 `authorization` 的 attempt ID、阶段、URL 和错误。接入 Host 的 `startAuthorization`、`cancelAuthorization` 和 `signOut`。`/mcp list` 分别显示连接状态和授权阶段。
- `/mcp auth <name>` 检查配置和回调服务，调用 `startAuthorization` 后按 server 和 attempt ID 跟踪。等待浏览器时展示可复制的 URL，按阶段变化更新状态。使用现有可中止等待，每秒读一次 `list()`，只接受本次 attempt 的终态。attempt 消失或被替换时结束等待并报告变化。
- Esc 或命令中止后调用本次 attempt 的 `cancelAuthorization` 并读取结果。已进入 Host 提交阶段的操作可能最终为 `authorized`，按 Host 结果显示。使用独立的 `/mcp signout <name>` 确认并删除已保存的 grant。
- 在 `src/runtime/mcp-recovery.ts` 跳过 `waiting-authorization`，自动恢复和 `/mcp reload` 跳过处于 `starting`、`waiting-browser`、`exchanging`、`committing` 的服务。将新用法接入 `/mcp` 帮助及补全。

单测覆盖连接状态、授权阶段、attempt 替换、取消与提交竞态、退出授权确认，以及回调服务缺失和自动恢复跳过。用实际打包的 TUI、alpha.2 Host 和本地 OAuth/MCP fixture 验证浏览器回调、grant 生效、工具调用、取消保留旧 grant、显式退出授权。外部账号联调另行记录。

### 步骤 7 · 压缩摘要全文

- 压缩卡片保留当前预览高度和 240 字符上限。借用摘要预览行的预算提示 `/context summary <seq>`，其中 `seq` 为 `compaction/summary` 事件序号。压缩结束事件更新状态时继续携带该序号。
- 在 `/context` 的命令路由、帮助及补全中增加 `summary [seq]`。省略序号时选当前会话最新已提交的摘要，按序号则读取指定摘要。直接从当前会话的持久事件提取完整正文，通过现有 `showTextPager` 分页浏览。
- 失败、中断及正在压缩的卡片显示对应状态。指定序号不存在或没有可读摘要时，命令给出对应提示。

单测覆盖自动和手动压缩、按序号读取旧摘要、无摘要、失败及中断。用超过 16 KiB 的中文摘要验证分页可读到末尾。fake-TTY 验证主屏和全屏的预览高度、打开详情及 Esc 返回。

### 步骤 8 · 可移植功能（后续批次）

- 会话历史召回从 `session.snapshotEvents()` 的 `user/message` 重建。打开或恢复时去重并过滤空文本及纯命令，将最近 100 条以内的记录从旧到新加入 `editor.addToHistory`。成功发送后即时入历史。
- 模糊搜索优先评估复用已发布的 `@deepseek-ai/dsh-util-text-search`，验证其对命令名、别名和工作区名称及路径的排序。覆盖 `/cpt` → `/compact`。
- Git 插件源通过 `pluginMarket` 浏览。未挂载该服务时回退到 `pluginManager.listBundles()`，安装走 `pluginManager`。

### 步骤 9 · 文档与记录

- README 更新 Node 与 CLI 版本、安装包名称、探针用法、图片和旧 profile 迁移、OAuth 回调配置及压缩摘要查看方式。旧 profile 检查 `tool-working-directory`、Python PTC 和需要显式挂载的 `deepseekAuth`。
- `AGENTS.md` 更新 Node、安装包名称和实测测试基线。
- 在 `docs/progress-dsh-native-tui.md` 按日期记录实际执行过的命令与结果。
- 本文件“实施记录”回填日期、命令、结果与证据目录。

## 旧清单映射

| 旧文档项 | 本文件位置 | 说明 |
| --- | --- | --- |
| P0 npm 发布依赖 | 步骤 2 | alpha.2 已修复 Loader 导出，验证实际安装解析 |
| P0 CodeBuddy 请求图片 | 步骤 4 | 类型位置、两个字节值、配置迁移 |
| P1 worktree 当前目录 | 步骤 5 | 当前目录、草稿索引、状态栏事件和历史交付物 |
| P1 短片段反复压缩 | 上游跟踪 | alpha.2 仍存在，记录复测结果 |
| P1 MCP 状态、探针与 profile 校验 | 步骤 6 + 步骤 1–3 | 状态、授权、探针、依赖校验 |
| 可移植功能 | 步骤 8 | 历史、搜索、Git 源分批 |

## 验证与放行

### 本地检查

在每个可编译批次后运行 `pnpm typecheck` 和相关模块测试。涉及终端行为的步骤运行对应 fake-TTY 探针。

### 放行门禁

1. 干净环境执行 `pnpm install --frozen-lockfile`、`pnpm check` 和 `node scripts/registry-install-smoke.mjs`。将脚本输出的 CLI 路径设为 `DSH_CLI_ENTRY`，再运行 `pnpm pack --pack-destination .tmp`。
2. 扩展 `upgrade-core-e2e.mjs` 的打包验收模式，从 `DSH_TUI_TGZ` 读取本次产物。为每个预设建立独立 `DSH_HOME`，以该 CLI 执行 `plugin --profile tui add` 安装实际 `.tgz`，再用 fake-TTY 启动同一 profile。断言加载的 TUI 包版本、Host 服务和预设实际激活。覆盖 standard、ptc、minimal、cordis 的新建、模型路由、适用的工具往返、reload、同版本恢复和正常退出。留存进程输出和模型请求，并复用能力探针检查 standard 与 ptc。
3. 用匹配的 rc.5 CLI 和 TUI 产物在独立 profile 生成有模型路由、对话和附件的 session，另准备一份包含旧 `working-directory/change` 的会话。保存基线原件，复制持久会话及所引用的附件到 alpha.2 测试 home。通过新版 TUI 恢复并继续一轮，验证所选模型、历史、附件及目录解释。记录普通会话和含旧目录事件的会话各自的结果。
4. 在隔离 profile 完成 worktree 进入与退出、存量 MCP、OAuth 回调与取消、CodeBuddy 大图和压缩摘要分页验收。用本地模型替身覆盖切换模型后的溢出恢复。短片段压缩只记录复测结果。

### 外部端点与终端体验

核对主屏与全屏的摘要详情和工作目录变化。外部 OAuth 提供方和真实 CodeBuddy 网关在具备测试账号时单独记录结果。放行记录列明本地 fixture 覆盖的链路和外部端点实测范围。

## 风险与回滚

- alpha.2 写入的 `workspace-root/change` 会让 rc.5 拒绝含该事件的日志。试升前保存 rc.5 的包、profile 和会话数据。回退时恢复配套的 rc.5 数据副本，单独保留升级后新增的会话及日志。
- 依赖、lockfile、配置和适配代码按同一批次回滚。若锁文件解析出两个 Schemastery 版本，先修正依赖范围再验收。
- OAuth 取消或清理失败时报告 Host 结果。新 grant 成功提交前保留已存的 grant。删除 grant 使用显式退出授权命令。
- 真实网关若要求更小的图片传输预算，记录其限制并按单图与总预算分别复测。

## 未决议题

- 上游短片段压缩修复进度。
- 外部 OAuth 提供方及 CodeBuddy 网关的测试账号和可用性。
- registry smoke 是否接入 CI（需要网络与缓存策略，待定）。

## 实施记录

2026-11-23 在 macOS arm64、Node `24.22.3` 和 pnpm `12.14.0` 执行。

| 检查 | 结果与证据 |
| --- | --- |
| `pnpm install --frozen-lockfile`、`pnpm check` | 锁文件供给策略、类型检查、131 个测试文件的 1,886 项测试和构建通过。 |
| `registry-install-smoke.mjs` | alpha.2 纯 registry 安装通过，CLI 和 app-boot 均解析到 Loader `1.2.0-alpha.1` 并取得 `EntryValidationError`。alpha.1 负例复现 Loader `1.1.0` 缺少该导出。证据为 `.tmp/registry-install-IHk3jZ` 和 `.tmp/alpha1-registry-negative.log`。 |
| `upgrade-core-e2e.mjs` | 实际安装 `.tgz`，四套预设通过新建、模型路由、适用预设的工具往返、reload、恢复和退出。两份 rc.5 会话副本通过跨版本恢复，覆盖旧目录事件、模型、历史及 ZIP 中的附件原始字节。终端和安装日志见 `.tmp/alpha2-upgrade-core-e2e.log` 中的隔离证据目录。 |
| `rc1-capabilities-e2e.mjs` | standard 和 ptc 的补丁启用、未读编辑拒绝、Schedule 管理及真实磁盘改动通过。两份升级探针均拒绝错误的 `DSH_EXPECTED_CORE`。证据为 `.tmp/alpha2-rc1-capabilities-e2e.log` 和 `.tmp/alpha2-version-*.log`。 |
| `fake-tty-mcp-oauth.mjs` | 打包 TUI 经 `/mcp add` 保存 OAuth 配置，完成本机回调和工具调用。取消重新授权后旧 grant 仍可调用工具，显式退出授权后服务重新等待授权。证据为 `.tmp/alpha2-fake-tty-mcp-oauth.log`。 |
| `fake-tty-worktree.mjs` | 真实 Host 进入并退出 Git worktree，验证相对路径、窗口标题、技能读取与拒绝写入审批。历史交付物和符号链接边界由 ZIP 回归覆盖。证据为 `.tmp/alpha2-fake-tty-worktree.log`。 |
| `codebuddy-image-budget-e2e.mjs` | 实际 Host 附件服务将 7,695,273 字节图片编码为 832,134 字节，尺寸为 1454 × 1454，原附件 SHA-256 一致。发包使用本地替身。 |
| `fake-tty-compaction-threshold.mjs` | 主屏验收切换模型后溢出恢复、压缩上限和短片段摘要缩减校验。摘要分页在主屏和全屏通过，证据为 `.tmp/alpha2-fake-tty-compaction-threshold.log` 和 `.tmp/alpha2-compaction-fullscreen.log`。 |
| PTC 展示及交互探针 | Edit group 8 组、write/update diff 4 组、tool keywords 8 组、transcript presentation 6 组及 tool details 通过。原生与 PTC 交互模式通过，原生探针还验证恢复后的权限状态。证据为 `.tmp/alpha2-fake-tty-*.log` 和 `.tmp/alpha2-interaction-native.log`。 |

真实 OAuth 提供方、CodeBuddy 网关和实际终端会话仍需独立验收。本地探针使用本地模型或 HTTP 替身。

## 参考

- [alpha.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.1)
- [alpha.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.2)
- [工作目录变更说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/docs/persistence-changes/2026-11-13-workspace-root-change.zh.md)
- [原审查与证据](design-task-upgrade-dsh-0-2-3-alpha-1.md)
- [上下文压缩排障记录](troubleshooting-context-compaction.md)
