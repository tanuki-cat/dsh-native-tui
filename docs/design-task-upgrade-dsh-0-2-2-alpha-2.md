# DSH 0.2.2-alpha.2 适配与升级

> 状态：待实施
> 日期：2026-10-28
> 升级前基线：`8d4ca9db17493e9ce88f6a871f5ebee24ef7f385`，tag `v0.2.1-rc.3`
> 核心目标：`dsh-v0.2.2-alpha.2`（`f3803c9697`）

## 结论

插件当前依赖 `0.2.1-rc.3`。核心升级包含模型选择、子代理配置及工具执行器变更，不能只替换版本号。本任务先修复兼容性，再接入模型目录展示与权限问答改进；不修改核心仓库，不自动更新用户全局 CLI 或真实 profile。

本地检查时，全局 `dsh --version` 为 `0.2.1-rc.3`，相邻核心源码位于目标标签。以下结论来自两版本源码对比；目标版本构建与运行验收尚未执行。

## 范围与实施顺序

### 1. 必须修复的兼容性

- **依赖及运行环境**：同步本插件使用的 DSH 直接依赖、开发依赖及 lockfile，声明目标核心兼容范围。旧 peer 范围 `>=0.2.1-alpha.2 <0.3.0` 按标准 semver 不包含 `0.2.2-alpha.2`，已通过本地 semver 验证。Node 要求对齐目标 CLI 的 `>=24.9.0`。插件版本升级至 `0.2.2-alpha.2`。
- **模型选择**：`ModelSelectionRef` 已删除；`installModelSelection` 改为单参数，只负责切换提示。模型、reasoning effort 的读写统一通过 `agent.model.current()` / `agent.model.select()`；提示监听器在 create/resume 的 setup 阶段安装。新会话仍使用 Host 默认模型服务，用户修改仍保存全局默认；Session 内选择由核心持久化。删除重复扫描模型选择日志和 reload 专用补写，避免界面与路由分离。
- **自动 reasoning effort**：未显式选择时保持 omission，不把 adapter 默认档保存为用户选择；切换模型、恢复会话、reload 后维持该语义。保留现有 Shift+Tab 按可用档位循环。
- **子代理预设**：standard、ptc、cordis 删除已移除的 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 行；主入口已经注册 `list_agents`。同步删除根 patch 对旧行的禁用。把 `modelSelectionSettings` 改为 `modelSelection`，在 spawn 实例启用 `modelDiscovery`，不为 fork 开放独立模型选择。
- **PTC 执行器**：以 `@deepseek-ai/dsh-tool-executor-ptc` 替换已弃用的 `dsh-agent-tool-presentation` 配置；保持现有 PTC 工具卡片及审批行为。

