# dsh-native-tui 实施进度

> 记录时间：2026-10-17 17:48 CST（2026-10-19 复核更新）
> 工作区：`/Users/wangzy/WorkSpace/WebStormProjects/dsh-native-tui`
> 状态：**Goal complete**（30/30 轮），插件可构建、可测试、可安装
> 包版本：`dsh-native-tui@0.2.1-rc.2`
> 关联文档：[README](../README.md)、[Host-native 方案](design-task-feature-dsh-native-tui-host-native.md)

## 1. 结论

已完成一个可在最新 DeepSeek Harness 上通过 `dsh --profile tui` 启动的 host-native TUI 插件。实现覆盖会话、流式对话、Markdown、工具卡片、审批/问答、模型/命令、Workspace、Schedule、Agent Presets、Settings、Plugin Manager，以及文件、附件、图片、跨 Session 引用、变更摘要、Deliverables、导出和全屏终端模式。

交付物是可安装的 tarball 与完整源码，不是一次性的演示脚本：

```sh
pnpm check
pnpm pack --pack-destination .tmp
dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
dsh --profile tui
```

## 2. 架构决策

原方案是 **Host + 进程内 Web Client + pi-tui**。Phase 0 验证发现已发布的 Web client 入口是浏览器 module-loader 包装（`window.__ModuleLoader__.load(...)`），在 Node 内无法加载；因此最终采用：

**Host services + pi-tui + Host-native TUI**

- 不引入浏览器数据层，不伪造 Web client。
- 直接使用 Host 的 `ctx.agents`、commands、approvals、questions、LLM、settings、plugins、workspaces、schedule、attachments、file references、session references、workspace changes 等服务。
- 通过 Cordis bundle patch 挂载 Host 行和四个 Agent Preset patch。
- 这是与原目标的**明确偏差**，已记录在 Host-native 方案中，建议 review。

## 3. 已交付能力

| 领域 | 已实现 |
| --- | --- |
| Session | 新建、恢复、列表、状态、清屏、导出、安全退出 |
| 对话 | 流式 assistant/reasoning、Markdown、steer、cancel、失败 turn 展示、等待 API 响应提示行（含自动重试状态） |
| 工具 | 工具卡片、write/edit diff 行、`/tools`、`/tool <index>` 分页、`/diff [index]` |
| 审批/问答 | approval waterfall、question 面板、单选/多选、Other 自由文本、单题跳过 |
| 模型/命令 | 模型选择、第三方 provider 引导、权限预设、Host commands、jobs、subagents（仅 `/agents` 只读列举直接子级） |
| Preset | 首个 turn 前切换当前 Session；开始后锁定，改用 /new |
| Presets | standard / ptc / minimal / cordis |
| Workspace | list/create/use/pin/unpin/archive/unarchive |
| Schedule | list/add/delete |
| Settings | 顶层字段、嵌套对象下钻、数组项编辑、JSON merge、secret 保护 |
| Plugins | list、官方 market、inspect、install、remove、enable/disable |
| 文件 | `/files` 浏览、`/open` 文本与 Markdown、`/preview` 图片 |
| 附件 | 路径/剪贴板图片、`/attach preview`、`/attachments` 管理器 |
| 引用 | `@file`、`@@session` canonical mention |
| Web 附加 | `/changes`、`/deliverables` panel/preview/reveal、JSONL/ZIP/HTML 导出 |
| 终端 | 可选 `fullscreen`（TuiAltScreen + ScrollView + mouse）、安全终端恢复 |

## 4. 验证证据

### 构建与测试

```text
pnpm check
  tsc -p tsconfig.json --noEmit
  vitest run
  tsc -p tsconfig.build.json

Test Files  32 passed (32)
Tests      237 passed (237)
```

> 2026-10-19 复核：测试规模从最初的 17/86 增长到 32/237，覆盖 transcript 渲染、session 事件接线、provider 默认值、CodeBuddy 流与重试策略。

### 安装与启动

