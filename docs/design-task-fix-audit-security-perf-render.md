# 安全、性能与渲染全量审查及修复记录

> 2026-11-24 审查与实施。基于 DSH `0.2.3-alpha.2` 升级后的工作区代码（`src/` 约 27k 行），结合 `@deepseek-ai/dsh-session` 与 `@earendil-works/pi-tui` 实际实现完成安全漏洞、性能与资源泄漏、TUI 渲染与交互三路审计并落地全部 27 项修复。

## 审查与修复清单

### 一、安全与漏洞（9 项）

| 编号 | 级别 | 问题 | 涉及文件 | 修复摘要 |
| --- | --- | --- | --- | --- |
| S1 | 高 | Windows 下 `cmd /c start` 对无空格 URL/路径触发 shell 元字符（`&` 等）注入 | `src/runtime/open.ts` | 改用 `rundll32.exe url.dll,FileProtocolHandler <target>`，移除 `cmd.exe` 壳层解析 |
| S2 | 高 | `interaction-modes` 对非提权或无效 `sandbox_permissions`（如 `read-only` / `null`）直接豁免审批门禁 | `src/interaction-modes.ts` | 仅当 `sandbox_permissions` 严格高于会话当前沙箱等级（`SANDBOX_RANK`）时才交由一层提权审批 |
| S3 | 中 | `ToolCard` 参数摘要未清洗键名导致转义序列注入 | `src/ui/tool-card.ts` | 参数键名同步经 `inline(key)` 转义后再拼接输出 |
| S4 | 中 | 审批详情弹窗仅经 `JSON.stringify` 保留 C1 控制序列（`U+007F–U+009F`） | `src/ui/approval-details.ts` | 将输入文本经 `literalToolText(text)` 转义后再渲染 |
| S5 | 中 | CodeBuddy 自动打开未校验 OAuth URL；`X-Refresh-Token` 等请求未禁用跨域重定向 | `src/codebuddy/profiles.ts`、`src/codebuddy/auth.ts`、`src/codebuddy/stream.ts`、`src/codebuddy/credits.ts`、`src/codebuddy/models.ts`、`src/runtime/codebuddy-command.ts` | 新增 `authHosts` 与 `isTrustedAuthUrl` 仅自动打开受信任 `https:` 地址；全部请求显式配置 `redirect: 'error'` |
| S6 | 中 | `decodeSse` 与多处 `response.text()` 缺少字节上限及流取消 | `src/codebuddy/sse.ts`、`src/runtime/http-body.ts`、`src/codex/usage.ts`、`src/codebuddy/{auth,stream,credits,models}.ts` | `decodeSse` 增加 4 MiB 上限、增量扫描偏移并在提前退出时 `reader.cancel()`；抽共享 `readBoundedResponseText` 限流读取 |
| S7 | 中 | `/deliverables open` 与 `reveal` 未校验工作区和符号链接边界 | `src/runtime/deliverables.ts`、`src/runtime/bundle.ts`、`src/ui/commands/artifacts.ts` | 抽取共享 `resolveContainedDeliverable`，统一词法与 `realpath()` 边界校验 |
| S8 | 低 | `settingsSetAt` 与 `/mcp add` 未屏蔽原型保留键 | `src/runtime/settings.ts`、`src/ui/commands/mcp.ts` | `settingsSetAt` / `settingsValueAt` 禁止 `__proto__`/`constructor`/`prototype` 并改用 `Object.hasOwn`；`/mcp add` 与列表查询同步防御 |
| S9 | 低 | `git-branch` 无上限同步读及 `attachments`/`images`/`bundle` 存在 `stat`+`readFile` TOCTOU、chunk 截断 | `src/runtime/files.ts`、`src/runtime/attachments.ts`、`src/runtime/images.ts`、`src/runtime/bundle.ts`、`src/runtime/git-branch.ts` | 新增 `readBoundedFile`（`O_RDONLY \| O_NONBLOCK` + `fstat` + 实读校验）；`collectFile` 越界改抛错；`git-branch` 同步路径限长 4 KiB |

### 二、性能与资源泄漏（9 项）

