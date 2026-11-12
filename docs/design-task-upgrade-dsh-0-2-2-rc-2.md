# DSH 0.2.2-rc.2 升级与能力同步方案

> 状态：部分实施（核心兼容、MCP 迁移、git 插件更新、preset/工具/凭据已完成；AgentTeam 待做）
> 日期：2026-11-12
> 插件基线：`0.2.2-rc.1`（`main` @ `a4704ee`）
> 核心对比：`dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）→ `dsh-v0.2.2-rc.2`（`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`），共 4,645 个文件差异
> 依据：本地 `deepseek-harness` 检出中两个 tag 的源码 diff、rc.2 的 19 份升级指南、本插件调用点静态核对。**尚未在 rc.2 CLI 下运行**，运行期结论以实施后的探针为准。
> 前置阅读：[rc.1 适配记录](design-task-upgrade-dsh-0-2-2-rc-1.md)（已冻结，仅作历史参考）。PR #2（`fix/stream-render-performance`）与本方案无关。

## 评估结论

方案方向成立；版本清单、preset 配置键、`Session.append`、worktree/Forge 等判断已复核。评审后修正了 4 处事实错误，并补入 MCP 自动恢复、挂载校验、git 更新数据源等风险项。

| 分类 | 数量 | 内容 |
|---|---|---|
| 兼容性必改 | 3 | `/agents` 的 `listChildren` 移除、CodeBuddy 自定义 `LlmError` 码、runtime-context 渲染 |
| 可同步能力 | 8 | MCP 核心 manager、工具错误身份、插件加载状态与 git 更新、AgentTeam、preset/plan 对齐、Gemini 协议、凭据掩码、重试/附件/网页搜索 |
| 需明确决策 | 5 | MCP 自动恢复替代、`interrupt_agent` 移除、runtime-context 紧凑化、git 更新交互、AgentTeam 开启语义 |
| 不适用 | 若干 | Web/Desktop/LiveShare/Forge/工作树/Office 等 |

## 一、兼容性必改

### 1. `/agents` 迁移到 `listDescendants`

- rc.2 事实：`SubagentRuntime` 移除了 `listChildren()`（rc.1 `packages/subagent/subagent/src/index.ts:407`），只保留 `listDescendants()`；模块级 `listChildren()` 仍存在，但服务方法已不存在。
- 插件现状：`src/ui/commands/runtime-status.ts:126` 调用 `subagents.listChildren(...)`；`src/ui/commands/services.ts` 的 `SubagentsService` 按旧签名声明。升级后运行时会报 `listChildren is not a function`。
- 返回结构（已核对）：`SubagentDescendantListEntry = SubagentListEntry & { parentId, depth, path? }`
  - `kind: 'child'`：`id`、`mode`、`label?`、`name?`、`activity: 'running' | 'inactive'`、`hasChildren`、`parentId`、`depth`、`path?`；**不含 `createdAt`**（rc.2 在构造时显式丢弃）。
  - `kind: 'diagnostic'`：`id`、`reason: 'corrupt' | 'unsupported' | 'unavailable'`、`parentId`、`depth`、`path?`；无 `activity`/`hasChildren`。
- 处理：改用 `listDescendants(ctx.active.id)`，按 `depth` 缩进成树；显示 `path ?? name ?? id`、`activity`、`hasChildren`，diagnostic 显示原因。**删除现有时间列**，或改用其他持久化来源；`activity` 只表示当前是否有驻留 Session，不能当作运行结果展示。
- 验证：单测覆盖树形输出、无名祖先回退、diagnostic 行；真实 Host 多层子代理探针。

### 2. CodeBuddy 自定义 `LlmError` 码

- rc.2 事实：`LlmError` 构造函数参数收窄为 `BuiltinLlmFailureCode`（`LLM_FAILURE_CODES` ∪ `HTTP_${number}`），并新增 `LlmError.fromFailure(failure, options?)` 用于保留任意 provider 码。
- 插件现状：`src/codebuddy/stream.ts:53` 的 `failureCodeOf()` 返回 `NO_SUCH_MODEL`、`BAD_REQUEST`、`UNAVAILABLE`、`UPSTREAM_ERROR`、`INCOMPLETE_STREAM`，均不在内置集合；该函数返回 `string`，在 `stream.ts:71` 传给 `new LlmError()`，**类型检查直接失败**。`stream.ts:419` 另有一处直接使用 `INCOMPLETE_STREAM`。
- 不能简单改成 `STREAM_CLOSED`：`src/codebuddy/adapter.ts:50` 的重试策略包含 `INCOMPLETE_STREAM`，`tests/codebuddy-stream.spec.ts:482` 也断言该码；替换会改变重试行为与测试语义。
- 处理：保留 provider 自有码，新增一个局部 helper（如 `customLlmError(message, code, options)`）统一走 `LlmError.fromFailure({ message, code, ... })`，或对 `failureCodeOf` 的返回值做集中类型窄化；逐项保留原有码。`resolveRetryPolicy` 的 `retryableCodes` 仍接受任意字符串，无需改。
- 连带影响：计划原“步骤 1 只升版本并保持 `pnpm check` 绿”不成立，类型错误会先暴露；版本 bump 与这处修复应合并在同一步。

### 3. runtime-context 渲染

- rc.2 事实：运行时上下文改为 `<system-reminder>` 包裹，新增 `source.form: 'snapshot'` 与 `source.sections`，空快照使用固定的 `CLEARED` 文本，并区分首次与后续引导语（`packages/core/agent-loop/src/runtime-context.ts`）。旧快照缺少 `sections` 时会刷新一次。
- 插件现状：`src/ui/transcript.ts:548-573` 把所有非 `user`、非 `compact-checkpoint` 的 `user/message` 当作 `context` 块并完整打印文本。升级后每个新会话/恢复会话都会出现原始 XML 与长文本。
- 处理：按 `source.kind === 'runtime-context'` 做类型窄化（不要用 `String(source.kind)`），优先用 `source.sections` 渲染紧凑摘要并保留展开；`form === 'snapshot' && sections.length === 0` 视为已清空；仅回退文本时剥离 `<system-reminder>` 包裹。不要按字面匹配引导语。
- 验证：新会话、`--resume`、压缩后恢复三种路径；与 Host 的 `source.sections` 对齐。

## 二、可同步能力

### 高：MCP 交给核心 `dsh-mcp-manager`

- rc.2 事实：新增 `@deepseek-ai/dsh-mcp-manager`（rc.1 无此包），服务名 `mcpManager`，API 为 `list()`、`register(name, entry)`、`restart(name)`、`probe(name, options?)`，并发出 `mcp-manager/status` 事件。rc.2 仅 `packages/bundle/web-app/cordis.patch.yml:153` 挂载，base 未挂载。
- 条目字段：`transport`、`command`、`args`、`env`、`cwd`、`url`、`headers`、`enabled`、`toolCallTimeoutMs?`、`startupTimeoutMs`（默认 30s）、`closeTimeoutMs?`、`reconnect`。
- 状态：`McpConnectionStatus` 为 `closed`、`waiting-credentials`、`connecting`、`connected`、`reconnecting`、`failed(gave-up | reconnect-disabled | unclosed-generation)`；manager 再叠加 `disabled`、`failed(load)`、`failed(cleanup)`。`/mcp` 的映射必须覆盖全部状态，不能只判断“已连接/错误”。
- 行为差异（必须写入迁移说明）：
  - `failOnStartupError: false`：启动失败不再让插件激活抛错，只进入 status；`/mcp add` 写入后必须 `probe` 或等待 status，再报告结果。
  - `expandTemplates: true`：env/headers 中的 `${credential:...}` 会被解析；存量值若含字面模板语法会改变行为。
  - 默认 `startupTimeoutMs` 为 30s，`reconnect` 使用 mcp-client 默认策略。
  - `restart` 在清理未确认时拒绝；`probe` 对不存在/配置变更中/清理未完成会抛错，且是一次性探测，不改动活实例。
- 自动恢复（关键）：插件现有 `src/mcp-manager.ts` 的 `tools/result` 观察器，是“HTTP server 静默重启、连接未断、工具持续失败”场景的唯一自动检测/重建来源；核心 manager 不会自动探测。迁移时必须保留一个瘦观察层，例如：
  1. 监听 `tools/result`，只处理 `mcp__<server>__*` 且错误码/消息属于连接类失败；
  2. 调 `mcpManager.probe(name)`；失败则 `restart(name)`；
  3. 对同一 server 做频率限制（例如 30s 内最多一次），并在 status 中展示“探测/重建中”。
  否则 TUI 会回退为“工具一直失败，直到用户手动 `/mcp reload`”。
- 迁移风险：核心在构造与配置更新时调用 `validateEntries`，**存量条目非法会使 manager 激活失败，进而可能让 profile 无法启动**。必须先做一次性预检/规范化（备份旧 settings，拒绝或降级非法条目并给出可读提示），再切换挂载行。
- 设置写入路径：`/mcp add|remove` 仍通过 `settings.update('mcp-manager', ...)` / `settings.mutate`；需验证 settings patch 能触发核心的 `internal/config` 校验与 reconcile，并覆盖存量条目含旧字段/未知字段时的行为。
- 同步方案：`cordis.patch.yml` 的 `mcp-manager` 行改用 `@deepseek-ai/dsh-mcp-manager`；删除自研模块、`mcpManagerStatus` 服务与 `tests/mcp-manager.spec.ts`（28 项），新增 `/mcp list|add|remove|restart|probe` 的测试与状态映射测试。
- 验证：存量条目（合法/非法/含模板/含未知字段）加载、profile 可启动；`/mcp add` 失败反馈；静默重启恢复；`probe`/`restart` 错误路径；`tests/mcp-recovery.spec.ts` 与 `scripts/fake-tty-mcp.mjs`。

### 高：工具失败身份

- rc.2 事实：`tool/result` 新增 `error: { name, code, reason? }`，仅在 `message.isError: true` 时出现（`packages/core/session/src/types.ts:391`）。
- 插件现状：`src/ui/transcript.ts:523` 只保留 `isError`；`src/ui/tool-card.ts:156` 只渲染 “error”。
- 同步：折叠行显示 `code`（必要时 `name`），展开显示 `reason`；`reason` 必须经 `sanitizeTerminalText`（已有 `src/runtime/terminal-text.ts`），避免控制字符进入终端。对 `ATTACHMENT_*`、`IMAGE_*` 增加可读说明，同时保留原始 code。
- 验证：单测覆盖错误码展示、控制字符净化、无 `error` 字段时的兼容。

### 中：插件加载状态与 git 更新

- rc.2 事实：`BundleInfo.updatable` 被 `update?: 'registry' | 'git'` 取代；`ManagementError` 新增 `unexpected-package`；`PackageResult.unmet` 标记期望包未安装；被跳过加载层的 bundle 携带 `error`，其 `rows` 没有 `entryId`；`UpdateBundleOptions.spec` 用于 git 更新。
- 数据源更正：`PluginVersion`（`packages/boot/plugin-manager/src/types.ts`）**没有 `update` 字段**；该字段在 plugin-market 的 `MarketListingVersion` 上，而 base 组合没有挂载 `pluginMarket` 服务。`listVersions` 对 git bundle 返回 `refused: not-updatable`，不会列出可更新的 commit。因此不能按原方案“从 versions 列表选 git 版本”。
- 可行方案：用 `listBundles()` 的 `update === 'git'` 标识 git 可更新 bundle；`/plugins update <bundle> <version> <spec>`（或交互输入 full-commit spec）调用 `updateBundle(name, version, { spec })`；失败/回滚沿用现有结果展示。若要复用 market listing，需要先在 TUI 组合中新增挂载 `plugin-market` 服务，属于额外范围。
- `PackageResult.unmet`：`src/ui/commands/plugin-result.ts` 目前只输出 `error.code/diagnostic` 与 package 输出，需要补 `unmet` 的可读提示（`unexpected-package` / `not-bundle`）。
- 加载状态：bundle 列表显示“已启用但未运行”及 `error.code/diagnostic`；不要只显示 `[on]/[off]`。
- 验证：加载失败 bundle、git bundle 更新、`unexpected-package`、`unmet`、恢复失败时的回滚提示。

### 中：AgentTeam 会话开关

- rc.2 事实：base 新增 `agent-team` 与 `tool-agent-team` 行；`TeamService` 提供 `isEnabled(agent)`、`setEnabled(agent, enabled)`、`listTasks(caller)`、`getTask/createTask/updateTask`；`team_task_*` 工具按 `isEnabled` 条件注册，默认关闭；`setEnabled` 追加 `team/mode` 事件。
- 插件现状：没有开关入口，模型拿不到 team 工具。
- 同步：新增 `/team [on|off|tasks]`；`/agents` 树同时展示 team 成员名；任务列表显示 status/owner/revision。开启/关闭需要显式确认，`/reload`/resume 后从 `isEnabled` 恢复状态。
- 验证：开关后工具可见性、任务列表、resume 后状态、非 root 调用拒绝。

### 中：preset 与 plan 模式对齐

- base 与 Web 的 `standard`/`ptc`/`cordis` preset 现在都设 `tool-subagent-control.config.interrupt: false`；插件 `presets/{standard,ptc,cordis}.patch.yml:91` 附近自建该行且未设置，沿用插件默认 `true`。**这是行为变化**：TUI 模型会失去 `interrupt_agent`。建议做成配置项或明确在升级说明中标注。
- rc.2 把 `wait_agent` 并入 `tool-subagent-control`（rc.1 中它属于 experimental AgentTeam 工具），插件挂载该行后模型可调用；`src/interaction-modes.ts:60-64` 的 plan 模式只读白名单缺 `wait_agent`。
- 若启用 AgentTeam，plan 模式还应放行只读的 `team_task_list`、`team_task_get`；`team_task_create/update` 与 `send_message` 仍按写操作处理。
- 验证：plan 模式下的放行/拒绝矩阵。

### 低：Gemini 原生 provider

- rc.2 事实：llm-pi-ai 新增 `google-generative-ai` 协议（`packages/llm/llm-pi-ai/src/provider.ts:52`），发现接口支持 Gemini 模型列表（`discovery.ts` 中的 `GEMINI_MODEL_LIMIT` 与 `readGeminiListing`）。
- 插件现状：`src/runtime/providers.ts:2` 的 `PROVIDER_PROTOCOLS` 仅三种协议，`/provider add` 无法创建 Gemini 原生 provider。
- 同步：加入该协议；复用 Host `discoverModels`；验证推理等级（`PROVIDER_REASONING_LEVELS` 已含 off/minimal/low/medium/high/xhigh/max）与 Gemini thinking 映射。

### 低：凭据掩码

- rc.2 的 `CredentialInfo` 新增 `masked?: string`（`packages/credentials/credentials/src/types.ts`），对应发布说明中的 API Key 掩码展示。
- 同步：`/provider`、`/codex` 等凭据状态展示使用 `masked`（存在时），仍不读取完整值。

### 低：重试设置、附件错误码与网页搜索

- 重试：`retry-policy.ts` 把可重试码与字段边界发布到 schema（`RETRY_CODE_CHOICES`），TUI 的 `/settings host` 是 schema 驱动，预计无需改代码；实施时实测 provider 命名空间下字段可见、可写回。
- 附件：`AttachmentError` 改为继承 `HarnessError`，`turn/end` 与 `tool/result` 保留 `ATTACHMENT_*`、`IMAGE_*` 等原始码，旧日志仍是 `UNKNOWN`。插件已显示 code，可补可读映射。
- 网页搜索：TUI 不直接构造 provider，base 挂载 `web-deepseek-api`，代码无需改；但默认提供方切换后，没有 DeepSeek 账号/密钥的用户可能失去 `web_search`，旧 exa/perplexity 配置需要迁移。升级说明必须提示，不能只写“无需改动”。

## 三、不适用或无需改动

- 工作树/Forge/LiveShare/终端侧栏/账号通知/桌面更新渠道/侧栏布局/窄屏与菜单定位：Web/Desktop 专属。base 与插件均未挂载 `worktree`/`forge`，`archive-worktrees` 的清理逻辑不作用于 TUI；`workspace` 新增的 `workspace/session-archived` 后续事件不改变现有归档调用。
- `Session.append` 批量重载：插件没有包装或赋值 `Session['append']`，只有内部 reducer 的同名方法，不受影响。
- Office 原生工具、插件代码块渲染器、插件索引 Star/下载量、CUA 鼠标/授权调整、模型请求 User-Agent 标记：其他端或 Host 内部行为，随依赖继承。
- 网关错误误报 API Key、Anthropic 失效签名 thinking、停止/关闭会话资源释放、并行只读工具：Host 内部修复，TUI 显示层无需改。
- 桌面端/移动端/SDK/ACP 与 `dsh-doc` skill 迁移：与本插件无关。

## 四、依赖与版本

- `package.json` 版本 `0.2.2-rc.1` → `0.2.2-rc.2`。
- dependencies：`dsh-computer-use`、`dsh-experimental-auto-review`、`dsh-experimental-computer-use-cua-driver-native`、`dsh-mcp-client`、`dsh-mcp-resources`、`dsh-session-stats` → `0.2.2-rc.2`。
- devDependencies：全部 `@deepseek-ai/dsh-*` → `0.2.2-rc.2`；`@deepseek-ai/cordis` 保持 `4.1.0`、`@deepseek-ai/schemastery` 保持 `3.19.0`（rc.2 未变）。
- peerDependencies 范围 `>=0.2.2-rc.1 <0.3.0` 已覆盖 rc.2，不收紧。
- `pnpm-lock.yaml` 由 `pnpm install` 更新。安装候选版本时沿用 rc.1 做法，仅对本次命令使用 `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0` 与 `npm_config_manage_package_manager_versions=false`，不持久化。
- README、`docs/progress-dsh-native-tui.md`、`scripts/install.sh` 中 rc.1 的表述同步更新。
- 本机全局 `dsh` 仍为 `0.2.2-rc.1`；实跑前需升级到 rc.2，集成探针只使用 `.tmp/` 下的隔离 CLI。
- 同一 `DSH_HOME` 下不要混跑 rc.1 与 rc.2：rc.2 的 AgentTeam/会话事件与 rc.1 进程不兼容，Web/Desktop 与 TUI 必须一起升级。

## 五、实施顺序

1. 版本对齐 + `LlmError` 自定义码修复：两者同一步完成，先让 `pnpm typecheck` 恢复；不要期待“只升版本”能保持绿。
2. 兼容性剩余两项：`/agents` → `listDescendants`（树、字段变化、测试）、runtime-context 渲染（含单测）。
3. MCP 迁移：预检/规范化存量 settings、替换挂载行、重写 `/mcp`（含 probe、状态映射、添加后探测）、保留瘦自动恢复观察层、删除自研模块与 28 项旧测试并补新测试。
4. 工具错误码展示、插件加载状态与 git 更新、`unmet` 展示、preset `interrupt` 与 plan 白名单。
5. Gemini 协议、凭据掩码、重试/附件/网页搜索的验证与说明。
6. AgentTeam `/team`（独立提交）。
7. 文档与进度回填。

## 六、约束

- 不修改核心源码、全局 dsh、默认 `DSH_HOME` 或真实 profile；集成运行时只装在仓库 `.tmp/`。
- 每个源文件不超过 1000 行；MCP 与 AgentTeam 若使 `app.ts` 或命令文件逼近上限，按现有职责拆分。
- 不与已提交的流式渲染修复（PR #2）混在同一分支；升级提交保持单一主题。
- 未获明确授权不 commit、push 或发布。
- MCP 迁移必须先备份旧 settings，并提供回滚路径；不得让非法存量条目直接导致 profile 无法启动。

## 七、验证与验收

- 版本 bump 后立即 `pnpm typecheck`，预期在 `failureCodeOf` 处失败；修复后 `pnpm check` 全绿。
- `--dump-config`：四套 preset 的 `fs-observation-policy`、`apply_patch`、`tool-subagent-control` 配置与 rc.2 组合一致；MCP 行指向核心包。
- MCP 迁移矩阵：合法/非法/含模板/含未知字段的存量条目；`/mcp add|list|remove|restart|probe`；静默重启恢复；`probe`/`restart` 错误路径；profile 可启动与回滚。
- `/agents` 多层树、无名祖先回退、diagnostic 行；runtime-context 新会话/resume/压缩。
- 插件加载失败状态、git bundle 更新、`unexpected-package`/`unmet`、恢复失败回滚提示。
- plan 模式放行/拒绝矩阵（`wait_agent`、`team_task_list/get`、写工具）。
- Web 搜索无凭据时的工具可见性与设置迁移提示；同一 profile 的跨端版本一致性检查。
- 打包 smoke：`pnpm pack` + 解包 import，确认 4 个 JS 导出、声明文件与 5 个 bundle patch。
- 性能与容量结论只记录实际命令输出，不宣称未测量的提升。

## 八、待验证风险

- 全部结论来自静态 diff，rc.2 运行时未验证；类型检查之外的运行差异以探针为准。
- MCP 存量条目非法会使核心 manager 激活失败；预检/规范化方案需实测，不能假设配置层会兜底。
- settings patch 是否能触发核心 `internal/config` 校验与 reconcile，以及未知字段的处理，需实测。
- `expandTemplates: true` 与 `failOnStartupError: false` 的行为差异需要真实 MCP server 验证。
- `@deepseek-ai/dsh-api-session-controller` 等被插件挂载的行在 rc.2 有较大改动，需启动与 `--dump-config` 验证。
- `pluginMarket` 服务未挂载，git 更新只能走 `listBundles` + 用户 spec；若实现依赖 market listing，需要扩大到新增挂载。
- `tool-agent-team` 的条件注册依赖 `agentTeams.isEnabled`，实际可见性需在 rc.2 Host 下确认。
- `listDescendants` 依赖 `sessionQuery` 与 `subagentCatalog` 投影；TUI 组合需确认两者均可用。

## 九、参考

- [rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)
- [rc.2 升级指南目录](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.2/docs/upgrade-guide/v0.2.2-rc.1)：`session-append-overloads`、`plugin-update-method`、`attachment-error-codes`、`runtime-context-reminders`、`web-search-billing`、`archive-worktrees`、`subagent-interrupt-default`、`terminal-backend-cleanup-error`、`cua-*`
- 关键源码（rc.2）：`packages/subagent/subagent/src/list-children.ts`、`packages/mcp/mcp-manager/src/index.ts`、`packages/mcp/mcp-client/src/types.ts`、`packages/core/agent-loop/src/runtime-context.ts`、`packages/core/session/src/types.ts`、`packages/boot/plugin-manager/src/types.ts`、`packages/boot/plugin-market/src/types.ts`、`packages/credentials/credentials/src/types.ts`、`packages/llm/llm/src/error.ts`、`packages/llm/llm-pi-ai/src/provider.ts`
- 插件调用点：`src/ui/commands/runtime-status.ts`、`src/ui/commands/services.ts`、`src/ui/commands/mcp.ts`、`src/mcp-manager.ts`、`src/ui/transcript.ts`、`src/ui/commands/plugins.ts`、`src/ui/commands/plugin-update.ts`、`src/ui/commands/plugin-result.ts`、`src/runtime/providers.ts`、`src/interaction-modes.ts`、`src/codebuddy/stream.ts`、`presets/*.patch.yml`

## 实施记录（2026-11-12）

### 已完成

- 依赖：`package.json` 与全部 `@deepseek-ai/dsh-*` 升到 `0.2.2-rc.2`，新增 `@deepseek-ai/dsh-mcp-manager`；`pnpm-lock.yaml` 已更新；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 按 lockfile 重新生成（84 项，含 rc.2）。
- CodeBuddy `LlmError`：新增 `providerFailure()`，以构造函数参数类型做集中窄化；`NO_SUCH_MODEL`、`BAD_REQUEST`、`UNAVAILABLE`、`UPSTREAM_ERROR`、`INCOMPLETE_STREAM` 全部保留，未采用会改变重试策略的 `STREAM_CLOSED`。
- `/agents`：优先调用 `listDescendants` 渲染树（层级、`path/name/id` 回退、activity、hasChildren、diagnostic 原因），不再输出 `createdAt`；旧 Host 仍回退 `listChildren`。
- runtime-context：按 `source.form` 渲染 `snapshot`（label 列出 section 名称，正文按 section 拼接）、`notice`（summary 进 label）、空快照 `· cleared`；无 form 时剥离 `<system-reminder>` 包裹。**评审时高估了视觉影响**：`ContextMessage` 默认折叠，原文仅在展开时可见；本次改动消除了展开后的原始 XML 与冗余文本，并未改变折叠行数量。
- 工具失败身份：`tool/result.error` 的 `name/code/reason` 进入 tool block，折叠行显示 `error · name · code`，`reason` 保留供展开；标签经 `toolLabel` 净化。
- 凭据：`/provider list` 优先使用 `credentials.describe().masked`，缺省回退 `resolve`。
- plan 模式只读白名单补 `wait_agent`、`team_task_list`、`team_task_get`；三套 preset 的 `tool-subagent-control` 显式 `interrupt: false`。
- MCP：`cordis.patch.yml` 的 `mcp-manager` 行改挂 `@deepseek-ai/dsh-mcp-manager`；删除 `src/mcp-manager.ts`（505 行）、`tests/mcp-manager.spec.ts`（28 项）与依赖旧模块的 `scripts/mcp-reconnect-e2e.mjs`/`fake-mcp-http.mjs`；`/mcp` 改为 `list()`/`restart()`/`probe()`，状态映射覆盖核心全部状态，新增 `/mcp probe`；新增 `src/runtime/mcp-recovery.ts`：连接类工具失败 → 读核心活实例状态（`connecting`/`reconnecting`/`disabled`/`waiting-credentials` 交给核心）→ 其余情况 30 秒节流 `restart`。probe 会另开连接，成功不能证明活实例可用，因此不再作为重启门槛。
- 兼容确认：核心 `McpServerManager.Config` 解析存量条目中的 `serverName` 时保留为额外字段，不参与校验，也不会传给 client；旧 profile 不会因此拒绝加载。
- 真实 profile 迁移（2026-11-12）：`~/.dsh/profiles/tui/cordis.patch.yml` 的 `- id: mcp-manager` 覆盖仍写 `name: dsh-native-tui/mcp-manager`，rc.2 报 `name mismatch ... skipping` 并跳过整行，导致其 `servers.idea` 不加载、`/mcp list` 为空。已先备份原文件，将该行改为 `name: '@deepseek-ai/dsh-mcp-manager'`；`--dump-config` 不再出现 mismatch，`mcp-manager` 行保留 `idea` 配置。README 兼容性已补充迁移步骤。
- Gemini：`PROVIDER_PROTOCOLS` 增加 `google-generative-ai`（仅协议可选，未对真实 Gemini 端点验证）。
- Git 插件更新：`/plugins` 列表标记 `(git update)`；`/plugins versions <bundle>` 对 Git bundle 给出带 `<version> <git-spec>` 的指引（不再显示 registry 的 `not-updatable`）；`/plugins update <bundle> [version] [git-spec]` 缺参时交互补全版本与 full-commit spec，确认后调用 `updateBundle(name, version, { spec, requestId })`，沿用回滚与 `unmet` 展示。`listBundles` 缺失时跳过 Git 分支，保持旧测试与旧 Host 兼容。
- 文档：README 的版本、MCP 行为、命令表、`/agents` 说明已更新；进度文档记录本次 MCP 迁移。

### 实际验证

| 命令或检查 | 真实结果 |
|---|---|
| `pnpm check`（rc.2 依赖） | typecheck、115 个测试文件 / 1,708 项、build 全通过 |
| 隔离 rc.2 CLI + `--dump-config` | 插件安装成功；`mcp-manager` 行指向 `@deepseek-ai/dsh-mcp-manager`；preset 中 `interrupt: false` |
| `scripts/fake-tty-approval.mjs`（rc.2 Host） | allow / reject / cancel-row / cancel-esc 四模式 PASS |
| `scripts/fake-tty-mcp.mjs`（rc.2 Host） | `/mcp add` 先报告 `MCP server demo: connected`，随后 `/mcp list` 显示 `demo  stdio  …  connected · 1 tools` |
| `tests/mcp-recovery.spec.ts` | 7 例：connected 失败重启、reconnecting 交给核心、业务失败忽略、30 秒节流、`__` server 名匹配、无 list 时回退、dispose |
| 核心 `Config` 解析含 `serverName` 的存量条目 | 保留额外字段，未报错 |

证据目录（gitignored）：`.tmp/rc2-cli`、`.tmp/home-rc2`、`/tmp/dsh-native-tui-mcp-home`。

### 未完成

- `/plugins` 的 Git 更新已实现，但未在真实 Git 安装的 bundle 上做端到端更新/回滚验证；`PluginVersionList` 无 `update` 字段的结论仍成立。
- AgentTeam `/team` 开关与任务板面板未实现；只完成了 plan 只读白名单。
- Gemini 已加入 `PROVIDER_PROTOCOLS` 与 `/provider add` 选项，仍未对真实端点、模型发现与推理等级映射做运行验证。
- 重试设置是否在 `/settings host` 中完整可见未实测；附件错误码只做了通用展示，未加可读映射。
- 未对“含 `serverName` 的旧 profile 完整启动”做端到端验证（仅验证了 Config 解析）。

## 评估记录

- 2026-11-12 初版：对比两个 tag 的 4,645 个文件差异，按插件依赖与调用点筛选；读取 rc.2 的 19 份升级指南；grep 插件源码确认现状。仅做静态分析。
- 2026-11-12 评审修订：修正 `LlmError` 为 CodeBuddy 自定义码整体（原仅列 `INCOMPLETE_STREAM`）、`listDescendants` 不返回 `createdAt`、`PluginVersionList` 无 `update` 字段且 `pluginMarket` 未挂载、MCP 状态枚举与核心行为差异；补入 MCP 自动恢复观察层、挂载校验会导致 profile 无法启动的风险、`PackageResult.unmet` 展示、凭据掩码、AgentTeam plan 只读工具、网页搜索用户迁移、跨端版本一致性，以及对应验证项。
- 同期 PR #2（`fix/stream-render-performance`）是独立的流式渲染性能修复，不属于本方案。