最终验证使用全新 DSH_HOME：

```text
DSH_HOME=/tmp/dsh-native-tui-pack30-home
dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
node scripts/fake-tty-smoke.mjs
EXIT 0
```

### 已实际验证的路径

- 四个 Preset 列表与创建路径；`/preset` 展示 standard/ptc/minimal/cordis。
- `/help` 完整本地/宿主命令列表。
- `/changes` 无摘要路径；`/tools`、`/diff` 无调用路径。
- `/export zip` 生成 session.jsonl/manifest.json/README 与附件/交付目录结构。
- `/export html` 生成转义后的静态 HTML。
- `/settings edit` 写入 `agent-loop.maxParallelToolCalls`；`/settings items` 列出模型数组。
- Plugin market 列出官方 claude-code/codex；本地 probe bundle 的 inspect/install/remove 成功。
- 剪贴板 RGB PNG → `/attach paste` → `/attach preview` → `/attachments` → 图片 overlay。
- `@@` 在真实 profile 中列出其他 Session 候选；Tab 插入后的发送未完整验证。
- `fullscreen: true` 启动、`/help`、Ctrl+D 退出；桌面鼠标拖拽未验证。
- 等待提示行：mock SSE provider + 真实 Host + 真实 TUI 抓取渲染流，确认 `⟳ waiting for API response · Ns` 逐秒递增、首帧到达即消失；mock 首次返回 500 时显示 `retry 1/5 after SERVER (automatic)` 并在重放成功后清除。

### 未完成真实验证

- **没有模型凭据**，真实模型流式回合、真实工具调用、真实审批/问答 waterfall 仍未在真实凭据下跑通；只验证了事件管线、失败 turn、UI 路径和 Host 服务。2026-10-18 更新：审批与问答已分别用 mock 模型 + 真实 Host 的 E2E 覆盖（`scripts/fake-tty-approval.mjs`、`scripts/fake-tty-question.mjs`），真实凭据回合仍待验收。
- 沙箱无法创建真实 PTY，使用 fake-TTY 包装验证。
- 真实 `present` 工具事件未触发，deliverables panel/reveal 只有格式化和空缺路径验证。
- 真实终端鼠标拖拽/选择复制未验证。

## 5. 主要产物

```text
package.json                 dsh-native-tui@0.2.1-rc.2
cordis.patch.yml             Host 行、preset registry、native-tui 行
presets/standard|ptc|minimal|cordis.patch.yml
src/index.ts                 Cordis 入口、TTY 守卫
src/config.ts                schemastery 配置、fullscreen
src/runtime/                 agent/session、attachments、bundle、html、images、open、providers、settings、tool-log
src/ui/                      app、autocomplete、dialogs、transcript、diff、theme
tests/                       23 个测试文件，86 个测试
scripts/fake-tty-*.mjs       fake-TTY 验证脚本
README.md
docs/design-task-feature-dsh-native-tui-host-native.md
.tmp/dsh-native-tui-0.2.1-rc.2.tgz
```

依赖：`@earendil-works/pi-tui@1.3.0`、`@deepseek-ai/schemastery@3.18.5`、`fflate@^0.8.3`，以及官方 `computer-use`、`experimental-computer-use-cua-driver-native`、`mcp-client`、`mcp-resources`、`session-stats` 的 `0.2.1-rc.2`。

已初始化本地 git 仓库（main）；首次提交 `50ced8d`，第三方模型引导见后续提交。

## 6. 已知差距

