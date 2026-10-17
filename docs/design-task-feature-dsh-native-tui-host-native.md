# DSH Native TUI：Host-native 重新实现

> 状态：MVP 已实现并跑通  
> 日期：2026-10-17  
> 取代：[完整 Web 能力方案](design-task-feature-dsh-native-tui-web-parity.md)

## 1. 结论

原计划的“进程内 Web Client 数据层”在 Phase 0 被证伪：DSH 发布的 Client 入口是浏览器模块加载器包装，而不是 Node ESM。例如：

~~~text
@deepseek-ai/dsh-api-session-controller/lib/client.js
  window.__ModuleLoader__.load({ id, factory: (require) => ... })
~~~

该文件依赖浏览器全局 window，不能直接在 Node TUI 进程中 import；只有 client-connection 和 typert-registry 等少数包提供 Node 条件入口。要在 Node 复用完整 Web Client，需要额外构建一整套 Node Client bundle，成本与风险高于直接使用 Host 服务。

因此本实现改为 **Host-native TUI**：

- Agent、Session、持久化、工具、审批、问答、LLM 路由全部来自 dsh-base 的 Host 服务。
- TUI 只拥有一个 AgentHandle 和 pi-tui 终端。
- 通过补充少量 Web Host 行（connection、workspace、file-upload、session-controller、schedule、tool-schedule、tool-ask-user）恢复 Web 模式中 Base 未包含的能力。

## 2. 已实现能力

### 会话与 Agent

- 启动时创建新的 root Agent；Session id 为 native-tui-<uuid>。
- 启动配置 sessionId 时恢复已持久化 Session。
- /new 创建新会话并切换。
- /sessions 列出已持久化 Session（排除 subagent 子会话）。
- /resume <id> 恢复并切换。
- /status 展示 Session、cwd、模型、状态、事件数、创建时间。
- 退出时取消运行中的 turn，dispose AgentHandle，恢复终端。

### 对话与展示

- Enter 发送；运行中 Enter 作为 steer；Ctrl+C 取消；Ctrl+D 退出。
- 流式文本：agent/assistant-stream 的 chunk 帧实时追加，assistant/message 结算后去重。
- Markdown 渲染（pi-tui Markdown）；/open 对 .md/.markdown/.mdx 使用 Markdown 样式化分页预览。
- reasoning 可配置显示。
- 用户消息、上下文卡片、工具卡片（参数/结果/错误）、turn 失败提示。
- 运行状态栏、模型、cwd、Session id、操作提示。
- /clear 仅清空终端视图，不改 Session 历史。
- 文本上限与通知上限有界，避免无限增长。

### Agent Presets / Workspace / Schedule / Plugins / Settings

