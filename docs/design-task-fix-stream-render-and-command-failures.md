# 流式渲染性能与命令失败边界修复

> 状态：已完成；验证范围与限制见末节
> 审查基线：`c0cf9e6`（工作树干净，`pnpm typecheck` + 94 文件 / 1298 项测试通过）
> 审查方式：只读走查 + 本机实测（macOS / Node v24.22.2），复用 `scripts/bench-transcript.ts` 并新增拆分计时与临时探针

## 目标与边界

修复审查确认的 7 项问题：流式帧渲染成本随单条回复线性增长、状态栏重复推导交互模式、metrics 全量折叠、状态栏无变化重绘、MCP 工具状态多服务重复扫描、命令分发缺少失败边界、弹窗 abort 复查缺失。

不改 Host/provider 协议、不改持久化事件、不改配置项、不升级依赖、不修改真实 profile；保持现有渲染语义（同样的换行与配色）与命令行为。

## 问题清单

| 编号 | 优先级 | 问题与证据 | 修复方向 |
|---|---|---|---|
| P1 | 高 | 流式帧每帧重排整段文本：场景 F（600 轮 + 10,000 thinking delta）中位 6.6 ms，其中 `renderer.set` 0.44 ms、`container.render` 6.01 ms；单条 reasoning 200KB 时 7.97 ms/帧。pi-tui `Text`/`Markdown` 仅在「文本相等」时命中缓存，流式每帧文本都变 | 新增增量组件：`StreamText` 按完整源码行缓存换行结果，`StreamMarkdown` 按空行/围栏边界切「已冻结前缀 + 实时尾部」 |
| P2 | 中 | `InteractionModeService.current()` 在每次状态栏重绘（`app.ts:512`）和每次工具执行（`planDenial`）都重新推导；无 plan-mode 的 preset（minimal/cordis）落到 `commands.list(agent).some(...)`，而 Host 的 `list` 每次 `map`+`sort`+冻结新数组 | 改用 `commands.find`，并按 agent 缓存「是否有 plan 命令」，在 `commands/change` 时失效 |
| P3 | 低 | 状态栏 metrics 每次 settlement 全量折叠整段日志（`metrics.ts:444`），累计 O(n²)：600 事件 0.067 ms、30k 事件 0.364 ms、120k 事件 1.799 ms | 把折叠拆成可续算状态：同一日志前缀只处理新增后缀；meter/window 变化只重算结论 |
| P4a | 低 | `paintStatus` 无条件 `setText` + `tui.requestRender()`；`Text.setText` 对相同字符串也失效缓存，投影/状态事件即使无可见变化也会触发全树渲染 | 三行 chrome 文本先比较再写入，无变化则不请求重绘 |
| P4b | 低 | `mcp-manager.syncToolState` 在每个 `tools/change` 上对每个 server 调一次 `liveTools()`（每次都 `registry.schemas()` 全表 map+filter），O(servers × tools) | 每次事件只读一次 schemas，按前缀分桶 |
| F1 | 中 | 命令分发无兜底异常边界：`app.ts:790/875/876` 丢弃 Promise，`router.ts` 只有 `default` 分支 try/catch，`runCodebuddyCommand` 缺少 `runCodexCommand` 的失败边界；任一 handler 抛错 → unhandled rejection → 进程退出 | `runCommandLine` 增加顶层失败边界（转为 error notice），并给 codebuddy 命令补同样的边界 |
| F2 | 低 | `showTextInput`/`showMultilineInput`/`showStyledTextPager`/`showImagePreview`/`showMultiChoice`/`showSettingsPanel` 注册 abort 监听后没有复查 `signal.aborted`，与 `showChoice`/`showSearchChoice` 不一致 | 注册后补一次 `if (signal.aborted) onAbort()` |

## 方案

### P1 增量文本与 Markdown

- `src/ui/stream-text.ts`：`StreamText(text, style)`。换行只依赖各自的源码行（`wrapTextWithAnsi` 按 `\n` 分行处理），所以「已完成行」的换行结果在追加后不变；组件只缓存这些行的渲染结果，每帧只重排末尾未完成的一行。样式按行施加，避免把 ANSI 状态跨切片传递。输出与 `new Text(style(text), 0, 0).render(width)` 逐字节一致（含补白）。
- `src/ui/stream-markdown.ts`：`StreamMarkdown(text, theme)`。在围栏代码块之外的空行处切分，且要求下一行不缩进（避免拆开列表/引用续行）；切出的前缀交给已冻结的 `Markdown` 组件，尾部交给实时 `Markdown`。两个组件之间补一个空行，与单组件渲染的块间距一致（探针已验证 paragraphs/heading/list/loose list/fence/quote/table 七种形态逐字节相同）。仅在文本 ≥ 4 KiB 且处于 live 时启用，短消息仍走单组件，行为不变。冻结块按 8 KiB 上限合并，避免组件数量随段落数增长。
- `src/ui/assistant-message.ts`：reasoning 正文改用 `StreamText`，markdown 正文改用 `StreamMarkdown`；组件复用与 `body.setText` 契约不变。
- `scripts/bench-transcript.ts`：新增场景 G（带换行的 reasoning 流）与 H（markdown 段落流），使改进可复测。