- 官方目录之外的市场搜索未实现；官方 catalog 浏览和任意 spec 安装已实现。
- PDF/Office 富文档预览未实现；Markdown/文本/图片已支持。
- 远端连接未实现；当前是本地/SSH 终端使用。
- MCP 连接状态覆盖初始激活与运行中的工具注销（重连耗尽或禁用重连）；`dsh-mcp-client` 未暴露"重连进行中"的中间态，因此重连期间仍显示 connected。
- Computer-use 已经可用（用户实机验证）。
- 自动上下文压缩已接入 preset 并有事件渲染；真实长上下文自动触发仍缺 E2E 验收。
- 生产与开发依赖已统一为 `0.2.1-rc.2`。
- 会话级附件管理器未实现；当前 `/attachments` 管理 staged 附件。
- 真实凭据的模型流式回合仍未验收；审批 waterfall 已用 mock 模型 E2E 覆盖 allow/reject/cancel（`scripts/fake-tty-approval.mjs`）。
- Deliverables panel 的真实 present 事件路径未验收。
- `/provider add` 支持 DSH credential store（粘贴一次 key，写入 0600 credential 文件）或 UPPERCASE env 引用；API key 在输入时可见。自动发现依赖 endpoint 的 `/models` 列表，失败时回退手动输入；模型能力显式写入 `input`，已有旧 profile 需重配或手动补。
- 旧版本可能已把误填的 key 写入 `apiKeyEnv`：需 `/provider remove <route>` 并轮换 key。
- 第三方模型引导已用 dummy key 验证配置、写入和 `/model` 选择，未发起真实推理请求。
- 使用本地 HTTP `/v1/models` 验证自动发现：列出 auto-model/auto-small，选中后写入 64000/8192 容量并直接选中模型。
- 同一 discovery 的 auto-small 也会写入 route；`/provider list` 显示 2 model(s)，`/model` 可选择两者。
- 已验证 `/provider models fetch-route` 使用已存 baseURL/credential 获取 2 个模型，追加 auto-small 并保留 auto-model；输出 `1 added, 1 refreshed`。
- fake TTY 验证新 chrome：两行 Header、分隔线、`● idle  preset ptc` 状态条、`i Local commands` notice。
- 本地 mock SSE endpoint 验证 Esc：流式输出中按 Esc 后请求关闭、状态回 idle、显示 `! Turn cancelled`。
- 工具 call 的 `[tool-call]` 内容不再进入正文；参数 JSON 按字段展开 code/description/timeoutMs。
- `/provider add` 已验证 Input modalities=Text + image 会显式写入 `input: [text, image]`。
- `/provider add` 已验证 Reasoning levels=`low,medium,high` 会写入 `reasoningEfforts`。
- 已验证 `/model mock/mock-model` → `/reasoning high` → 状态栏 `effort high`，`/status` 显示 `Reasoning: high`。
- 已验证选择后 profile 写入 `agent-default-model` 的 provider/model/reasoningEffort；重启 TUI 后 `/status` 自动恢复 mock/mock-model + high。
- 已验证本地命令输出按事件顺序插入：`/provider list`、`/model`、`/reasoning`、`/status` 的 notice 位于随后 prompt 的 context/AI 输出之前。
- 已验证 Store API key 模式：粘贴 key → credential store（0600）→ 自动发现 stored-model → 保存并选中，`/provider list` 显示 `(stored)`。
- 已验证裸 `quit` 退出 TUI，退出码 0。
- 已验证输入 `/provider` 时补全列表显示 `/provider add/list/remove`；输入 `/provider re` 只显示 remove。
- 已验证 `/preset minimal` 写入 `agent-preset-registry.selectedDefault: minimal`；重启后状态栏和 `/status` 仍显示 minimal。
- 已验证默认 bundle 加载 computer-use、Cua Driver native、mcp-client、mcp-resources、mcp-manager、session-stats；profile 启动无激活错误。
- 状态栏常驻三行：`● idle  model <provider>/<model>` + preset/effort/快捷键 + `↳ turns/steps/tok/s/tokens/cache/ctx`；header 第二行只显示 cwd，避免长会话滚动后还需要 `/status` 确认模型。
- 参考 pi agent 增加用户消息、reasoning、tool 输出的全宽背景带；dark/light theme 使用不同底色，plain 保持无样式。
- Choice/TextInput/Approval、Markdown/Text Pager、Image 弹窗统一使用全宽 opaque dialogFrame；标题按行 wrap、长 reason 限制、每行补齐背景，避免底层 transcript 透出和串行。
- 已验证 `/mcp add` 写入 `mcp-manager.servers.demo`；mcp-manager 等待 mcp-client fiber 激活并通过 `mcpManagerStatus` 暴露状态。
- 已验证 `/mcp list` 对可用 fake MCP server 显示 `connected`，对失败 server 显示 `error: mcp-client(demo): initial connection or tool synchronization failed`。
- 已验证把 `sk-proj-...` 填入 env 字段会被拒绝且不写 profile；缺 env 时同样不保存。
- 默认 Agent Preset 已设为 ptc：全新 profile 启动后 `/status` 显示 `Preset: ptc`；既有 Session 仍按其记录恢复。
- 已验证空白 Session 的 `/preset minimal` 直接切换当前 Session，`/status` 显示 minimal。
- 已验证首个 turn 失败后 `/preset ptc` 返回 `This session has already started`，并提示 next /new 使用 ptc。
- 已验证 standard/ptc/minimal/cordis 四个 preset 都挂载 `compaction-basic` 与 `command-compact`；TUI `/help` 的 Host commands 包含 `/compact`。
- 已验证 `/compact` 在空历史下返回一次 `No compactable history yet.`（command/done 去重后不再双输出）。
- 新增 transcript compaction 单测：start/summary/end 渲染为 `Context compacted` 卡片，prune 渲染 tool-output 通知。
- 自动压缩的真实长上下文触发仍未做 E2E；当前验证覆盖 preset wiring、手动命令和事件渲染。
- 已验证退出后终端恢复并输出：`Session: <id>` 和 `Resume: dsh --profile tui --resume <id>`；用该命令重新启动可恢复同一 Session。
- 已验证 `--resume <id>` 与 profile 的 `sessionId` 配置共存时，CLI 参数优先。
- 已验证 `thinkingDisplay` / `runCodeDisplay` 的 hidden/compact/detailed 解析与渲染：compact 只保留首行/摘要，hidden 完全移除对应块。
- 已验证 `/settings` 独立 TUI settings 弹窗：显示当前 thinking/run_code 模式、transcript entries、theme、fullscreen；前两者通过 native-tui volatile settings 立即生效并持久化，theme/fullscreen 保存后重启生效；`/settings host` 保留高级 Host settings 入口。
- 已验证恢复 Session 后 `/status` 保留 mock/mock-model 与 preset minimal；新增 sessionModelSelection/sessionAgentPreset 单测覆盖 request/header 和 agent-preset/selected。
- 已为 `/model` 增加内联搜索弹窗：按 value/label/description 过滤，Enter 选择；单测覆盖过滤与选择。
- 修复 MCP fiber 激活失败后 Loader row 未清理的问题，并新增对应单测。
- compact run_code 现在同时显示 description/action 与 result 首行。
- 新增 approval 弹窗选择测试：Allow once / Reject / Esc cancel，并验证 reason 渲染。
- compaction 后 context 估算会减去 shadowedTokenCount；新的 compaction start / assistant / turn end 会把未结束的旧 compaction 标记为 error。