| 编号 | 影响 | 问题 | 涉及文件 | 修复摘要 |
| --- | --- | --- | --- | --- |
| P1 | 高 | 每次 `assistant/message` 或 `attempt` 结算都触发全量 `resetReduction()` 并击穿所有 `EditGroupCard` 缓存 | `src/ui/transcript-renderer.ts` | 跟踪 `liveStart`，单步流式尾部结算原地截断 `reducedEntries` 并增量归并；`sameTranscriptBlock` 递归对比 `edits.tools` |
| P2 | 高 | 状态栏重绘与无 `planMode` 时的工具守卫频繁调用 `session.snapshotEvents()` 克隆并冻结全量日志（O(N²)） | `src/runtime/context-reading.ts`、`src/ui/app.ts`、`src/interaction-modes.ts` | 新增 `SessionEventCursor` 与 `WeakMap` 增量游标，经 `seq`/`eventAt` 只读新增事件后缀 |
| P3 | 高 | `TranscriptMainScreen.render` 每帧对全量 scrollback 重复执行 SGR 正则与 `applyLineResets` | `src/ui/transcript-main-screen.ts` | 循环外预计算 `reset`，未变化行直接跳过并复用单次 `replace(sgr, '')` 结果 |
| P4 | 高 | 流式文本每帧全量 `sanitizeTerminalText`；`compact` 思考预览每帧从头正则重扫（O(L²)） | `src/ui/assistant-message.ts`、`src/ui/reasoning-text.ts` | 安全前缀追加改为仅清洗增量片段；`latestCompletedParagraphFirstLine` 改为从末尾 `lastIndexOf('\n')` 反向扫描 |
| P5 | 中 | `decodeSse` 在 `[DONE]` 或 `finish_reason` 提前结束时未 `cancel()` 响应流导致 socket 泄漏 | `src/codebuddy/sse.ts` | `finally` 中在未到 EOF 时调用 `reader.cancel()` |
| P6 | 中 | `TranscriptRenderer.setMaxEntries` 缺少相等性守卫导致启动和设置刷新重复全量重建 | `src/ui/transcript-renderer.ts`、`src/ui/app.ts` | 相同 `maxEntries` 直接返回 `false`，跳过 `resetReduction()`、`streamPacer.reset()` 与重绘 |
| P7 | 中 | `git-branch` 在状态栏重绘路径每 5 秒同步遍历目录树查找 `.git` | `src/runtime/git-branch.ts`、`src/ui/app.ts` | 为 `createGitBranchReader` 增加可选 `onUpdate` 异步刷新与负缓存，分支变化时再触发 `renderStatus()` |
| P8 | 中 | `/export zip` Worker 无法随 Esc 中止且 `postMessage` 整块拷贝压缩产物 | `src/runtime/bundle.ts` | `compressBundle` 接入 `signal` 终止 Worker，写入前再次校验中止，并通过 `[out.buffer]` 零拷贝移交 |
| P9 | 中 | `showMarkdownPreview` 每次按键重建 `Markdown` 实例；`StatusBar.render` 无缓存 | `src/ui/dialogs.ts`、`src/ui/status-bar.ts`、`src/ui/app.ts` | `showMarkdownPreview` 复用 `Markdown` 实例并仅在主题签名变化时 `invalidate()`；`StatusBar` 缓存 `(width, sep)` 渲染行 |

### 三、TUI 渲染与交互（9 项）

| 编号 | 级别 | 问题 | 涉及文件 | 修复摘要 |
| --- | --- | --- | --- | --- |
| R1 | 高 | `SettingsPanel` 的 `selectionRows` 剥离 `InputSubmenu` 硬件光标标记与反显光标 | `src/ui/settings-panel.ts`、`src/ui/selection-row.ts` | 跟踪 `submenuOpen` 跳过子菜单行重写；`selectionRows` 跳过含 `CURSOR_MARKER` 的行 |
| R2 | 高 | 4 个弹窗硬编码原始转义序列，破坏 Kitty CSI-u 按键及搜索框光标/粘贴路由 | `src/ui/dialogs.ts`、`src/ui/approval-details.ts` | 统一使用 `isKeyRelease` + `matchesKey`；`SearchChoiceDialog` 仅将列表导航/确认/取消键交给 `SelectList` |
| R3 | 高 | `showComponentPager` 注册全局 `tui.addInputListener` 劫持上层弹窗按键，且异常分支漏 `hide()` | `src/ui/dialogs.ts`、`src/ui/settings-panel.ts` | 按键处理迁入 `pager.handleInput` 移除全局监听；`catch` 分支补全 `handle?.hide()` |
| R4 | 高 | `dialogFrame` 在 `< 20` 列溢出并在 `20–23` 列内外宽度失配；单行标题出现 `...…` | `src/ui/dialogs.ts`、`src/ui/settings-panel.ts`、`src/ui/approval-choice.ts` | `width < 6` 降级无边框裁切，所有弹窗统一 `inner = Math.max(1, width - 4)` 并统一单省略号 `…` |
| R5 | 高 | `StreamMarkdown.scanBlocks` 在嵌套/缩进代码块中误翻 `inFence`，并漏检无换行末行引用定义 | `src/ui/stream-markdown.ts` | 改为跟踪围栏字符与长度（`<= 3` 前导空格）并单独检测末行 `REFERENCE_DEFINITION` |
| R6 | 中 | `truncateToWidth` 注入 `\x1b[0m` 导致 6 处背景色带中断 | `src/ui/theme.ts` | 新增 `band()` 包装器，在内部 `\x1b[0m` 后自动补回背景色开启序列 |
| R7 | 中 | 极窄宽度下包含 CJK 的 `EditGroupCard` 差异行与 `BarText` 可能越界崩溃 | `src/ui/edit-group.ts`、`src/ui/bar-text.ts` | 显式处理 `width <= 0` 与窄宽分支，输出行统一经 `truncateToWidth(..., width, '…')` 收口 |
| R8 | 中 | `StatusBar` 分隔符在 OSC 10/11 延迟回报或亮暗切换后残留旧颜色 | `src/ui/status-bar.ts`、`src/ui/app.ts` | `StatusBar` 支持分隔符回调 `() => palette.dim(' · ')`，主题更新时调用 `invalidate()` |
| R9 | 中/低 | `PasteInput.cancel()` 残留 `task` 阻塞后续输入；UTF-16 `.slice()` 截断代理对；`@file` 补全鼠标列偏移 | `src/ui/paste-input.ts`、`src/ui/prompt-editor.ts`、`src/ui/tool-output.ts`、`src/ui/status-line.ts` | `cancel()` 清空 `task` 并做任务身份校验；使用 `Intl.Segmenter` 与代理对边界安全切片；限制鼠标列偏移仅作用于输入行 |

## 验证记录

- `pnpm check`（`tsc -p tsconfig.json --noEmit` + Vitest + `tsc -p tsconfig.build.json`）：**通过**，共 **132** 个测试文件、**1,902** 项测试全部通过。
- 源码行数门禁（`find src -name "*.ts" -exec wc -l {} + | awk '$1 > 1000'`）：无任何文件超过 1,000 行。