- 引入 agent-preset-registry，默认 ptc；复制并加载 standard / ptc / minimal / cordis 四个 preset patch。
- Base 的进程级 agent-plane 行被禁用，工具/提示词/技能改由 preset 按 Session 组合。
- /preset 列出当前 preset；首个 turn 前通过 Host `agentPresets.select(agent, id)` 切换当前 Session，已开始的 Session 由 Host 锁定，选择回退为下一次 /new；/status 展示 current preset。
- resume 使用最后一个 `agent-preset/selected` 事件恢复 preset，header 的旧值只作 fallback。
- /workspaces 列出 workspace；/workspaces new <path> 创建；/workspaces use <id|path> 在新 workspace 创建会话。
- /schedule 列出当前会话的提醒；支持 add <seconds> <title> 与 delete <id>。
- /plugins 列出 bundle 与插件项，/plugins market 浏览官方 on-demand catalog，支持 inspect、install、remove、enable/disable；写操作先确认，安装/移除走与 dsh plugin 相同的 pnpm 实现。
- /settings 支持字段选择器（/settings edit <ns>）、数组项编辑（/settings items <ns> <field>）与 JSON 合并写入（/settings set <ns> <json>），带 revision 冲突保护；对象字段可递归下钻，动态 record 仍以 JSON 编辑。
- /export html [path] 写出带内联深色样式的静态 HTML transcript，消息/工具卡片/交付文件均转义；不覆盖已有文件。
- /export zip [path] 使用 fflate 写出 session.jsonl、manifest.json、README.txt、attachments/ 与 deliverables/；附件读取走 Host readImage/readFileStream，交付文件复制受 16 MiB 上限。
- /tools 列出最近工具调用；/tool <index> 用可滚动 pager 查看完整参数/结果；/diff [index] 用同一 pager 查看 write/edit diff（↑/↓、PgUp/PgDn、Esc）。
- /attachments 打开暂存附件管理器：选择附件后可预览或移除；预览复用 /attach preview 的 Host readImage/readFileStream 路径。
- 已验证 /attach paste → /attachments → Preview → 2x2 image overlay → Esc 关闭。
- /deliverables panel 提供交付文件选择器与 Preview/Reveal/Back 动作；无交付时显示空缺提示。
- /deliverables reveal <index> 经确认后用平台命令（macOS open -R / Windows explorer /select / Linux xdg-open）在文件管理器中定位交付文件。
- /attach <path> 暂存文件/图片（8 MiB 上限）；/attach paste 通过 pi-tui getNativeClipboard().getImage() 读取 PNG/JPEG/GIF/WebP 剪贴板图片；/attach preview <i> 通过 Host readImage/readFileStream 内联预览；/attach list|clear 管理。
- 已验证 macOS RGB PNG 剪贴板 → /attach paste → clipboard.png，/attach preview 0 显示 2x2 图片 overlay，Enter/Esc 关闭。
- 文件附件走 readFileStream，文本预览上限 64 KiB；二进制只显示字节数。
- @@<query> 通过 sessionReferenceResolver.remoteExportCandidates 插入 canonical session mention；Host pre-step 自动准备引用快照。
- 已验证 @@ 在真实 profile 中列出 13 个其他 Session（label + cwd）；候选值由 remoteExportCandidates 生成 canonical mention。
- /preview <image> 使用 pi-tui Image 渲染 PNG/JPEG/GIF/WebP；不支持图形协议的终端显示文本占位；已验证 RGB PNG 2x2 的 overlay 标题、占位图与 Enter/Esc 关闭。
- fullscreen: true 使用 TuiAltScreen + VStack/ScrollView：固定两行 header、分隔线、status/editor，transcript 为 primary follow-end 滚动区，启用鼠标滚轮与选择复制。
- Transcript 层次：用户消息左侧 accent 色条；assistant 标签与 streaming 状态；reasoning 独立缩进；context 用 ◇ 标签；tool 用 ├ args/result 与 diff 分支；notice 用 i/!/✕ 图标；用户 turn 之间插入 dim Rule。长行使用 BarText 让每条 wrap 行保留左色条。
- 本地 notice 记录创建时的 afterSeq，渲染时按 durable event seq 插入；命令输出不再统一追加到 transcript 末尾。
- 运行中 Esc/Ctrl+C 取消当前 turn；Esc 在 overlay 打开时不抢占，交给 dialog。
- 已验证 fullscreen: true 启动、输入 /help 展示完整命令列表、Ctrl+D 正常退出；默认 fullscreen: false 仍走 TuiMainScreen。
- 图片读取上线 8 MiB，使用文件头嗅探，不依赖扩展名。
- 字段选择器解析 schemastery uid/refs，拒绝 secret 字段，输入值按 JSON 解析后写回。
- 已验证 /settings edit agent-loop 选择 maxParallelToolCalls，输入 9 后 profile patch 写入 9。
- 已验证 /settings items llm-deepseek models 列出 2 个模型项与 Append 动作；未执行写入。
- 已验证 /plugins disable include:llm-retry → applied，TUI 不中断；/plugins enable 恢复后 profile patch 回到 []。
- 已验证 /plugins market 列出官方 claude-code/codex 子智能体及 installTarget。
- 已验证 /plugins inspect + install /tmp/dsh-native-tui-probe-bundle → applied；profile 依赖和 bundles 列表写入，重启正常。
- 已验证 /plugins remove dsh-native-tui-probe-bundle → applied；profile 依赖和 bundles 列表清理，重启正常。
- 插件管理已覆盖官方市场、安装、移除与启停；官方目录之外的搜索仍走 Web。
- 已验证 /settings set agent-loop {maxParallelToolCalls:8} 写入 profile patch 并即时生效。
- 已验证 /preset → ptc/cordis/minimal 的创建与 /status 展示，四个 Web preset 全部可创建。
- 已验证 @src 触发 file-reference-local 补全，显示 src/、src/ui/、src/runtime/ 等候选；Tab 接受后输入变为 @src/。
- 已验证 /he 命令补全显示 /help，Tab+Enter 执行 /help。
- 已验证 standard、ptc、minimal、cordis preset 的 Agent 创建、事件订阅、失败 turn 展示和问题面板。

