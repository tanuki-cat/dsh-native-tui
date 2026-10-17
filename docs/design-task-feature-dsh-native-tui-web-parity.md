> **Superseded 2026-10-17**：Phase 0 发现发布的 Web Client 入口是浏览器模块加载器包装，进程内 Client 数据层不可直接用于 Node。当前实现见 [Host-native 重新实现](design-task-feature-dsh-native-tui-host-native.md)。以下保留原方案与决策记录。

# DSH Native TUI：完整 Web 能力实施方案

> 状态：待确认  
> 目标版本：DeepSeek Harness `0.2.1-rc.2`（本地源码）  
> UI：`@earendil-works/pi-tui@1.3.0`（按“pi-ui”指 DSH/Pi 生态的 pi-tui 理解）  
> 工作目录：`dsh-native-tui`

## 1. 结论

推荐做**第二代 TUI 架构**：

- Host 继续使用 DSH 的 `web` 宿主能力（Base + Web 宿主层 + Agent Presets）。
- TUI 不再逐项复制 Web 的业务逻辑，而是在同一进程内挂载**无头的 Web Client 数据层**，通过**进程内 Connection carrier** 连到 Host。
- 终端渲染使用 `pi-tui 1.3.0`，只替换“渲染层”和“输入层”。

这样，会话、工作区、Agent Preset、设置、后台任务、定时任务、子代理、审批、问答等状态都直接复用 Web 的 Client 模型与 Remote 契约，TUI 只负责终端呈现和按键交互。它比继续扩展现有 host-native 原型更接近“完整 Web 模式功能”，也避免每次 Web 增加能力时 TUI 再实现一遍。

**先决条件**：现有 `dsh-native-tui` 原型的源码目前不在工作区。需要先恢复源码，或确认按现有文档重建。原型的终端生命周期、PTY 测试、安全文本过滤、问答/审批桥、工具卡片等经验应复用；数据层建议重建。

## 2. 现状与依据

### 2.1 已有原型

本地 `~/.dsh/profiles/tui-dev` 已安装 `dsh-native-tui@0.0.0`，其 README 记录了 Phase 0–5 的成果：

- 已实现：owned 新会话、最小文本 transcript、流式输出、取消、退出恢复、本地命令、按 ID 恢复会话、本地 live 问答/审批、timed wait、continued 问题、原生/PTC 工具卡片、结果分页、Diff 快照、宿主命令执行、`/model`、`/theme`、`/details`、`/clear`、兼容性检查、PTY smoke、约 300 项测试。
- 明确未实现：完整会话管理、工作区、Agent Preset、权限预设、设置页、插件安装/启停、后台任务面板、定时任务、子代理导航、Deliverables、反馈、导出、附件/图片、文件树/文档预览、远端交互。
- 该原型是 **host-native**：直接依赖 `ctx.agents`、`ctx.sessions`、`ctx.commands`、`ctx.userQuestions`、`ctx.approval` 等 Host 服务，不挂载 Web Client。
- 目标版本为 `0.2.1-alpha.2`，pi-tui 为 `1.2.0`。

对已安装 bundle 的特性扫描显示，以下 Web 能力尚未接入：`agentPresets`、`permissionPresets`、`workspace`、`jobs`、`schedule`、`subagents`、`settings`、`pluginManager`、`deliverables`、`messageFeedback`、`session-log-export`、`fileReference`、`sessionReference`、图片/附件、subagent 等。

### 2.2 源码缺失

工作区 `/Users/wangzy/WorkSpace/WebStormProjects/dsh-native-tui` 目前为空。已安装包只包含 `dist/index.mjs`、类型声明、`cordis.patch.yml` 和 README，没有 `src/`、`tests/` 或 docs。原 tarball `dsh-native-tui-0.0.0.tgz` 也已不在。

因此 Phase 0 必须包含源码恢复：

1. WebStorm Local History / 备份 / 另一个 clone；
2. 上一轮会话记录中的文件写入；
3. 若都不可用，则以现有 README、`dist` 行为和旧 TUI 源码为参照重建。

### 2.3 最新 DSH 提供了什么

- Web 是 Host 服务 + 独立 Client 数据层 + React UI 的分层结构；业务事实在 Host，Client 模型是 React-free 的。
- `@deepseek-ai/dsh-client-connection/client` 同时提供 Node 入口，并支持 shell-owned carrier：
  - `transport.rpc`：已经解码的进程内 RPC；
  - `transport.fetch` / `transport.openStream`：自定义物理 carrier；
  - `connection.rpc.open`：进程内逻辑流。
