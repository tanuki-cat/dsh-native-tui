# 终端交互模式

状态：已实现并验证。

## 目标

提供 `/mode manual|accept-edits|plan|auto` 和状态栏模式指示；新会话默认 accept edits，恢复会话沿用已保存的 Host 权限与 plan 状态。Shift+Tab 保留思考强度切换，不复用为权限快捷键。

## 实现约束

- 复用 `permissionPresets` 的持久化身份和 sandbox/approval 设置；不创建第二份模式日志。新增 manual、accept-edits、plan preset，保留已有高级 preset。
- manual 使用 read-only + ask，写操作通过 Host 的一次性扩大权限请求审批；accept-edits 使用 workspace-write + ask，工作区内 write/edit 无额外审批。其他非只读工具保守地请求审批。
- plan 使用 read-only + ask 和 Agent 作用域 `planMode`。工具 guard 拒绝非只读的原生调用和 PTC 内层调用，拒绝扩大 sandbox；`exit_plan_mode` 的用户审核保持交互。
- Auto 只由现成 `dsh-experimental-auto-review` 提供。不能用 danger-full-access + never 冒充 Auto。选择 Auto 时显示风险确认，不能设为新会话默认。
- plan 结束后从已有 `permission/preset` 事件恢复进入 plan 之前的 preset；Host pre-step 中同步，不能从 session/event 监听器重入 append。preset 的 planning 子组隔离了 `planMode`，因此服务不可直读时，通过带官方 definitionId 的 Host `/plan`、`/plan off` 命令切换，并从原生 `plan/mode` 记录读取状态；不增加通用 Host API。原 reviewer/preset 消失时不静默放宽到其他模式。
- 切换模式仅允许在空闲时进行，避免改变正在执行的工具权限。缺失 plan/Auto 服务时拒绝对应切换，不退化为放行。
- Host 的 PTC 外层程序不经过内层工具审核；文件操作仍由当前 sandbox 约束，但不能宣称任意 Node 网络副作用被逐次审核。未知 MCP 工具不被视为可信只读。

## 影响范围

独立的 interaction-modes Host 插件负责权限组合、guard 和 pre-step 同步；命令 handler 负责选择器和 Auto 风险确认；状态栏只读取 Host 状态。`app.ts` 只增加模式字段接线，保持少于 1000 行。

## 验证

- 单元测试覆盖默认值、四种切换、空闲限制、失败不放宽权限、plan 审批退出与拒绝、恢复及 guard 清理。
- 真实 Host mock provider 探针覆盖普通与 PTC 调用、默认工作区编辑、Manual/Plan 写入限制、Auto 审核允许和拒绝，以及 UI 模式标签。
- `pnpm check`、`git diff --check` 与独立并发探针。

## 验证记录

- `pnpm check`、`git diff --check` 通过。
- `node scripts/fake-tty-interaction-modes.mjs native`：真实 Loader、权限执行和临时文件效果通过，包含四模式、plan 保持/批准、Auto 允许/拒绝/审核错误与恢复原会话 Auto 状态。
- `node scripts/fake-tty-interaction-modes.mjs ptc`：同一组受控工具边界通过。当前外层 macOS sandbox 不允许嵌套 sandbox-exec；该测试经一次性更宽执行授权，保留了被测文件 sandbox，没有关闭限制来获取通过结果。
- 两个独立 native 探针进程并发通过，分别分配端口、临时 workspace 和 DSH_HOME。
- 探针使用 mock provider 驱动真实 Host 审核流程，不代表任何真实模型的风险判断准确率。