## 7. 建议验收步骤

1. 配置 `DEEPSEEK_API_KEY`，启动真实会话，验收流式文本、工具卡片、审批/问答。
2. 让模型执行 write/edit 与 present，验收 `/diff`、`/deliverables panel`、ZIP/HTML 导出。
3. 在真实 PTY 终端验证 `fullscreen: true` 的滚动、鼠标选择复制、Ctrl+D 恢复。
4. Review Host-native 架构偏差与已知差距，决定是否继续补 PDF/Office、远端连接。
5. 如需发布，补 git 初始化、commit、版本策略与 CI。

## 8. 轮次摘要

| 阶段 | 主要内容 |
| --- | --- |
| 1–4 | Host-native 架构、bundle patch、四个 Preset、Session、基础 TUI |
| 5–8 | 附件暂存、文件浏览、Settings 字段、Plugin 启停 |
| 9–13 | 工具 diff、workspace changes、deliverables、Settings 下钻、Plugin install |
| 14–20 | Plugin remove/market、剪贴板图片、图片预览、alt-screen、`@@session` |
| 21–25 | 附件预览、ZIP/HTML 导出、Deliverables reveal、工具结果 pager、Markdown |
| 26–30 | 独立 Diff、附件管理器、Settings 数组、Deliverables panel、收尾验证 |
| 后续 | 第三方模型 `/provider add|list|edit|models|remove` 引导与自动模型发现，23 个测试文件 / 86 个测试 |