- Host 侧提供 `ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })` 和共享 Fetch handler；Gateway 提供 `stream()`。
- `packages/test-support/client-runtime` 的 whole-client tier 已经证明：真实 Client 数据层可以在进程内测试运行时（jsdom）中用 mock RPC 启动。纯 Node、无 DOM、真实 Host carrier 仍需 Phase 0 spike 验证。
- `api/session-controller/client`、`api/workspace-controller/client`、`api/job-controller/client` 都是 React-free 的数据层，分别暴露 `ctx.sessions`、`ctx.workspaces`、`ctx.jobs`。
- Web bundle 已经包含完整的 Host 行和 Agent Presets（standard/ptc/minimal/cordis），可以复制为 TUI 的宿主层。

### 2.4 旧 TUI 的价值与限制

Git 历史中仍有已删除的 `packages/ui/tui`（删除前为 `10bb9cbf4a^`），包含完整的 pi-tui transcript、工具卡片、问答/审批、模型选择、resume、文件补全、主题和测试。但它是 2026-08 之前的实现，早于：

- `assistant/assistant-stream` 拆分；
- Agent Presets；
- approval / permissionPresets；
- `userQuestions` 重命名；
- pi-tui 1.x 的 `TuiMainScreen` / `TuiAltScreen` API。

因此适合作为**组件与交互参考**，不适合直接整体移植。

## 3. 目标与边界

### 3.1 功能矩阵

| 领域 | Web 能力 | TUI 实现 | 阶段 |
|---|---|---|---|
| 对话 | 流式文本/推理/Markdown/代码 | Client session 事件 + `assistant/live-chunk` + pi-tui Markdown | P1 |
| 工具 | bash/fs/search/web/subagent 卡片、Diff、结果分页 | 复用旧 TUI 卡片思路 + pi-tui 组件 | P1 |
| 交互 | 审批 allow/reject/cancel、问答单选/多选/自定义、plan review | Client `$on` waterfall + 终端 overlay，回 Remote answer | P1 |
| 模型 | 模型/推理强度选择 | Client `llm` Remote + 会话级选择 | P1 |
| 命令 | slash commands、动态发现 | Client `commands` + 本地动作 | P1 |
| 会话 | 列表/搜索/新建/恢复/fork/重命名/删除/导出 | `ctx.sessions` + `session.*` Remote | P2 |
| 工作区 | 创建/切换/archive/pin | `ctx.workspaces` | P2 |
| Agent Preset | standard/ptc/minimal/cordis、默认选择 | Client `agentPresets` Remote + preset 行 | P2 |
| 权限 | workspace-write / danger-full-access | `permissionPresets` Remote | P2 |
| 计划/目标/待办 | plan mode、goal、todo、compaction | 会话 projection 与命令 | P2 |
| 后台任务 | 列表、增量输出、终止 | `ctx.jobs` / job Remote + 面板 | P2 |
| 定时任务 | 列表、创建、取消 | schedule Remote + 面板 | P2 |
| 子代理 | 列表、查看、继续 | subagent Remote + 子会话视图 | P2/P3 |
| 设置 | general/models/plugins/shell/agent-loop/subagent/web-search | settings Remote + 终端表单 | P3 |
| 插件 | 安装/启停/市场 | pluginManager Remote + 面板 | P3 |
| 文件 | @file、文件树、文本预览 | fileReference/workspaceFiles Remote + 面板 | P3 |
| 附件 | 图片/文件 | 本地文件读取 + 终端图片协议/占位 | P3 |
| 交付/反馈/导出 | deliverables、feedback、export、open-in-app | 对应 Host/Remote + 命令 | P3 |
| 浏览器/文档/终端 | 浏览器、PDF/Office、内嵌终端 | 非目标或替代：系统浏览器、文本预览、外部终端 | 不做/替代 |
| 桌面集成 | 原生目录选择、主题 | 路径输入 + 终端主题 | 替代 |

### 3.2 明确非目标

- 不在终端内嵌浏览器。
- 不在终端内完整渲染 PDF/Office；提供文本预览或“用系统应用打开”。
- 不承诺内嵌 PTY 终端面板；可提供“挂起并进入 shell”或外部终端。
- 不复制 Web 的 React/Slot/主题体系；TUI 使用自己的终端主题。
- 不为第三方 Web UI 插件提供终端渲染；它们的能力通过 Host/Remote 暴露时才有 TUI 等价物。

