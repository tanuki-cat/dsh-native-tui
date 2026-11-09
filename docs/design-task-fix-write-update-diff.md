# 修复已有文件写入的 diff 展示

## 目标与范围

修复 `write` 覆盖已有文件时只显示新源码、忽略 Host 已记录 diff 的问题，并让 `/tools`、`/tool`、`/diff` 能读取 PTC 子调用。工具卡片按文件操作语义显示标签；Session 日志与工具检查命令保留实际工具标识，不改变工具执行、权限或 Session 持久化协议。

## 实施方案

1. Transcript 工具块保留 Host 结果的 `operation: create | update`，原生和 PTC 两条归并路径保持一致。
2. `write` 完成且具有真实更新 diff 时复用 edit 的 diff 渲染，标题显示 `Edit`。Host 确认 update 但没有 diff 时仍显示 `Edit`，正文回退到源码预览。新建、运行中或缺少历史依据时显示 `Write` 和源码预览。旧记录没有 operation 时，只在 diff 含非 null 的旧内容时采用更新展示；明确的 update 允许纯插入 diff 的 oldText 为 null。
3. 保留错误、部分停止的诊断和实际 diff；不重读文件，不从请求参数虚构修改前内容。
4. 工具日志收集兼容 PTC start/settle，按 callId/subCallId 关联、保留首次调用顺序、首个结果及错误与 diff。支持窗口内只剩 settle 的 PTC 记录，重复回放不覆盖已有结果。工具索引在三个命令之间使用相同的保留窗口。
5. 更新 README 的 write 与工具查看说明，补充持久回归测试及真实 Host 探针。
6. 共用工具显示标签函数：卡片及 PTC 摘要的动作标签首字母大写（`Read`、`Write`、`Edit`、`Grep`、`Ran`），MCP 前缀使用 `MCP`。服务名、方法名、命令、参数和路径保持原样；工具检查命令及审批使用记录中的工具标识。直接 `edit` 调用始终显示 `Edit`，不按内容是否只有新增来改成 `Write`。
7. 展示探针的审批 fixture 可选地等待父进程确认已采集黄色 pending 帧，再发起审批；确认文件放在每组独立临时目录中，保留原有颜色断言，避免快速审批使采样跳过中间状态。

## 影响区域

- `src/ui/transcript.ts`、`src/ui/tool-card.ts`
- `src/ui/tool-label.ts`、`src/ui/write-card.ts`、`src/ui/code-execution-card.ts`
- `src/runtime/tool-log.ts`、`src/ui/commands/tools.ts`
- diff 卡片、Transcript、工具日志与命令测试
- `scripts/fake-tty-*.mjs`、README

## 重要约束

- Host 的 diff 可能只是一个变更片段；`oldText: null` 也可能是已有空文件中的插入，不能独立证明新建。
- Host 未提供 diff 时不承诺显示增删行；请求内容仍可预览。
- 保留 Ctrl+O、预览上限、终端转义、单行标题与状态标记。write 在 Host 确认更新后可以由 `Write` 改为 `Edit`，不增加标题行数。

## 验证与验收

- 先运行新增回归，确认旧实现失败，再实现修复。
- 覆盖原生/PTC 的 write 更新、创建、纯插入、历史记录兼容、运行中至完成的缓存更新、错误与部分停止。
- 覆盖 PTC 结果关联、对象/字符串参数、缺少 start、重复事件、收集上限，以及 `/diff` 最新/指定索引和 `/tools`、`/tool` 的一致性。
- 覆盖直接 edit、write 更新、新建、旧记录、空文件插入、无 diff 回退、错误与停止状态的标签，以及原生/PTC、展开/折叠、plain/dark 的大小写一致性。确认原始工具名称未被修改。
- 运行 `pnpm check`。真实 Host 探针使用独立临时 profile、工作区和本地 mock provider，验证原生/PTC write 实际落盘及终端 diff，验证 `/diff`，并等待子进程与服务器清理完成。

## 验证结果（2026-11-09）

- diff 与工具查看修复新增 31 项回归，标签修复新增 18 项回归；新增标签测试在修复前全部失败。保留源码预览、语法高亮、折叠、错误与转义断言，更新显示标签的大小写断言。
- `pnpm check` 通过：typecheck、101 个测试文件 / 1446 项测试、build。
- `node scripts/fake-tty-write-update-diff.mjs` 四组通过：standard/PTC × 普通/全屏。终端帧确认更新显示 `Edit`、新建显示 `Write`，原始日志工具名仍为 `write`；空文件插入、Ctrl+O 及 `/diff` 最新/指定索引均正确。
- `node scripts/fake-tty-transcript-presentation.mjs` 六组通过：普通/全屏 × 允许/拒绝四组，以及普通 PTC compact、全屏 PTC detailed。随后同时运行两个独立展示探针进程，各自六组均通过；握手文件与 profile 相互隔离，保留运行黄、完成绿、失败红的原有断言。
- 8 个受影响探针文件的语法检查与 `git diff --check` 通过。Host 探针使用本机 mock provider，未使用真实模型 API；监听本机随机端口需要沙箱外运行权限。
