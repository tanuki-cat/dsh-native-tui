# 修复已有文件写入的 diff 展示

## 目标与范围

修复 `write` 覆盖已有文件时只显示新源码、忽略 Host 已记录 diff 的问题，并让 `/tools`、`/tool`、`/diff` 能读取 PTC 子调用。保留实际工具名称，不改变工具执行、权限或 Session 持久化协议。

## 实施方案

1. Transcript 工具块保留 Host 结果的 `operation: create | update`，原生和 PTC 两条归并路径保持一致。
2. `write` 完成且具有真实更新 diff 时复用 edit 的 diff 渲染，保留 `write` 标题。新建、运行中、无 diff 或缺少历史依据时继续使用源码预览。旧记录没有 operation 时，只在 diff 含非 null 的旧内容时采用更新展示；明确的 update 允许纯插入 diff 的 oldText 为 null。
3. 保留错误、部分停止的诊断和实际 diff；不重读文件，不从请求参数虚构修改前内容。
4. 工具日志收集兼容 PTC start/settle，按 callId/subCallId 关联、保留首次调用顺序、首个结果及错误与 diff。支持窗口内只剩 settle 的 PTC 记录，重复回放不覆盖已有结果。工具索引在三个命令之间使用相同的保留窗口。
5. 更新 README 的 write 与工具查看说明，补充持久回归测试及真实 Host 探针。

## 影响区域

- `src/ui/transcript.ts`、`src/ui/tool-card.ts`
- `src/runtime/tool-log.ts`、`src/ui/commands/tools.ts`
- diff 卡片、Transcript、工具日志与命令测试
- `scripts/fake-tty-*.mjs`、README

## 重要约束

- Host 的 diff 可能只是一个变更片段；`oldText: null` 也可能是已有空文件中的插入，不能独立证明新建。
- Host 未提供 diff 时不承诺显示增删行；请求内容仍可预览。
- 保留 Ctrl+O、预览上限、终端转义、标题与状态标记。

## 验证与验收

- 先运行新增回归，确认旧实现失败，再实现修复。
- 覆盖原生/PTC 的 write 更新、创建、纯插入、历史记录兼容、运行中至完成的缓存更新、错误与部分停止。
- 覆盖 PTC 结果关联、对象/字符串参数、缺少 start、重复事件、收集上限，以及 `/diff` 最新/指定索引和 `/tools`、`/tool` 的一致性。
- 运行 `pnpm check`。真实 Host 探针使用独立临时 profile、工作区和本地 mock provider，验证原生/PTC write 实际落盘及终端 diff，验证 `/diff`，并等待子进程与服务器清理完成。

## 验证结果（2026-11-09）

- 新增 31 项回归；首次运行新增测试时，旧实现出现 25 项预期失败。现有 write 源码预览测试的 fixture 改为真实的新建语义，保留原有预览、语法高亮、折叠、错误与转义断言。
- `pnpm check` 通过：typecheck、100 个测试文件 / 1428 项测试、build。
- `node scripts/fake-tty-write-update-diff.mjs` 四组通过：standard/PTC × 普通/全屏。随后同时运行两个独立探针进程，各自四组均通过。
- 探针读取真实落盘文件，并检查终端帧：write 更新显示 `1 - const value = 1` 和 `1 + const value = 2`，已有空文件显示 `1 + EMPTY_INSERTION`，新建文件保持编号源码预览，Ctrl+O 可展开至源码尾行。`/diff` 最新和指定调用索引均可打开正确的 write diff。
- 探针脚本语法检查与 `git diff --check` 通过。Host 探针使用本机 mock provider，未使用真实模型 API；监听本机随机端口需要沙箱外运行权限。