“完整 Web 功能”定义为：**Web 中由 Host 服务承载、且能在终端语义下表达的能力与交互，均有 TUI 等价路径**；纯浏览器图形/原生 UI 不计入。

## 4. 架构

### 4.1 推荐方案：Host + 进程内 Web Client

```
dsh --profile tui
├─ Host Cordis tree
│  ├─ dsh-base
│  ├─ Web 宿主层（无 webserver / 无 React client）
│  │  ├─ agent-preset-registry + standard/ptc/minimal/cordis
│  │  ├─ workspace / session-controller / workspace-controller / job-controller
│  │  ├─ settings-controller / account-controller / schedule / message-feedback
│  │  ├─ session-reference / file-reference-local / session-stats / session-turn-outline
│  │  └─ 其他 Web Host 行
│  └─ dsh-native-tui（本插件）
│     ├─ Host 侧：owner Peer、共享 Fetch bridge、Gateway stream
│     ├─ Client Cordis 子树
│     │  ├─ connection（Node 入口，rpc + openStream）
│     │  ├─ typert / api-gateway/client / api-remotes
│     │  ├─ session-controller/client
│     │  ├─ workspace-controller/client
│     │  ├─ job-controller/client
│     │  └─ fileUpload（Node 文件实现或最小 stub）
│     └─ 终端 UI：pi-tui 1.3.0
```

不启动 HTTP server，不经过浏览器；Host 和 Client 在同一个 Node 进程内，通过 owner Peer 直接调用共享 Fetch handler 和 Gateway stream。

### 4.2 关键数据流

1. TUI 启动，创建 Host owner Peer（`interactions: 'answer'`）。
2. 在子 Cordis Context 中 `installConnection({ interactions: 'answer', transport: { rpc: { call, open } } })`。
3. 挂载 `typert`、`api-gateway/client`、`api-remotes` 和需要的 Controller Client。
4. `ctx.sessions` 打开列表/创建/恢复会话；`Session` 打开 `follow()`，接收 durable history 与 live chunk。
5. TUI 把 Client 事件投影为终端 view model，交给 pi-tui 渲染。
6. 用户输入 → `ctx.sessions`/Session 命令 → Remote → Host Controller → Agent。
7. 审批/问答通过 Client `$on('approval/request')` / `$on('user-questions/request')` 进入终端 overlay；回答经 Remote 返回 Host。
8. 退出时按顺序 dispose：overlay → Client 子树 → Peer → 终端恢复。

### 4.3 进程内 carrier

Host 侧：

- `const peer = hostCtx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })`
- unary：构造 `Request`，调用 `hostCtx.connection.createSharedFetchHandler('/api').fetch(request, peer)`（或等价的公开 Fetch 入口）。
- stream：调用 `hostCtx.typertGateway.stream({ endpoint, payload, peer, signal, uplink })`；`$events` 由 Gateway 的 forwarded-event 路径处理。

Client 侧：

- `transport.rpc.call(channel, endpoint, payload, signal)` → Host Fetch bridge。
- `transport.rpc.open(channel, endpoint, payload, signal, uplink)` → Host Gateway stream。
- 不创建 WebSocket；`interactions: 'answer'` 仍会启动 `$events`，用于 forwarded waterfall。

Phase 0 必须用真实 Host + 真实 Client Controller 验证这条链路；不能只用 mock。

### 4.4 会话生命周期

- 不再使用“启动时创建一个 owned agent、resume 时重启进程”的旧模型。
- TUI 通过 `ctx.sessions` 管理多个会话：列表、创建、follow、恢复、fork、关闭。
- 同一时刻只渲染一个活动会话；切换时关闭旧 Session 视图，不销毁 Host Agent（由 Session Controller 管理）。
- 运行中的会话切换：v1 允许切换但保留后台运行；若实现成本高，先限制为 idle 切换，并在 M2 解锁。
- 退出：取消当前 turn、等待稳定、关闭 overlay、dispose Client 子树、恢复终端。

### 4.5 UI 布局

- v1 使用 `TuiMainScreen` 单列布局：transcript + 状态行 + editor + 底部提示。保留终端 scrollback，符合 coding agent 习惯。
- 不默认使用 alt-screen；后续可提供 `--fullscreen` 使用 `TuiAltScreen` + 左侧会话/工作区栏 + 右侧详情栏。
- 所有 modal（审批、问答、模型、会话、设置）使用 pi-tui overlay；FIFO 队列，一次只允许一个 modal 抢焦点。
- 编辑器：`pi-tui 1.3.0` 的 `Editor` 仍没有旧补丁提供的 `frame` / `prompt` 选项。方案：
  - 子类化 `Editor`，覆盖 `renderTopBorder` / `renderBottomBorder`；
  - 用独立 prompt 行 + 编辑器内容，不依赖被打补丁的 pi-tui；
  - 不接受“为了旧代码而锁回 0.80.7 + 私有 patch”。