主要文件：`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、`presets/`、`src/runtime/agent.ts`、`src/ui/app.ts`、`src/ui/commands/model.ts`。

### 2. 模型目录与权限问答

- **角标**：从 `llm.listModels()` 保留 `badge`，按 Host locale 解析 `LocalizedText`，使用现有 palette 映射 tone；角标仅影响列表展示，不写入模型选择或请求。
- **实时刷新**：模型选择器打开期间订阅 `llm/models-updated` 和 provider 拓扑变更，重新读取 Host 目录；保留搜索文本和当前选中模型。失败保留已有结果并显示状态；取消或关闭后释放订阅，忽略晚到结果。不要另建定时刷新缓存。
- **权限问答**：识别 `intent.kind: approval`，只显示调用方声明的 approve/reject/always 选项，不附加 Other 或跳过。展示 detail 和 subject 名称；展示文本与答案值分离，授权以原始 option label 编码，不按文案或位置推断。Esc/signal 仍取消请求，未知 intent 保留通用问答。

主要文件：`src/ui/model-catalog.ts`、`src/ui/commands/services.ts`、`src/ui/commands/model.ts`、`src/ui/dialogs.ts` 及对应测试。新增职责优先独立模块，所有源文件不超过 1000 行。

### 3. 投影与统计读取

核心保留 registry 级 `sessionProjections.stateOf(session, key)` 的兼容实现，但首次读取每个 key 会报告弃用。优先迁移至领域服务或通过 await 注册获取的投影 handle；检查 `tokenMeter.contextPressure()` / `measure()` 和现有统计 wire view，避免重建第二套 Host 投影。若没有提供等价数据的公共读取面，则保留最小兼容读取并明确记录，不用不完整数字替换现有统计。

必须保持上下文占用、压缩阈值、组成分项和 Session 总计的既有含义；性能收益必须经测量后才可声称。

### 4. 可直接继承的 Host 修复

升级后回归验证，不在 TUI 重复实现：

- `job_output(wait: true)` 被用户 steer 提前唤醒；现有 TUI 运行中发送消息已调用 `agent.steer()`。后台任务本身不应被这次唤醒终止。
- glob 的固定目录前缀与目录过滤剪枝。
- 部分技能根不可读时仍发布其他根的可用技能。
- pi-ai 后续 system reminder 和 Gemini 工具调用签名回放修复。

### 5. 本轮不实施

- `vm-script` / `scriptPersistence`：保留核心现有配置能力，不改变默认执行模式。Script 不支持顶层 return，不能无提示切换现有函数体程序。
- Liveshare：需要独立服务端、认证和分享权限，另行立项。
- 自动启用 `plugin_manager`：官方 standard 已支持按 profile 条件开放，但本插件当前默认禁用。维持既有权限范围，不随依赖升级自动扩大模型权限。
- 无关 GUI、国际化扩展和架构重构。

## 验证与验收

以下为计划，不表示已经通过。实施期间在本节记录实际命令与结果。

1. 新依赖下执行 `pnpm typecheck`，新增/调整模型选择、预设组合、目录刷新和权限问答单元测试。
2. 执行 `pnpm check`，确认构建、测试及源文件行数符合本仓库约定。
3. 使用隔离 DSH_HOME 和匹配版本的 CLI 做 fake-TTY 验证，不修改用户默认 home、profile 或全局安装。探针加载目标版本，不能用旧全局 CLI 的通过结果代表新核心。
4. 真实 Host 验证四套 preset 的 create/resume、模型切换、reasoning default、reload、native/PTC 工具及审批；覆盖等待任务时 steer、问答取消、权限拒绝和目录刷新晚到结果。
5. 有凭据或外部服务才能执行的检查单列为未验收，不打印 token，不声称已通过。
6. 文档同步 README 中的版本、Node 要求和用户可见行为。检查 `git diff --check` 和最终 diff，不提交 dist、tgz、探针 profile 或敏感配置。

验收标准：目标核心可加载插件及全部预设；显示模型与实际请求路由一致；显式 effort 与自动 effort 正确持久化；目录刷新不丢失交互状态；权限问答不提供无效授权动作；既有测试通过，新增失败路径有覆盖。

## 基线与交付记录

- 升级前代码基线固定为 `8d4ca9d`，tag `v0.2.1-rc.3` 指向该提交，不指向后续文档或适配提交。
- 文档单独提交并随 main 推送，之后开始实施。后续适配提交是否发布及最终版本 tag 另行记录，不把基线 tag 移到新代码。
- 本仓库没有 `doc-sync` / `test:docs` / lint 脚本，文档采用本仓库现有中文设计文档惯例，使用差异和链接检查；不在核心仓库运行无关的文档生成器。

## 实施进度与证据

- [ ] 文档与基线 tag 已推送。
- [ ] 目标依赖、模型选择和 preset 迁移完成。
- [ ] 目录角标、实时刷新和权限问答完成。
- [ ] 投影读取完成或有明确兼容保留说明。
- [ ] 单元测试、构建、隔离 Host 探针完成，未验收项已列明。