### 命令

- 本地命令：/help、/new、/sessions、/resume、/status、/clear、/cancel、/model、/reasoning、/provider、/permissions、/jobs、/agents、/exit、/quit；裸 `exit` / `quit` 也退出。slash 命令支持子命令补全：精确命令后显示其 subcommands，命令后参数位置按前缀过滤。
- 宿主命令：通过 ctx.commands.execute 执行；Base 实际注册了 /compact、/feedback、/goal、/permission、/plan。
- /model：列出 LLM catalog；目录为空时明确说明；支持直接输入 provider/model；通过 installModelSelection 接入下一 step 路由，并调用 agentDefaultModel.saveSelection 持久化默认选择。
- /provider add：引导配置 custom OpenAI/Responses/Anthropic gateway 或 built-in pi-ai catalog route；Credential source 支持 Store API key（写 DSH credential store，0600，不写 profile）或 UPPERCASE env 引用；env 未设置或形似 key 时拒绝保存。custom gateway 在保存前调用 Host `discoverModels` 读取 `/models`，**把发现列表中的其他模型也写入 route**，选择本次模型后为它写 Input modalities、Reasoning levels、`input` 与 `reasoningEfforts`；已有 route 重跑时默认 merge，保留其他模型；/provider list|remove 管理 route。
- /reasoning：读取 `resolveModelInfo().reasoning.efforts`，列出/切换当前模型的 reasoning effort；写入 `ModelSelectionRef.current.reasoningEffort`，下一 step 生效；`default` 清除显式 effort；变更同时通过 agentDefaultModel.saveSelection 持久化。
- 已验证 dummy `TEST_ROUTE_API_KEY` 下 `/provider add` → `/model` 选中 `test-route/test-model`；`/provider remove` 写回 `providers: {}`。
- 已验证本地 HTTP `/v1/models` 自动发现 → 选择 auto-model → 写入 64000/8192 容量并直接选中；已验证裸 `quit` 退出。
- 已验证 Store API key → credential store → stored-model 自动发现/选中，`/provider list` 显示 `(stored)`。
- mock SSE 端到端验证运行中 Esc：取消后状态 idle、显示 `! Turn cancelled`，HTTP 请求关闭。
- `/provider add` 自动发现后选择 Text + image，profile 写入 `input: [text, image]`；Reasoning levels=`low,medium,high` 写入 `reasoningEfforts`；auto-route 同时保存 auto-model + auto-small 两个模型。
- 已验证 `/reasoning high` 后状态栏显示 `effort high`，`/status` 显示 `Reasoning: high`。
- 已验证 `/provider` 补全显示 add/list/remove，`/provider re` 过滤为 remove。
- 已验证选择后 profile 写入 `agent-default-model: { provider, model, reasoningEffort }`；重启后 `/status` 恢复保存值。
- 已验证先执行本地命令再发 prompt 时，命令 notice 位于随后 User/context/AI 输出之前。
- 已验证把 `sk-proj-...` 填入 env 字段被拒绝，profile 未写入；`/provider list` 对非法 env 引用只显示脱敏提示。
- /permissions：列出权限预设并写回当前 Session；支持 /permissions <preset>。
- /jobs：列出当前 Session 的后台任务，支持 /jobs kill <id>。
- /agents：列出当前 Session 的直接子代理。