## 9. 剩余事项（2026-10-17 审查记录）

当前代码与 237 个测试通过（32 个测试文件）；以下按优先级保留，不再混入已完成项。

### P1

- [ ] **自动压缩 E2E**：用低 context window 模型跑多轮长历史，断言 compaction start/summary/end/prune、下一轮请求 token 下降、context 百分比下降；当前只验证 preset wiring、手动 `/compact` 和事件渲染。
- [ ] **Settings 覆盖完整化**：当前 wizard 覆盖 thinking/run_code/transcript entries/theme/fullscreen；title、cwd、sessionId、showReasoning 仍需 profile YAML 或高级命令。`Host settings…` 仍只是 namespace 列表，不是完整内嵌编辑器。

### P2

- [ ] **Compaction 中断恢复**：已能在新 start/assistant/turn end 时把未结束 compaction 标 error；若 Session 恢复时最后一个事件就是未结束的 start，仍会显示 running。需要 resume 时处理 orphan start 或加 stale 标记。
- [ ] **Context 百分比精确性**：compaction 后只按 `shadowedTokenCount` 做近似扣减，未计 summary 本身 token；需要结合 token meter/下一次 usage 修正。
- [ ] **真实 PTY**：fullscreen 鼠标滚动、选择复制、Ctrl+D 恢复尚未在普通终端验收。
- [ ] **Settings wizard 自动化测试**：覆盖打开弹窗、修改 mode/entries、settings 持久化、theme/fullscreen restart 提示。

### P3

- [ ] 远端连接（连接已有 dsh web Host）。
- [ ] 官方目录之外的市场搜索。
- [ ] PDF/Office 富文档预览。
- [ ] **Subagent 查看/继续/进度（2026-10-18 复核）**：当前只有 `/agents` 只读列举直接子级（见「已完成」），以下均未实现。
  - 查看：`/sessions` 主动排除子会话，只能用 `/agents` 输出的 id 手工 `/resume <child-id>`；实测可打开子会话，但这是把 `delegationDepth >= 1` 的子会话当根会话恢复，属于未文档化的副作用，应做成受支持的入口。
  - 继续/中断：未接入 `subagents.prompt|interrupt|sendMessage`；在 resume 出来的子会话里直接发消息会绕过 subagent 服务的归属校验与 `maxActiveSubagents` 容量控制。
  - 进度：未订阅 `subagent/start` / `subagent/end`，委派执行期间父会话只有一张 pending 工具卡，看不到子代理状态。
  - 层级/状态：只用 `listChildren`，未用 `listDescendants`，不显示 depth、`hasChildren`、`activity`。
  - 测试：`/agents` 处理体无单测，`scripts/fake-tty-command-sweep.mjs` 只敲命令不断言输出；需补空列表/有行/服务缺失/抛错四个分支。
- [ ] 多 Agent 并发/后台会话视图（与上一条的查看/继续/进度合并评估）。
- [ ] 发布名称、scope、CI/publish 策略；当前 package 为 private。

### 已完成，不再作为剩余项

