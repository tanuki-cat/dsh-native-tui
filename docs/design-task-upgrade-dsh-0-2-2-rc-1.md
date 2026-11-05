# DSH 0.2.2-rc.1 适配与功能补齐

> 状态：已完成（不含另行实施的工作树与 PR 审查入口）
> 日期：2026-11-05
> 插件基线：`bdf0074f882d31534b870dc6510e025645a335e1`，已发布 `v0.2.2-alpha.2`
> 核心对比：`dsh-v0.2.2-alpha.2` → `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）

## 评估结论

值得升级，但不能只替换依赖版本。下表记录版本标签源码与插件调用点的静态对比；适配后的运行验证与边界见文末实施记录。

| 项目 | 已确认事实 | 处理 |
|---|---|---|
| Schedule | 插件仍把 list 当数组、create 当 Session 首参、delete 当服务方法；rc.1 改为宿主级分页 list、带 timing/target 的 create 和 edit | 必须迁移，并补齐任务管理 |
| Cordis | rc.1 使用 4.1.0；插件 peer 为 ~4.0.6-alpha.1 | 对齐直接、开发与 peer 依赖 |
| 文件观察策略 | rc.1 base 默认关闭先读后写与外部修改防护 | bundle 显式保持启用，仍允许上层 profile 覆盖 |
| apply_patch | rc.1 提供多文件补丁，实际 shipped 配置默认关闭；结果包含已有渲染器可读的 meta.diffs | 保持默认关闭，提供显式启用配置，覆盖部分成功和删除/移动 |
| 安装诊断 | 当前展示读取 error.message；核心提供 error.diagnostic、packageResult 和 install-log 事件 | 展示失败阶段、原始诊断与完整日志位置 |
| 统计 | 核心新增按提交事件合并的 onEventChanged；插件每个事件刷新并读取多个 snapshot | 按相关投影变更更新统计，保留实时输出路径；不预先声称性能提升 |
| 发送草稿 | 当前 submit 在 Host 接收前清空输入，失败仅报错 | 成功接收才清空，失败保留文本和附件 |
| 图片数量 | pi-ai 新增图片数量预算；CodeBuddy 独立 adapter 只有字节预算 | pi-ai 随核心继承；CodeBuddy 可选数量预算不猜测网关上限 |
| 插件更新 | 核心已有 listVersions/updateBundle，但 TUI 尚未暴露 | 补齐可更新 registry bundle 的显式确认入口；不用于 link/tgz 自更新 |

## 不重复实现与延期项

- reasoning 签名前缀清理、折叠预览、MCP 自动重连、agent.model 模型选择已有实现。MCP client 在本次标签差异中未改变，不删除本地连接丢失处理。
- 本插件直接使用 Host 服务，不改为 Remote 客户端，不为 RPC 投影帧变化重写 TUI。
- 工作树与 PR 审查入口涉及独立服务和交互，另行实施；不混入本轮核心兼容升级。
- Web 布局、右键菜单等不自动作用于 TUI；不移植无关 GUI。

## 实施顺序

1. 对齐插件版本与 rc.1 DSH/Cordis 依赖和 lockfile；不升级无关依赖。
2. 迁移 Schedule。保留 `/schedule add <seconds> <title>`，明确默认投递到当前会话；增加分页列表、详情、结构化创建/编辑、暂停/恢复、执行与历史。全宿主管理须明确标识；删除与立即执行需要确认。编辑携带读取版本，冲突不覆盖。
3. 显式保留 fs-observation-policy；完善安装结果、失败日志和阶段展示。
4. 可选启用 apply_patch，复用既有 diff 卡片，不实现第二套 patch 执行器。完整预检不等于执行回滚；部分执行必须保留已完成效果与失败信息。
5. 使用投影事件合并统计更新，合并同次统计 snapshot；切换会话与关闭时解除订阅，不影响流式正文。
6. 修复提交失败保留草稿和附件，新增可独立测试的提交逻辑；不依赖整份 app.ts 的静态字符串断言。
7. 补齐显式 registry 插件更新及可选 CodeBuddy 图片数量预算。
8. 完成受影响单元测试、pnpm check、打包 smoke 与隔离 rc.1 Host 探针，回填真实结果。

## 约束

- 不修改核心源码、全局 dsh、默认 DSH_HOME 或真实 profile。目标运行时仅安装在仓库 `.tmp/` 中。
- 未获新授权不 commit、push 或发布版本。旧版设计文档保持冻结。
- 每个源文件不超过 1000 行；调度、安装诊断、输入提交按职责拆分，不继续扩大 app.ts。
- Schedule 存储 v2 首次写入后旧程序不能直接打开。正式升级前备份，降级须恢复备份；集成探针只用新建临时数据。
- Core 新增工具能力不静默放宽文件权限。用户主动选择的 profile 覆盖优先。

## 验证与验收

- 依赖：typecheck、peer 检查与 build 通过，无混用旧核心版本。
- Schedule：调用 rc.1 真正服务签名；默认当前会话 target、宿主级分页、冲突、取消、删除确认和缺失服务路径有测试。
- 文件：默认 dump-config 中观察策略启用，apply_patch 关闭；显式启用后，native/PTC 路径的工具声明与实际文件效果一致，失败时不冒充全部成功。
- 诊断：保留 error.diagnostic 与 packageResult.output/logPath；安装日志不借用其他请求，不向终端直接输出未净化的控制字符。
- 统计：不相关 key 不触发额外状态重绘；卸载后无回调；状态栏与 /context 数字一致。
- 提交：followup/steer 抛错时文本、附件与历史不丢失；成功仅消费本次提交。
- 集成：使用匹配的 rc.1 CLI、随机临时目录和动态端口；等待明确状态并回收子进程，不使用 sleep 作为通过证据。

## 实施记录

- 2026-11-05：完成静态版本评估后依次实施。插件与全部 DSH 依赖为 `0.2.2-rc.1`，Cordis 4.1.0，schemastery 3.19.0；lockfile 中无 alpha.2 核心依赖。增加 Schedule 与 Plugin Manager 的开发/可选 peer 类型依赖，直接使用 Host 版本化签名。
- Schedule 命令拆到独立模块，覆盖分页、延迟/结构化创建、详情、字段编辑、暂停/恢复、手动执行、确认删除与历史。创建显式使用当前 Session target；更新/删除携带 expectedUpdatedAt；冲突不重试覆盖。七种 timing 与三种 target 均可解析，时间有效性由核心最终校验。
- 根 bundle 显式保留观察策略；四套 preset 提供默认关闭的 `DSH_NATIVE_TUI_APPLY_PATCH=1` 开关。原生/PTC 的补丁卡片传播 stopped 元数据，保留已完成增删/移动 diff 和停止诊断，不隐藏部分成功。
- 安装诊断使用核心 error.diagnostic、stage、packageResult 与 logPath；进度按 requestId 隔离，settlement 后解除订阅。版本查询/更新仅接受 Host 返回的兼容 registry bundle 版本，经确认后调用更新，分别报告目标安装与旧版本恢复结果。
- 统计使用 onEventChanged 合并相关 key，状态/上下文读取共享一次 scoped snapshot；正文仍走原有流式路径。未做吞吐或延迟基准，不宣称量化性能提升。
- 提交逻辑抽成独立模块。实际 pi-tui 会在 onSubmit 前清空缓冲区，因此先恢复该次提交文本，再由 Host 的同步 admission 决定是否消费；失败不清空文本/附件，不写入历史。同步回调产生的新草稿与新附件不被本次提交消费。
- CodeBuddy 新增可选 maxRequestImages；不设置仍仅受字节预算限制。重复图片出现次数分别计数，超限沿用核心图片卸载流程，不猜测厂商上限。

### 实际验证

| 命令或检查 | 真实结果 |
|---|---|
| `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 npm_config_manage_package_manager_versions=false pnpm check` | typecheck、94 个测试文件 / 1297 个用例、build 全通过 |
| `DSH_CLI_ENTRY=<isolated-rc1>/lib/bin.js node scripts/upgrade-core-e2e.mjs` | standard、ptc、minimal、cordis 各自的空白 reload、新建、模型切换、恢复与 reload 通过；有 read 工具的 preset 完成工具往返 |
| `DSH_CLI_ENTRY=<isolated-rc1>/lib/bin.js node scripts/rc1-capabilities-e2e.mjs` | 默认 standard 不暴露补丁；显式启用的 standard/PTC 各完成 Schedule 创建/列表/暂停/恢复/历史/确认删除、未读编辑拒绝、多文件增删移动及磁盘效果核对 |
| `node scripts/mcp-reconnect-e2e.mjs` | 实际 rc.1 MCP client 的断线、重启恢复与手动 reload 后调用全通过 |
| 两套隔离 profile 的 `--dump-config` | fs-observation-policy 的 disabled 为 false；根工具关闭，preset 中保留显式开关表达式；开关实际生效由上述模型请求和磁盘效果验证 |
| `pnpm pack` + 解包 import smoke | 版本为 rc.1；4 个 JavaScript 导出可加载，声明文件与 5 个 bundle patch 齐全 |
| `git diff --check` 与源文件行数 | 通过；app.ts 963 行，所有新增模块均远低于 1000 行 |

证据目录（均 gitignored）：

- 四套生命周期：`.tmp/upgrade-core-aBy0mw`。
- 新能力：`.tmp/rc1-capabilities-owN58X`，含每个 profile 的终端输出、请求与工具返回及 dump-config。
- 打包 smoke：`.tmp/rc1-pack-smoke.R7bIwz`。

实施中由真实 Host 检出并修复 minimal patch 的重复 YAML config 键；由真实编辑器测试确认并覆盖提交前清空缓冲区的行为。探针针对系统提醒与 PTC 结构化返回值分别识别，不依赖 sleep 或把成功补丁重复提交。

安装已核验的候选版本时仅对该次命令使用 minimumReleaseAge 环境覆盖，没有持久化 minimumReleaseAge: 0。IDE MCP 当前打开的是另一项目，未用其结果冒充本仓库构建验证。

未 commit、push 或发布本次改动；未修改全局 CLI 与真实 profile。`dsh --version` 实测仍为 `0.2.2-alpha.2`。使用本插件新版本前必须将实际运行核心升级到 rc.1，并备份旧 Schedule 存储。


## 参考

- [rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)
- [Schedule API 迁移](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/schedule-remote-host-tasks/guide.zh.md)
- [文件观察策略变更](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.zh.md)