### 交互

- 在 agent.ctx 注册 user-questions/request 与 approval/request waterfall。
- 问题面板支持题干、header、detail、单选项、Other 自由文本；批次逐题作答。
- 审批面板支持 allow once / reject / cancel；请求 signal 与终端 dispose 都能取消。
- 已通过真实 Host 的 question probe 验证：探针发起 ask_user_question，TUI 选中 A，探针收到 {"answers":[{"id":"q1","selected":["A"]}]}。

### 终端与生命周期

- 仅接受 TTY 的 stdin/stdout；非 TTY 失败退出，不静默降级。
- TuiMainScreen 保留终端 scrollback。
- Ctrl+C、Ctrl+D、SIGTERM、SIGHUP 都走安全退出。
- 退出时停止 pi-tui、恢复 raw mode；不把未处理异常留给终端。
- 可选 DSH_NATIVE_TUI_DEBUG=1 输出启动与生命周期诊断。

## 3. 组成

profile 由 dsh-base + 本 bundle 组成。bundle patch 插入：

| 行 | 作用 |
|---|---|
| connection | Host carrier 与 Peer；file-upload 的前置 |
| workspace | Workspace registry；session-controller 前置 |
| file-upload | Host fileUploads；session-controller 前置 |
| subagent-model-selection-settings | tool-subagent 的 Host 设置命名空间 |
| file-reference-local | 主机端 @file 补全 provider |
| cordis-host-runner | cordis preset 的 Host runner |
| cordis-inspect-providers | tool-cordis/host inspect provider |
| session-controller | Session 生命周期、schedule 投递所需 Host 服务 |
| schedule | 定时任务 Host 服务 |
| tool-schedule | 模型可用的 schedule 工具 |
| tool-ask-user | 模型可用的 ask_user_question 工具 |
| agent-preset-registry | 预设注册表；默认 ptc |
| native-tui | 本 TUI 插件 |

Agent 的模型默认值来自 Host 的 ctx.agentDefaultModel；当前默认是 deepseek-official/deepseek-flash。没有配置凭据时，首个请求会以 MISSING_CREDENTIAL 失败，TUI 会显示 Turn failed，而不是假装成功。

## 4. 代码结构

~~~text
src/
  index.ts          Cordis entry, TTY check, exit handoff
  config.ts         schemastery config + defaults
  debug.ts          opt-in stderr tracing
  runtime/agent.ts  create/resume AgentHandle, default model
  ui/app.ts         terminal app, commands, event subscriptions
  ui/transcript.ts  host event/live-chunk reducer + pi-tui renderer
  ui/dialogs.ts     approval/question/model/permission selectors
  ui/theme.ts       ANSI palette, Markdown/Select/Editor themes
tests/
  config.spec.ts
  transcript.spec.ts
  agent.spec.ts
scripts/
  fake-tty-entry.mjs        Node wrapper for a non-PTY environment
  fake-tty-smoke.mjs        boot + Ctrl+D
  fake-tty-interaction.mjs  commands + failed model turn
  fake-tty-command-sweep.mjs model/permissions/jobs/agents
  fake-tty-question.mjs     real Host question probe
  pty-smoke.py              real PTY smoke (requires pty; sandbox may deny)
~~~

## 5. 验证证据

