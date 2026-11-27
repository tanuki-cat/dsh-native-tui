# 第三轮全量代码审查与修复计划

> 2026-11-28 审查记录。基于当前工作区（`src/` 共 28,883 行），按**安全漏洞**、**性能与资源管理**、**TUI 渲染与异步状态**三路完成全量只读审查。本清单排除了前两轮（[第一轮](design-task-fix-audit-security-perf-render.md)、[第二轮](design-task-fix-audit-round-2.md)）已修复的条目，共确认 18 项问题（High 3 项、Medium 9 项、Low 6 项）。
>
> 当前状态：**已修复并验证通过**（18 项全部完成，`pnpm check` 全量通过：144 个测试文件 / 2,112 项测试、类型检查与构建均通过，所有 `src/` 文件均不超过 1,000 行）。

---

## 一、High（3 项）

| 编号 | 状态 | 类别 | 问题与根因 | 涉及文件 | 修复与验收点 |
| --- | --- | --- | --- | --- | --- |
| H1 | 已修复 | 渲染/崩溃 | **`PromptEditor` 遇到超宽字素无限递归崩溃**：`renderEditor()` 直接调用 `super.render(width)`；上游 `pi-tui` 的 `wordWrapLine` 在单个 grapheme 宽度超过 `maxWidth` 时对该 grapheme 递归调用自身，触发 `RangeError: Maximum call stack size exceeded`（极窄终端输入中文或 80 列粘贴超长组合字符均崩溃）。 | `src/ui/prompt-editor.ts:180-181` | 保护 `renderEditor`（以及输入/粘贴路径），对宽度超过可用列宽的单个 grapheme 拆解/截断并在极窄宽度下安全兜底；补单测覆盖极窄宽度中文与超长组合字符。 |
| H2 | 已修复 | 性能 | **无换行的流式文本每帧全量重排（O(N²)）**：`StreamText` 仅在 `\n` 推进 `committedTo`，长无换行 detailed thinking 每帧重排全文（82.6KB 单行 3.48 ms/帧，基准 F 达 5.2 ms/帧）。 | `src/ui/stream-text.ts:99-118` | 将提交边界扩展到可视行边界，增量保留已定型包装行，仅重排尾部；补无换行流式增量渲染单测，确认 wrapped 字符数不再 O(N²) 增长。 |
| H3 | 已修复 | 状态/交互 | **`/workspaces use` 在 turn 运行中切会话会静默取消 turn 并丢弃排队 prompt**：缺少 `/new`、`/resume` 已有的 `agent.status === 'running'` 守卫。 | `src/ui/commands/workspace.ts:81-88` | 在 `/workspaces use` 切会话前拦截 `ctx.active.agent.status === 'running'` 并输出明确警告；补单测验证运行中拒绝切换。 |

---

## 二、Medium（9 项）

| 编号 | 状态 | 类别 | 问题与根因 | 涉及文件 | 修复与验收点 |
| --- | --- | --- | --- | --- | --- |
| M1 | 已修复 | 安全 | **`/context` 报告未清洗 `compaction.route`，存在终端转义序列注入**：`ContextReportMessage` 绕过 notice 的 `sanitizeTerminalText`，自定义 provider 返回的含 ESC/OSC 的 model id 可直达终端。 | `src/ui/commands/context-stats.ts:76-79`、`src/ui/context-report.ts:16-19` | 在 `contextReport()` 插值前对 `compaction.route` 单独调用 `sanitizeTerminalText()`，保留 palette 着色；补单测验证 ESC/OSC 被剥离。 |
| M2 | 已修复 | 安全 | **deliverable 越界检查与读取之间存在 TOCTOU 竞态**：`resolveContainedDeliverable` 用 `realpath` 检查后再由 `readBoundedFile` 按路径重开，未共享 FD 且未传 `O_NOFOLLOW`。 | `src/runtime/deliverables.ts:22-25`、`src/runtime/bundle.ts:338-345`、`src/runtime/files.ts` | 新增通过 `O_NOFOLLOW` 打开并在同一 FD 上校验真实路径的有界读取辅助函数（校验失败立即关闭 FD），`bundle.ts` 改用该原子化读取；补单测验证符号链接拒绝与正常读取。 |
| M3 | 已修复 | 性能 | **冷启动/切换会话全量折叠全部事件后再裁剪窗口**：`append()` 为全部历史事件构建 block，直到 `reduce()` 才裁到 `maxEntries`（10 万事件耗 45.7 ms / 59.3 MiB）。 | `src/ui/transcript.ts:857-867`、`src/ui/transcript-window.ts` | 在 `transcript` 窗口超限时于 `append()` 周期性收紧历史 block 并推进 `retainedFrom`（保留活跃 tool call / assistant 索引一致性），补大事件量单测。 |
| M4 | 已修复 | 性能 | **工具输出预览先全量规范化、后截断到 64KB**：`ToolOutput` 与 `WriteCard` 对 MB 级文本先全量 `literalToolText` 再截取窗口（5.75MB 耗 18.5–35.2 ms）。 | `src/ui/tool-output.ts:77-86`、`src/ui/write-card.ts:31-38` | `ToolOutput` 先按字符预算截取头/尾窗口再 `stripTerminalSequences` + `literalToolText`；`WriteCard` 先按行截取再规范化；补大输入单测。 |
| M5 | 已修复 | 性能 | **目录排序每次比较新建 `localeCompare` options 对象**：3 万次比较耗时 97.1 ms，比模块级 `Intl.Collator` 慢约 40 倍。 | `src/runtime/files.ts:15-17` | 改为模块级 `const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })`，比较用 `NAME_COLLATOR.compare`。 |
| M6 | 已修复 | 渲染 | **transcript 中部分 `Text` 行未做宽度裁剪，超宽字素会触发主屏抛错**：notice 与 tool 错误行直接返回 `new Text(...)`，未经过 `clipLine` / `truncateToWidth`。 | `src/ui/transcript-render.ts:98-105`、`src/ui/tool-card.ts:164-167` | 为 notice 与 tool 错误行包一层宽度裁剪（确保输出每行 `visibleWidth <= width`）；补超宽字素渲染单测。 |
| M7 | 已修复 | 渲染 | **模态列表 `maxVisible` 写死 11–12，矮终端下选中项滚出可视区**：overlay 截断底部行但列表不滚动，Enter 会提交不可见项。 | `src/ui/dialogs.ts:90,149-152,695`、`src/ui/settings-panel.ts:109` | 根据 `tui.terminal.rows` 与 overlay `maxHeight` 动态计算 `maxVisible`（`SettingsList` 每项占两行需折半），并在 render 时随高度调整；补矮终端单测。 |
| M8 | 已修复 | 渲染 | **compact thinking 预览按 grapheme 数量而非显示列宽限长**：240 grapheme 对 CJK/emoji 可达 480 列且省略标记插 `\n` 破坏单行紧凑布局。 | `src/ui/grapheme-preview.ts:49-54`、`src/ui/assistant-message.ts:78` | 改用 `visibleWidth` / `truncateToWidth` 控制列宽并将省略标记保留在同一行；补宽字符单测。 |
| M9 | 已修复 | 交互 | **问题弹窗截断后提示 “View full request details”，但无对应交互入口**：`ChoiceDialog` 与 `MultiChoiceDialog` 超 4 行后内容永久不可见。 | `src/ui/dialogs.ts:99-103,738-741` | 参照 `showApproval` 为问题弹窗增加查看完整详情入口（或按需提供 `View full details` 选项调用 `showApprovalDetails`），补单测。 |