### P2 交互模式

`plan()` 的命令探测改为 `commands.find(agent, 'plan')`，结果按 agent 缓存在 `WeakMap`；`commands/change` 时清空。缓存初始探测之外的唯一失效来源就是注册表变化，因此不会冻结过期的「不可用」结论。

### P3 metrics

把 `collectSessionMetrics` 的内部累加改为 `MetricsFoldState`：记录已处理事件数与最后一个事件身份，同前缀续算；`hasStats` 翻转、日志缩短或被替换时重建。`collectSessionMetrics` 保留为「从零折叠」的薄封装。

### P4a / P4b / F1 / F2

见上表「修复方向」；F1 的 notice 文案沿用 `Command failed: <message>`，与 Host 命令分支一致。

## 验收

- P1：`StreamText`/`StreamMarkdown` 在多种宽度、多次追加、替换、Unicode 与围栏场景下与 `Text`/`Markdown` 输出逐字节一致；`bench-transcript` 场景 F/G/H 可对比。
- P2：`interaction-modes` 现有 59 项测试保持通过；新增「命令表变化后重新探测」用例。
- P3：`metrics` 现有测试保持通过；新增「追加事件与全量折叠结果一致」「meter 变化不重扫」用例。
- F1：新增「handler 抛错转为 notice 且不 reject」用例。
- 全量 `pnpm check`（typecheck + vitest + build）通过；`git diff --check` 通过；改动源文件均 < 1000 行。
## 实施记录

- P1：新增 `src/ui/stream-text.ts`（按完整源码行缓存换行结果，样式按行施加）与 `src/ui/stream-markdown.ts`（按「围栏之外的空行且下一行不缩进」切「冻结前缀 + 实时尾部」，4 KiB 门槛，冻结块 8 KiB 合并）。`src/ui/assistant-message.ts` 的 reasoning 正文改用 `StreamText`、markdown 正文改用 `StreamMarkdown`，组件复用与 `body.setText` 契约不变。
- P2：`src/interaction-modes.ts` 用 `commands.find` 替代 `list().some()`，按 agent 缓存探测结果，`commands/change` 时整体丢弃；保留只有 `list` 的实现的兼容分支。
- P3：`src/runtime/metrics.ts` 把折叠拆成 `MetricsFoldState` + `foldEvents` + `finalizeMetrics`；memo 只读新增后缀，meter/window/projection 变化只重算结论并保留对象身份。
- P4a：`src/ui/app.ts` 三行 chrome 文本经 `chromeRow` 去重写入，无变化时跳过 `syncWindowTitle` 与 `tui.requestRender`。
- P4b：`src/mcp-manager.ts` 新增 `liveToolSets()`，`syncToolState` 每个 `tools/change` 只读一次 registry。
- F1：`src/ui/commands/router.ts` 增加顶层失败边界（内部 `dispatchCommandLine` 可抛，`runCommandLine` 转为 error notice）；`src/runtime/codebuddy-command.ts` 补上与 `runCodexCommand` 对称的边界。
- F2：`src/ui/dialogs.ts` 新增 `bindAbort`，七个弹窗与 `src/ui/settings-panel.ts` 统一走它。
- 基准：`scripts/bench-transcript.ts` 新增场景 G（带换行的 reasoning 流）与 H（markdown 段落流）。

## 验证记录

### 全量门禁

`pnpm check`：typecheck、96 个测试文件 / 1337 项测试、build 全部通过；`git diff --check` 通过。改动源文件最长 `src/ui/app.ts` 988 行，全部低于 1000 行。

新增测试：`tests/stream-text.spec.ts`（26 项，与 `Text` 逐字节等价的追加/替换/宽度变化/tab/Unicode 覆盖）、`tests/stream-markdown.spec.ts`（7 项，段落/标题/列表/松散列表/引用/表格/围栏含空行的等价性）、`tests/router.spec.ts` +2（handler 抛错与 context 不可建都不再 reject）、`tests/interaction-modes.spec.ts` +1（`commands/change` 后重新探测）、`tests/dialogs.spec.ts` +2（`bindAbort` 的已中止与后续中止）、`tests/metrics.spec.ts` +1（追加续算与替换重算）。

### 基准对比（同一夹具、同一脚本）