- pnpm check：typecheck + 8 个单元测试 + build 通过。
- 安装：在全新 DSH_HOME 执行 dsh plugin --profile tui add <repo> 成功，profile bundles = base + dsh-native-tui。
- 打包：pnpm pack 后以 tgz 安装到全新 DSH_HOME 成功，并成功启动。
- 启动：安装后的 profile 在 fake TTY 中启动、渲染 header/status/editor、Ctrl+D 退出码 0。
- 命令：/help、/status、/sessions、/permissions（真实预设表）、/jobs、/agents 均得到预期输出。
- 失败路径：无 DEEPSEEK_API_KEY 时提交 hello，TUI 正确显示 MISSING_CREDENTIAL，不崩溃。
- 问答：真实 Host 上 question probe 发起 ask，TUI 选择 A，Host 收到答案。
- 真实 PTY：当前沙箱拒绝 pty.openpty（Operation not permitted），因此 pty-smoke.py 未能在本机执行；需在普通终端环境复验。

## 6. 尚未完成的 Web parity

以下能力仍未实现，按优先级排列：

1. cordis preset 尚未纳入；当前加载 standard / ptc / minimal。
2. Settings 有顶层/嵌套对象字段选择器、数组项编辑与 JSON merge 写入；动态 record 仍是 JSON 文本，secret 字段建议用 Web。
3. Plugin Manager 已支持官方市场浏览、检查、安装、移除与启停；目录之外的市场搜索仍走 Web。
4. Workspace 尚无 pin/archive/排序 UI。
5. PDF/Office 富文档预览；基础文件树（/files）、@file 补全、@@session 引用、/open 文本与 Markdown 预览已实现。
6. 附件与图片已完成路径/剪贴板暂存、/preview 渲染、/attach preview 与 /attachments 管理器（staged 范围）。
7. feedback、open-in-app、官方目录之外的市场搜索、远端连接（TUI 已有 JSONL/ZIP/HTML /export、/changes 变更摘要、/deliverables panel/预览/定位、/tool 结果分页、/diff 查看器）。
8. 独立 Diff 查看器、结果分页、spill 引用、PTC 子调用树（行内 diff 已实现）。
9. Alt-screen 布局、鼠标、主题细化、输入历史持久化。
10. 远端交互（连接已有 dsh web Host）；当前只支持本地 owned Agent。

## 7. 下一步

- 纳入 ptc/cordis preset，并补齐其 Host 行（PTC runtime、tool-cordis 等）。
- 补 Settings 数组表单与官方目录之外的市场搜索。
- 补 Workspace pin/archive/排序与文件/@引用。
- 最后补附件管理器、交付卡片与远端连接。
- 在普通终端环境跑 pty-smoke.py，并把结果写入兼容性说明。

## 8. 已知限制

- 默认只拥有一个 root Agent；切换到另一个会话会 dispose 当前 Agent。运行中切换会取消当前 turn。
- 没有多 Agent 并发/后台会话视图；subagent 只读列出。
- 模型 catalog 在无凭据时为空；/model 列表会明确提示。`/provider add` 支持 stored credential 或 env 引用，并自动读取 endpoint 的 `/models` 列表；key 输入时在终端可见，发现失败时回退手输。输入能力写入模型 `input`；旧 profile 不会自动迁移。
- 问题面板的 multi-select 当前按单选项处理；自由文本可用，但多选组合尚未实现。
- preset 编辑器尚未实现；选择与创建已可用。
- /settings 支持顶层/嵌套对象/数组项编辑与 JSON merge，动态 record 仍是 JSON；/plugins 已可浏览官方市场、安装/移除/启停，目录之外的市场仍走 Web。
- @file 补全只插入路径文本，不读取文件；模型仍需调用 read。
- /schedule 只支持 after_seconds 一次性提醒，尚未暴露 every/daily/weekly/cron 表单。
- 终端没有 HTML/PDF/Office/浏览器渲染；这些属于明确的非目标。
- 发布名称、scope 与许可证尚未确定；当前 package 仍为 private。