### 4.6 备选方案

**A. 继续 host-native 扩展**  
直接使用 `ctx.agents` / `ctx.sessions` / 各 Host 服务，不挂 Client 数据层。优点是已有原型可复用、生命周期简单；缺点是需要重新实现 Web 的会话/工作区/Preset/设置/插件语义，长期会持续落后 Web。仅在 Phase 0 的 Client carrier 验证失败时采用。

**C. TUI 作为远程 Client 连接 `dsh web`**  
使用官方 HTTP/WebSocket + 认证 Cookie，TUI 作为独立进程。优点是复用完整 Web Host 和已支持的 Node Client；缺点是需要额外 server 进程、认证和端口管理。可作为后续 `dsh tui --connect` 模式，不作为默认。

## 5. 仓库与打包

```text
dsh-native-tui/
├─ package.json            # dsh.bundle.patch + exports + peers
├─ cordis.patch.yml        # 插入 native-tui；引用 Web 宿主层与 presets
├─ presets/                # 从 dsh-web-app 复制/同步的 preset patch
├─ src/
│  ├─ index.ts             # Cordis entry, lifecycle
│  ├─ host/
│  │  ├─ peer.ts           # owner peer + in-process fetch/stream
│  │  └─ composition.ts    # host rows / capability checks
│  ├─ client/
│  │  ├─ tree.ts           # mount headless Client Cordis subtree
│  │  ├─ carrier.ts        # rpc call/open implementations
│  │  ├─ file-upload.ts    # Node file implementation / stub
│  │  └─ adapters.ts       # client snapshots -> view model
│  ├─ runtime/
│  │  ├─ terminal.ts       # TTY, raw mode, restore, exit
│  │  ├─ sessions.ts       # create/list/follow/switch
│  │  └─ interactions.ts   # approvals/questions overlays
│  ├─ ui/
│  │  ├─ app.ts            # TuiMainScreen root, layout, focus
│  │  ├─ transcript/       # user/assistant/context/tool cards
│  │  ├─ editor/           # prompt, history, autocomplete
│  │  ├─ dialogs/          # approval/question/model/session/settings
│  │  └─ theme.ts
│  ├─ commands/            # local + host commands
│  └─ config.ts
├─ tests/
│  ├─ unit/
│  ├─ integration/         # real host + headless client + mock LLM
│  ├─ terminal/            # PTY e2e
│  ├─ snapshots/           # pi-tui headless snapshots
│  └─ fixtures/
├─ scripts/                # check-compat, smoke-pty, carrier spike
└─ docs/
```

打包要点：

- `package.json` 声明 `dsh.bundle.patch`，安装后自动成为 profile bundle。
- `dsh-native-tui` 作为插件入口；Host 依赖使用 peerDependencies，pi-tui 使用精确 dependency。
- `dsh plugin --profile tui add <path-or-package>` 初始化 profile 并启用 bundle；`dsh --profile tui` 启动。
- 开发期可用 `link:` 安装；发布前构建 `dist`。
- Web 宿主行与 presets 先复制到本仓库，并加一个 `check:host-parity` 脚本与上游 web bundle 做差异检查；后续可推动上游拆出可复用的 `dsh-web-host` bundle，消除复制。

## 6. 里程碑

### Phase 0：源码恢复与架构验证（3–5 天）

- 恢复现有原型源码；若不可用，明确改为重建并重估。
- 建立对最新 `0.2.1-rc.2` 的兼容矩阵：`check:compat`。
- 写最小 spike：
  - Host: base + web host rows + mock/real LLM。
  - Client: in-process carrier + `session-controller/client`。
  - 创建会话、发送 prompt、follow 事件、审批/问答 waterfall、退出。
- 用 pi-tui 1.3.0 渲染一屏文本，验证 TTY / raw mode / restore。
- **决策门**：carrier 与 Client 数据层可用 → 进入 B；否则转 A 或 C。

### Phase 1：核心 TUI MVP（约 2 周）