环境：macOS、Node v24.22.2、120 列、`node_modules/.bin/tsx`。基线由 `git worktree add --detach .tmp/legacy-tree HEAD` 取得，两侧运行同一份 `scripts/bench-transcript.ts`。

| 场景 | 基线（HEAD） | 当前 | 说明 |
|---|---:|---:|---|
| A–E（仓库既有场景） | 0.1–1.3 ms | 0.1–1.3 ms | 噪声范围内不变 |
| F：600 轮 + 10,000 个无换行 thinking delta | 6.4 ms | 6.5 ms | 未改善，见「限制」 |
| G：200 轮 + 带换行的 reasoning 流（约 170 KB） | 13.8 ms | 2.8 ms | 4.9x |
| H：200 轮 + markdown 段落流（约 170 KB） | 29.6 ms | 0.6 ms | 49x |

metrics 折叠（30k 事件日志追加一个事件）：续算 0.011 ms，对比每次全量折叠 0.374 ms。

### 探针

`DSH_CLI_ENTRY=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 下运行：`fake-tty-stream-smooth`（pass true）、`fake-tty-stream-chunks`（10 个 chunk、pass true）、`fake-tty-main-screen-scroll`（2 轮 26 chunk、0 次清屏、pass true）。

`fake-tty-reasoning-stream` 与 `fake-tty-approval` 需要预先准备的独立 profile home（前者要求 `/tmp/dsh-native-tui-*` 下的 TUI profile；后者从真实 `~/.dsh/profiles/tui` 复制，被权限拒绝），本轮未运行，未据其声称通过。

## 限制与未验证范围

- 单个超长源码行不获益：场景 F 的 reasoning 全程没有换行，`StreamText` 只能按完整源码行切分，因此仍是每帧重排整行（6.5 ms，与基线相同）。覆盖这种形态需要复刻 pi-tui 的 ANSI 分词器以取得换行偏移，风险高于收益，本轮不做。真实模型输出含换行（G/H 即其形态）。
- Markdown 切分只落在「围栏之外的空行、且下一行不缩进」处；跨空行的松散列表与块引用在切分后按相邻块渲染。单测覆盖的形态逐字节一致，但未穷举全部 Markdown 构造。文档一旦出现引用式链接或脚注定义就整篇单组件渲染（见「审查复核后的补充修复」），这类文档不享受切分收益。
- `StreamText` 的等价性以 `Text`（paddingX=0、无背景色）为基准；带自定义背景色的场景未覆盖。
- 未做真实终端（不同终端模拟器、不同宽度）与真实 provider 的端到端性能测量；基准只反映组件与 reducer 成本。
## 审查复核后的补充修复

首轮实现完成后又做了一次自查（覆盖遗漏、新引入风险、对既有功能的影响），确认并处理了下列问题：

- **F1 残留**：`src/ui/app.ts` 的 `pickStoredSession(...).then(...)` 只有成功回调，`commandContext()` 或 `host.get` 抛出仍会变成未处理 rejection。已补 rejection 处理，转成 error notice。
- **P1 语义边界**：`StreamMarkdown` 增加引用式链接 / 脚注定义守卫（`^ {0,3}\[[^\]]+\]:`）。这类定义按整篇文档解析，切分会让另一半看不到它；出现定义后该文档改用单组件渲染。探针确认差异真实（有定义 → OSC 8 超链接；无定义 → 字面量），并有 3 项新测试锁定。
- **P4a 可维护性**：去重逻辑抽成 `src/ui/status-rows.ts`（`createStatusRows`），`app.ts` 从 988 行降到 969 行，并新增 4 项单测。
- **P4b 去重**：`liveToolSets`/`liveTools` 合并为「一次扫描 + 共享空集合 `NO_TOOLS`」，删除不再使用的 `toolNamePrefix`；新增 1 项「每个 `tools/change` 只读一次注册表」用例。
- **细节**：`StreamText.wrappedCharacters` 标注 `@internal`；`StreamMarkdown` 局部变量 `frozen` 改名 `prefix`；`sync()` 里「冻结前缀不匹配」只丢弃组件、不再重置扫描状态；`planCommands` 注释写明依赖 Host 的 `commands/change`。

### 补充验证

- `pnpm check`：typecheck、97 个测试文件 / 1345 项测试（较上轮 +8）、build 全部通过；`git diff --check` 通过。
- 新增用例：`tests/status-rows.spec.ts` 4 项；`tests/stream-markdown.spec.ts` +3（定义在文末、定义后到、脚注）；`tests/mcp-manager.spec.ts` +1（注册表读取次数）。
- 基准复测：G 3.0 ms、H 0.7 ms，与守卫前一致（守卫只对新增行做一次正则匹配）。