---

## 三、Low（6 项）

| 编号 | 状态 | 类别 | 问题与根因 | 涉及文件 | 修复与验收点 |
| --- | --- | --- | --- | --- | --- |
| L1 | 已修复 | 安全 | **自定义 provider 允许非本地主机使用明文 HTTP**：`normalizeBaseURL` 未限制非 loopback 的 `http://`。 | `src/runtime/providers.ts:92` | `https:` 全放行，`http:` 仅允许 loopback（`localhost`、`127.0.0.1`、`::1`、`127.*`）；更新并补充 `tests/providers.spec.ts`。 |
| L2 | 已修复 | 安全 | **OAuth / secret 输入框屏幕明文回显**：`showTextInput` 的 `secret` 参数仅影响文案，终端仍明文回显输入内容。 | `src/ui/dialogs.ts:205`、`src/ui/commands/codex.ts:26-37` | 为 `TextInputDialog` 增加 `secret` 掩码渲染模式（屏幕显示 `*` 掩码，提交真实值），并同步 `showTextInput` 选项与单测。 |
| L3 | 已修复 | 性能 | **`StreamMarkdown` 每帧复制完整已冻结前缀**：用 `frozenText` 字符串副本而非 `frozenLength: number` 追踪边界。 | `src/ui/stream-markdown.ts:160-176` | 改为 `frozenLength: number` 追踪已冻结长度，增量切片仅取新增区间；验证现有与新增单测。 |
| L4 | 已修复 | 性能/内存 | **`toolMemory` 会话级索引只增不减**：`callBySeq`、`knownCalls`、`settled` 仅在清屏/切会话清空。 | `src/ui/transcript.ts:420-424`、`src/ui/transcript-renderer.ts` | 在窗口裁剪推进 `retainedFrom` 时按有界容量/seq 清理过期 `callBySeq` 及无用索引，防止超长会话无界增长。 |
| L5 | 已修复 | 性能 | **`SkillCache` 无并发去重（single-flight）且不缓存失败**：catalog 不可用时每次按键重复查 Host。 | `src/ui/skill-cache.ts:45-60` | 按 `agent + cwd` 复用 in-flight Promise，并对失败结果做短周期 TTL 负缓存，校验代次防旧响应覆盖。 |
| L6 | 已修复 | 渲染 | **多处截断按 UTF-16 `.slice()` 切割，可能切断代理对/ZWJ 组合**。 | `src/ui/tool-preview.ts`、`src/ui/code-execution-card.ts`、`src/ui/edit-card.ts`、`src/ui/write-card.ts`、`src/ui/tool-card.ts` | 统一改用代理对/字素安全截断（`safeCut` / `safeTailStart` / `truncateToWidth`），补 emoji 截断单测。 |

---

## 四、实施分组

1. **A 组（安全与运行时 I/O）**：`H3`、`M1`、`M2`、`M5`、`L1`。
2. **B 组（性能与内存）**：`H2`、`M3`、`M4`、`L3`、`L4`、`L5`、`L6(write-card)`。
3. **C 组（TUI 渲染、宽度与弹窗交互）**：`H1`、`M6`、`M7`、`M8`、`M9`、`L2`、`L6(其余卡片)`。