- 完整 transcript：durable history + live chunk + tool cards + Diff + 结果分页。
- editor：多行、历史、@file、slash autocomplete。
- 本地命令 + Host 命令执行。
- 模型选择、会话创建/恢复、取消、退出恢复。
- 审批/问答 overlay；plan review。
- 状态行：模型、context、token、运行状态。
- 交付：`dsh --profile tui` 可完成一次真实 coding 会话。

### Phase 2：Web 会话/编排能力（约 2–3 周）

- 会话列表/搜索/新建/恢复/fork/重命名/删除/导出。
- 工作区创建/切换/archive/pin。
- Agent Preset 选择与切换；权限预设。
- plan/goal/todo/compaction 的视图与命令。
- jobs 面板（增量输出/终止）。
- schedule 面板（列表/创建/取消）。
- subagent 列表/子会话查看/继续。

### Phase 3：设置与运维能力（约 2–3 周）

- 设置表单：general/models/plugins/shell/agent-loop/subagent/web-search/session-log。
- 插件管理：列表/安装/启停/市场；与 `dsh plugin` 对齐。
- 文件树、文本预览、@file/@session 引用。
- 附件/图片（终端协议支持时显示，否则占位/系统打开）。
- deliverables/feedback/export/open-in-app。
- 主题、鼠标、可选 alt-screen 布局。

### Phase 4：稳定化（约 1 周）

- 跨平台：macOS/Linux/Windows Terminal。
- 长会话性能、内存预算、渲染节流。
- 文档、安装说明、兼容性矩阵、CI。
- 发布包与示例 profile。

> 总工期取决于源码是否恢复与 parity 深度：  
> - 可演示 MVP（Phase 1）：约 3–4 周。  
> - 完整 P1–P4（源码可恢复）：约 10–14 周（1 名熟悉 DSH 的工程师）。  
> - 完全重建：约 14–18 周，且需要重做现有 PTY/兼容性测试。

## 7. 验证

- **单元**：config、carrier、transcript projector、tool card、dialog state、command parser。
- **集成**：真实 Host + 真实 Client 数据层 + 无网络 mock LLM；验证 create/follow/prompt/cancel/approval/question/preset/workspace/job/schedule。
- **PTY e2e**：在临时 `DSH_HOME` 安装 tgz，启动 `dsh --profile tui`，发送按键，断言屏幕、退出码、raw mode 恢复、日志。
- **快照**：pi-tui headless terminal（xterm-headless）覆盖 transcript、审批、问答、模型/会话/设置面板。
- **兼容性**：CI 对最新 DSH checkout 跑 typecheck/build/smoke；失败时给出明确的上游 API 变更。
- **验收清单**：按第 3.1 节逐项勾选；非目标单独标注。

## 8. 风险

1. **in-process carrier 未验证**：Client 数据层可能依赖浏览器全局或 React renderer。Phase 0 spike 是硬门槛；失败则转 C（本地 web server）或 A（host-native）。
2. **Client 数据层依赖**：`session-controller/client` 注入 `fileUpload`、`remote.commands`、`remote.subagents`；`remote-access/client` 依赖 `ui-renderer`。需要 Node 实现或最小 stub，不能挂 React UI 包。
3. **Web 宿主行复制漂移**：需要 `check:host-parity` 与上游 diff；长期推动共享 bundle。
4. **DSH 预发布 API 变动**：精确 peer 范围 + 兼容检查 + CI 对最新源码。
5. **pi-tui 1.3 Editor 缺 prompt/frame**：自定义 editor chrome，不锁旧 patch。
6. **完整 parity 范围蔓延**：以第 3.1 节矩阵和 3.2 非目标为准；P1 先交付可用的 coding TUI。
7. **源码缺失**：Phase 0 必须先解决；否则所有工期与复用结论失效。
8. **并发/远端**：默认只运行一个 TUI 实例；与 `dsh web` 同时写同一会话需要 Session 锁/所有权策略。远端 attach 作为后续独立模式。

## 9. 待确认

1. 现有原型源码在哪里？能否从 WebStorm Local History、备份或上一轮会话恢复？
2. 是否接受从 host-native 原型转向“进程内 Web Client + pi-tui”架构？
3. “完整 Web 功能”的优先级：P2/P3 中哪些必须首期交付？浏览器/文档/内嵌终端是否确认作为非目标？
4. 目标平台：先 macOS，还是 macOS/Linux/Windows 同时？
5. 包名/发布方式：继续 `dsh-native-tui` 私有包，还是发布到 npm/插件市场？是否考虑向上游贡献 `tui` profile/bundle？
6. 是否需要“TUI 连接已运行的 `dsh web`”作为独立模式？