- [x] Session resume 恢复 model/reasoning effort/preset。
- [x] `/model` 内联搜索。
- [x] computer-use 用户侧实机可用。
- [x] approval dialog allow/reject 与显式 Cancel 行、reason 渲染测试（Esc 与 Cancel 行同样 settlement 为 cancelled）。
- [x] MCP fiber 激活失败 Loader row 清理。
- [x] MCP settings 实时 reconcile：`settings/document-updated` 驱动 manager 对新增/修改/删除 server 就地装载或卸载，不再需要重启 TUI；`tools/change` 加工具集合驱动 connect/disconnect 回推（mcp-manager 共 13 个单测）。
- [x] MCP 真实 tools/call E2E：`scripts/mcp-tools-call-e2e.mjs` 用真实 cordis 加官方 mcp-client 连接 `scripts/fake-mcp-stdio.mjs`，断言 `mcp__demo__echo` 的 stdio 往返结果。
- [x] MCP 真实 TUI 回归：`scripts/fake-tty-mcp.mjs` 以绝对路径 `node` 启动 `scripts/fake-mcp-stdio.mjs`，`/mcp add` 后**不重启**直接 `/mcp list` 显示 `connected`，证明 settings → reconcile 与状态回推在真实 Host 中生效。
- [x] 修复 MCP 状态探测导致的误判：mcp-manager 原先直接读 `ctx.tools`，但它未 inject `tools`，而 Cordis 代理对未注入服务读属性会抛 `cannot get property "tools" without inject`，使连接成功的 server 被判为 error 并卸载。改为 `ctx.get('tools')` 并对探测失败完全容错；单测补了对应回归防护（mock 复现该抛错行为）。
- [x] 修复 `/mcp add`（stdio）参数输入：arguments/environment 原先预填 `[]`/`{}`，用户输入会被插到前面并保存成 `path[]`，导致 `Cannot find module ...path[]`。改为不预填、由 placeholder 提示，并让 `showTextInput` 支持空提交（新增 `allowEmpty`），回车即表示无参数/无额外环境变量。
- [x] MCP 真实服务器实测：官方 mcp-client 直连 profile 中的 `idea`（streamable-http，`127.0.0.1:64342/stream`），注册 67 个工具，`get_all_open_file_paths`、`get_project_modules` 两次只读 `tools/call` 均返回真实数据。IDEA 侧要求显式 `projectPath`，未传时以业务错误返回当前打开项目列表。
- [x] 流式渲染组件复用：`TranscriptRenderer.rebuild` 原先每帧重建全部 block 组件，于是每个 Markdown 每帧重新解析。改为按 block 内容判定并复用未变化的组件（`sameTranscriptBlock`），流式时每帧只重建尾部一个 block，分隔用 Spacer/Rule 仍按帧新建（成本可忽略）。基准 `scripts/bench-transcript.ts`：600 轮会话每帧 76.5 ms → 2.4 ms；流式在途 100 chunks 每帧 24.4 ms → 0.4 ms，均降到 33 ms 节流窗口以下。
- [x] compaction 事件卡片、`/compact` 输出去重、context 近似扣减。
- [x] Subagent 只读列举：`inject: ['subagents']` + `/agents` 调 `SubagentRuntime.listChildren(active.id)` 输出 `id mode label createdAt`；`/sessions` 按 header `origin === 'subagent'` 排除子会话（`src/runtime/session-list.ts`，有单测）。实测（2026-10-18）：全新 DSH_HOME 装当前 tgz 后空路径输出 `No subagents for this session.`；拷入含真实 `subagent/catalog` 事件的父会话后输出 `dcb2ef18-… continuable "Smoke test subagent" 2026-10-17T10:46:46.600Z`，同期 `/sessions` 不含该子会话。查看/继续/进度见 P3。
- [x] ask_user_question 多选与跳过语义（2026-10-18）：新增多选 toggle 列表（Space 勾选、Enter 提交、Other 自由文本与已勾选标签一并返回）；每题统一提供 `Skip this question` 行（无选项文本题先给 `Answer… / Skip this question` 菜单，空提交返回菜单），跳过只返回 `{ id, selected: [] }` 并继续批次；Esc 或请求 signal 中止则以 `UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')` 取消整个批次，Host 的 `restoreUserQuestionError` 可还原为 `ASK_ABORTED`，不再以普通 `Error` 混淆用户取消与工具故障。
- [x] ask_user_question 单测覆盖（2026-10-18）：`tests/dialogs.spec.ts` 新增 13 个用例——无选项 Answer 行自由文本、无选项 Skip 行、空提交回到 Answer 菜单、Other 空提交回到选项列表、单选项选择、Other 自由文本、Skip 行跳过且保留批次、多选 toggle、多选 Other 补充、多选 Skip 行、空多选提交拦截、Esc 整批 `ASK_ABORTED`、signal 中止 `ASK_ABORTED`；总计 26 个测试文件 / 138 个测试。
- [x] 真实审批 waterfall E2E（2026-10-18）：新增 `scripts/approval-gate-probe`（把 `tools/pre-execute` 对 `bash` 的 `ask` 决策交给真实 ApprovalService）与 `scripts/fake-tty-approval.mjs`（mock OpenAI SSE 模型 + 真实 Host + TUI overlay，逐模式复跑）。四模式通过：`allow` → bash 执行并回传 `approval-probe-ok`；`reject` → `Error: the user rejected tool "bash"`；`cancel-row`（显式 Cancel 行）与 `cancel-esc`（Esc）→ `Error: approval for tool "bash" was cancelled`。覆盖真实审批服务、`approval/request` waterfall、审计配对和 TUI 决定链路；仍为 mock 模型而非真实凭据。
- [x] 内置 provider 目录对齐 Web 端（2026-10-18）：TUI 的 `LlmCatalog` 补 `listConfigurableProviders`；`/provider add` 的 catalog 路径改为 searchable 内置 provider 选择器（Host 目录，约 60 个 id），credential 默认值与「Use built-in environment auth」取自 provider 原生 env（如 `amazon-bedrock` → `AWS_BEARER_TOKEN_BEDROCK`），目录不可用时才回退手输；新增 `configurableProvidersIn / nativeAuthEnv / defaultApiKeyEnv` 与 `buildCatalogProvider()`（无 reference = 原生认证）及单测（`tests/providers.spec.ts`，139 tests）；真实 Host 冒烟 `scripts/fake-tty-provider-catalog.mjs` 连续两次通过（选择器、原生 env、保存后内置模型列表）。
- [x] 内置 CodeBuddy / WorkBuddy provider（2026-10-18）：把 `pi-codebuddy-provider`（Pi Extension）移植为 bundle 内置插件 `dsh-native-tui/codebuddy`，不依赖 dsh-router / 本地代理、不新增运行时依赖。新增 `src/codebuddy/`（profiles/auth/models/credits/errors/wire/sse/stream/adapter）与插件入口；`ctx.llm.registerAdapter` 注册 `codebuddy`(copilot.tencent.com) 与 `codebuddy-en`(workbuddy.ai) 两条路由，OAuth 走 `ctx.authorization` 流程、凭据存 `ctx.credentials`（scope `codebuddy`），续期在 `modifyRecord` 互斥写内、401/403 受控重放一次；目录来自 `/v3/config`（登录前用 seed 列表）；SSE 与 wire 序列化自实现（无 store/stream_options、`max_tokens`、`reasoning_effort`+`reasoning_summary`、EN 404/405 端点回退）。TUI 增 `/codebuddy status|login|logout|models refresh|quota|checkin|doctor`。`pnpm check` 通过（26 → 29 个测试文件 / 140 → 184 个测试）；真实 Host 冒烟 `scripts/fake-tty-codebuddy.mjs` 六项全通过（两条路由挂载、seed 模型、doctor 端点、`/model` 列出 `codebuddy/deepseek-v4-pro`）。真实账号路径未验收。
- [x] 失败/中断 attempt 不再丢失已流式输出（2026-10-19）：模型响应被截断时 Host 只写 `assistant/attempt`（带完整 compact stream），旧实现只清空 live 块、忽略事件负载，67955 字符的 reasoning 在转录里整体消失，只剩一条红色错误。改为用 `assembleAssistantStream(...).interruptedBlocks()` 重建 attempt 的可见内容（工具调用按设计剔除：中断发生在派发前，保留会显示一个从未执行的调用）；同时 `assistant/attempt` 不再写入 `finalizedSteps` 并重置该步 live 累加器，同一步重试可继续流式；`session-events` 同步清理该步 live entries。用真实失败载荷（`deepseek/deepseek-v4.1-flash`, `Response incomplete: length`）验证恢复出 67955 字符 reasoning。
- [x] 长会话流式渲染三项优化（2026-10-19）：① 组件复用从「下标对齐」改为按 block 身份（`seq`/`callId`/`compactionId`）缓存——`maxEntries` 截断会让整表左移，旧实现每次新增行都重排全部 Markdown；② `reduceTranscriptWindow` 返回 `retainedFrom`，调用方丢弃无引用前缀，并删掉 `/clear` 后每帧的 `entries.filter`；③ 帧间隔按帧成本自适应（33 ms 起，超预算最多退到 100 ms）。基准 `scripts/bench-transcript.ts`（新增饱和窗口用例）：cap 2000 饱和位移帧 64.9 ms → 2.0 ms；10 万事件窗口 19.1 ms → 3.9 ms。
- [x] provider 默认 `maxTokens` 对齐 Web（2026-10-19）：模型列表返回的 `maxTokens` 优先，列表未返回时不再写死 16k，改为 32k（与 pi-ai 的 `DEFAULT_MAX_TOKENS` / Web 端一致），并按 `contextWindow` 收窄，避免 `max_tokens` 超过模型窗口被接口拒绝。CodeBuddy 目录兜底值同步 32k。
- [x] CodeBuddy 流空闲看门狗与截断流重试（2026-10-19）：此前该路径没有 idle 守卫，连接被无声切断时 `reader.read()` 永远挂起；且「无 finish 帧即关流」抛出的 `INCOMPLETE_STREAM` 不在 Host 默认可重试码里，直接失败。现补 5 分钟可重臂空闲预算（每收到一帧重新计时，超时先抛 `TIMEOUT` 再 abort socket，保证结果不会被 abort 产生的 transport 错误顶掉），并由适配器 `providerRetryPolicy` 在 Host 默认码集合上追加 `INCOMPLETE_STREAM`（默认值 `resolveRetryPolicy(undefined, …)` 读取后追加，不复制列表）。至此两条 provider 路径对「休眠断网 / 流被截断」的处理一致。
- [x] 等待 API 响应提示（2026-10-19）：`agent/assistant-stream` 的 start 帧起、任意流式 chunk 或 `turn/end` 止，在转录末尾显示 `⟳ waiting for API response · Ns`，1 秒 ticker 仅在该行可见时运行；`llm/retry` 事件追加 `· retry 1/5 after SERVER (automatic)`，用来区分「系统正自动重试」与「需要手动重发」。为防止快模型下每步闪一下，行在等待超过 `WAIT_ROW_DELAY_MS`(1 s) 后才出现，但已排定的重试立即显示。mock SSE provider + 真实 Host + 真实 TUI 抓取验证（逐秒递增、首帧到达即消失、500 后显示 automatic 重试并在重放成功后清除）。
- [x] 手动调用技能对齐 Web 端（2026-10-18）：`/` 补全在命令后列出 Host `ctx.skills` 的用户可调用技能（过滤 `userInvocable`，仅用户可调用的标注 `user-only`），选中插入 `/skill-name`；`runCommand` 的未知命令分支先尝试 Host 命令，再匹配技能并以普通 prompt 发送（`dsh-tool-skill` 的 `SKILL_GESTURE` 在 pre-step 注入技能正文）；`/help` 增加 `Skills:` 行。`tests/autocomplete.spec.ts` 补技能补全/命令遮蔽用例（140 tests）；真实 Host 冒烟 `scripts/fake-tty-skill.mjs` 通过（菜单列出、非未知命令、正文注入）。
