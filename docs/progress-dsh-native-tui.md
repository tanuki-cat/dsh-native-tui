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
| 工具 | 工具卡片、write/edit diff 行（PTC `run_code` 内嵌与 native 顶层调用）、`/tools`、`/tool <index>` 分页、`/diff [index]` |
| 审批/问答 | approval waterfall、question 面板、单选/多选、Other 自由文本、单题跳过 |
| 模型/命令 | 模型选择、第三方 provider 引导、模型输入类型编辑（`/provider input`）、权限预设、Host commands、jobs、subagents（仅 `/agents` 只读列举直接子级） |
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

Test Files  33 passed (33)
Tests      278 passed (278)
```

> 2026-10-19 复核：测试规模从最初的 17/86 增长到 33/278，覆盖 transcript 渲染、session 事件接线、provider 默认值、CodeBuddy 流与重试策略；本轮新增 context meter 投影用例与 `tests/router.spec.ts`。

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
- 等待提示行：mock SSE provider + 真实 Host + 真实 TUI 抓取渲染流，确认 `⟳ waiting for API response · Ns` 逐秒递增、首个可渲染输出到达时消失（裸 block-start 不提前清除）；mock 首次返回 500 时显示 `retry 1/5 after SERVER (automatic)` 并在重放成功后清除。

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
src/ui/                      app（wiring）、commands/（每命令族一模块 + router.ts 分发器）、autocomplete、dialogs、transcript、diff、theme
tests/                       33 个测试文件，278 个测试
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
- `/provider add` 支持 DSH credential store（粘贴一次 key，写入 0600 credential 文件）或 UPPERCASE env 引用；API key 在输入时可见。自动发现依赖 endpoint 的 `/models` 列表，失败时回退手动输入；模型能力显式写入 `input`，已有旧 profile 需重配或手动补；也可用 `/provider input` 编辑单个模型的输入类型。
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
- 已验证输入 `/provider` 时补全列表显示 `/provider add/list/edit/models/input/remove`；输入 `/provider re` 只显示 remove。
- 已验证 `/preset minimal` 写入 `agent-preset-registry.selectedDefault: minimal`；重启后状态栏和 `/status` 仍显示 minimal。
- 已验证默认 bundle 加载 computer-use、Cua Driver native、mcp-client、mcp-resources、mcp-manager、session-stats；profile 启动无激活错误。
- 状态栏常驻三行：`● idle  model <provider>/<model>` + preset/effort/快捷键 + `↳ turns/steps/tok/s/tokens/cache/ctx`；header 第二行只显示 cwd，避免长会话滚动后还需要 `/status` 确认模型。ctx 段与 Web 端同口径（token meter `contextPressure` 的 projected 值），渲染为 `ctx 42%  (~420K / 1M · compact at 80%)`。
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
- 未挂载 token meter 的组合里，日志回退估算会在 compaction 后减去 shadowedTokenCount；装 meter 时以 `contextPressure` 投影为准（compaction 引起的缩减通过 surface 变化自然反映）。新的 compaction start / assistant / turn end 会把未结束的旧 compaction 标记为 error。

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
| 后续 | 第三方模型 `/provider add|list|edit|models|input|remove` 引导与自动模型发现，23 个测试文件 / 86 个测试 |

## 9. 剩余事项（2026-10-17 审查记录）

当前代码与 401 个测试通过（37 个测试文件）；以下按优先级保留，不再混入已完成项。

### P1

- [ ] **Settings 覆盖完整化**：当前 wizard 覆盖 thinking/run_code/transcript entries/theme/fullscreen；title、cwd、sessionId、showReasoning 仍需 profile YAML 或高级命令。`Host settings…` 仍只是 namespace 列表，不是完整内嵌编辑器。

### P2

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
- [ ] 发布名称、scope、CI/publish 策略；当前 package 为 private（GitHub 仓库已设为 public，npm 发布暂缓）。

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
- [x] 状态栏 token / tok-s / 缓存口径对齐 Web（2026-10-19）：① 用量折叠补齐 `assistant/attempt` 流里的 usage（与宿主 token meter 的 `usageOf` 同源），并按 token meter 的槽位语义处理替换——同一步的后续结算替换前一笔，`llm/retry-started` 关闭槽位让重试重新累加；未结算的中断 attempt 现在计入总量与缓存命中（218 个新鲜投影会话中此前有 2 个漏计，共 174,193 tokens）。② 缓存命中率改用 Web 的 `formatCacheHitPercent`：整命中才显示 100%，部分命中不再四舍五入到 100（此前 12/237 个会话显示 100%，Web 显示 99.5–99.8%）。③ 总量改为四桶求和（不再优先 provider 的 `totalTokens`），`formatTokenCount` 对齐 Web `formatTokens`（≥100 单位取整、<100 一位小数、不设 B 单位；此前 36/237 个会话显示不同，如 177.2M vs 177M）。验证：`pnpm check` 33 files / 275 tests；对 218 个新鲜投影缓存会话逐一比对宿主 `tokenUsage` 投影与 Web 的格式化函数，总量 / 缓存 / 格式三项差异均为 0（修复前 2 / 12 / 36）；真实会话恢复渲染 `56 turns · 1059 steps · 263 tok/s · 515M tok · cache 99% · ctx 69% (~725K / 1M · compact at 69%)`。

- [x] 等待 API 响应提示（2026-10-19）：`agent/assistant-stream` 的 start 帧起、首个可渲染 text/reasoning chunk、durable assistant/message/tool/call 事件或 `turn/end` 止，在转录末尾显示 `⟳ waiting for API response · Ns`，1 秒 ticker 仅在该行可见时运行；`llm/retry` 事件追加 `· retry 1/5 after SERVER (automatic)`，用来区分「系统正自动重试」与「需要手动重发」。为防止快模型下每步闪一下，行在等待超过 `WAIT_ROW_DELAY_MS`(1 s) 后才出现，但已排定的重试立即显示。mock SSE provider + 真实 Host + 真实 TUI 抓取验证（逐秒递增、首个可渲染输出到达即消失、500 后显示 automatic 重试并在重放成功后清除）。
- [x] 手动调用技能对齐 Web 端（2026-10-18）：`/` 补全在命令后列出 Host `ctx.skills` 的用户可调用技能（过滤 `userInvocable`，仅用户可调用的标注 `user-only`），选中插入 `/skill-name`；`runCommand` 的未知命令分支先尝试 Host 命令，再匹配技能并以普通 prompt 发送（`dsh-tool-skill` 的 `SKILL_GESTURE` 在 pre-step 注入技能正文）；`/help` 增加 `Skills:` 行。`tests/autocomplete.spec.ts` 补技能补全/命令遮蔽用例（140 tests）；真实 Host 冒烟 `scripts/fake-tty-skill.mjs` 通过（菜单列出、非未知命令、正文注入）。
- [x] context 占用对齐 Web 端（2026-10-19，关闭 P2「Context 百分比精确性」）：状态栏 `ctx` 改为读 Host `contextPressure` 投影——`projectedTokens`（最近一次 provider 采样 + 此后 surface 增减，compaction 的影子通过 surface 自然反映）除以投影记录的路由容量（无则回退模型 catalog），百分比与 Web ContextMeter 同式 `min(100, round(used/window*100))`；并按 `dsh-compaction-basic` 的 `thresholdRatio`(0.8)、`headroomTokens`(65536) 与预留输出复算自动压缩触发点；预留输出与会话最新 `request/header` 的 `config.maxTokens` 同源，没有才回退模型 catalog 的 `defaultMaxTokens`（与压缩器的 `reservedCompletionTokens` 一致；2026-10-19 修正，此前只读 catalog 值），渲染为 `ctx 42%  (~420K / 1M · compact at 80%)`。meter 已挂载、尚无 provider 采样时显示 `ctx —`（与 Web 一致，不再用日志里的 0 冒充占用）；只有未挂载 meter 的组合才回退到日志最后一次 prompt（compaction 后减 `shadowedTokenCount`，该扣减已补回单测）。`tests/metrics.spec.ts` 覆盖投影公式、headroom 收窄、meter 优先、无采样静默与回退扣减；真实 Host 冒烟 `scripts/fake-tty-smoke.mjs` 空会话输出 `ctx —`。
- [x] `app.ts` 按职责拆分（2026-10-19）：`runCommand` 的 34 分支分发移到 `src/ui/commands/router.ts` → `runCommandLine(line, deps)`，只注入七名协作者（context/switchTo/sendPrompt/clearTranscript/exit/preset/skills），`ctx()` 惰性构建，分支集合与顺序和拆分前逐一对齐；app.ts 里 21 个 Host service 接口中 17 个已无引用（删除）、其余 4 个改从 `commands/services.ts` 导入，本地 `errorMessage` 复用 `commands/shared.ts`，`listSessions` 包装与死常量 `MAX_LISTED_SESSIONS`/`NL` 删除。`app.ts` 990 → 610 行；新增 `tests/router.spec.ts` 7 个用例（exit/clear/init/new/未知命令/host 命令吞掉/技能回落）；`pnpm check` 33 files / 260 tests 通过，真实 Host 冒烟 `scripts/fake-tty-command-sweep.mjs` 中 `/jobs`、`/agents` 输出正常。
- [x] `/reasoning map` 引导编辑当前模型思考强度映射（2026-10-19）：新增 `src/ui/commands/reasoning-map.ts` 与 `src/runtime/reasoning-map.ts`。向导按当前 `provider/model` 定位 `llm-pi-ai` 映射，提供 Add/update level（7 档 level + 任意非空 wire spelling，off 可留空为 null）、Remove level（至少保留一个非 off 档）、Use same-name defaults、Save and apply / Cancel；所有修改先暂存，Esc 不落盘。写入优先使用 `providers.<route>.models.<index>.reasoningEfforts` 叶子路径（profile patch 自己拥有 models 数组时），否则回退到重述合并后的 models 数组；catalog route 无显式 models 时写 `providers.<route>.modelOverrides.<model>.reasoningEfforts`，不复制整个模型目录。无存储映射的 catalog 模型会从 Host `resolveModelInfo` 报告的 level 生成同名暂存映射并提示核对 wire spelling；保存后若当前显式 effort 已不存在，自动清回 provider default。`/reasoning` 无参菜单增加 **Edit reasoning map…** 入口，`/help` 与 README 同步。测试：`tests/reasoning-map.spec.ts` 11 例（定位、disabled、catalog override、非法映射、暂存、写入路径）、`tests/reasoning-map-command.spec.ts` 7 例（服务缺失、namespace/route 拒绝、add custom wire、remove+清 effort、catalog override、catalog seed、cancel）；另修预填文本输入的光标位置（原在开头，现移到尾端，编辑 wire 值时不会前插），并在 `tests/dialogs.spec.ts` 补 1 例；`pnpm check` 35 files / 297 tests 通过。真实 Host 冒烟 `scripts/fake-tty-reasoning-map.mjs`（mock model + 真实 TUI）通过：把 `high` 改为 `xhigh` 后提示 `Saved reasoning map…`，`cordis.patch.yml` 仅该叶子变为 `high: xhigh`，没有重述 `models` 数组。
- [x] reasoning 完成块流式呈现与 tok/s 口径复核（2026-10-19）：定位到 command-code 的 Responses 路径在该会话中只下发 reasoning 的 block-start + 完整 block-end（compact stream 无 reasoning-chunks），而 TUI 的 live reducer 只处理 delta、忽略 block-end，因此 thinking 一直等到 durable assistant/message 才整块出现。修复：live reducer 采纳 reasoning/text 的 block-end；reasoning 无 delta 时按 4 chars/ms 在本地逐帧展开，并让 TranscriptRenderer.liveRevealPending 驱动 app 以 33ms 下限持续重绘到展开完成；有 delta 的 provider 行为不变。tok/s 复核：公式与 Host sessionStats 和 Web 统计 pill 同为 decodeTokens / (decodeMs/1000)，是整段 Session 的累计 decode 速率（不含 tool 时间，包含 reasoning output），当前会话 107686 / 94.931s ≈ 1134 tok/s；截图 1104 与同一累计口径相符（当时步骤更少），不是计算错误；补上 Web 的低于 10 保留一位小数格式。测试：tests/transcript.spec.ts 38→42 例（block-end 展开、delta 优先、text block-end 补齐、settlement 清除 pending）、tests/metrics.spec.ts 29→30 例（tok/s 格式）；pnpm check 35 files / 302 tests 通过。真实 Host 冒烟 scripts/fake-tty-reasoning-stream.mjs（Responses SSE 只回传完成 reasoning 块）通过：reasoning 首尾标记出现间隔 263ms（3085→3348ms），最终回答 4273ms 到达。
- [x] 审查修复（2026-10-19）：① `/reasoning map` 播种扩展到显式 `models` 条目（省略 `reasoningEfforts` 时也按 catalog levels 生成同名暂存映射），播种状态标记为 staged、区分 edited；继承层 `models` 数组写入前增加确认，避免静默重述/遮蔽 base 层；补充显式 models 播种、继承数组确认、最后一个非 off 档保护、settings 冲突重试测试，命令测试 7→10；补全提示新增 `/reasoning map`，并用 `keepExactSubmit` 保留裸 `/reasoning` 回车打开 effort 选择器的行为，autocomplete 测试 8→9；真实 Host 冒烟 `scripts/fake-tty-reasoning-autocomplete.mjs` PASS（提示出现 `/reasoning map`、选择后打开 map 编辑器、裸 `/reasoning` 回车仍打开 effort 选择器）。② reasoning 完成块在 durable `assistant/message` 到达后按 stream 的 block-end 时间继续展开，不再被完整块覆盖（transcript 测试 42→44）；`scripts/fake-tty-reasoning-stream.mjs` 的 1200ms 与 100ms settle 两模式均 PASS，短 settle 下 answer 延迟到 thinking 完成后出现（answerOrdered=true）。③ `sessionStats` 缺失时从 `assistant/message` stream 回退计算 tok/s；metrics 测试 30→31。最终 `pnpm check` 35 files / 309 tests 通过，README 同步。
- [x] 等待行与首帧渲染衔接（2026-10-19）：根因是 `appendEntry` 对任何 live chunk 都 `clearWait`，包括没有可见内容的 `block-start`；Responses reasoning 先到 `block-start`、后到完整 `block-end`，于是等待行先消失、thinking 尚未出现。修复：新增 `liveChunkHasOutput`，只在可见 text/reasoning 或 durable `assistant/message` / `tool/call` 到达时清除等待行；裸 `block-start`、usage/finish 不再提前清除。测试：`tests/transcript.spec.ts` 44→46；`scripts/fake-tty-reasoning-stream.mjs` 新增 `PROBE_REASONING_DELAY_MS=1500` 模式验证 `waitingSeen=true`，默认/短 settle 仍 PASS。`pnpm check` 35 files / 311 tests 通过，README 同步。
- [x] thinking 展开与下一步串行（2026-10-19）：等待行修复本身不阻止后续 block 提前显示，durable `tool/call` 仍可能在本地 reasoning 展开中追加，出现 thinking 未完成而 run_code 卡片已出现。修复：assistant block 增加 `revealing` 标记，visible 归约在 revealing block 后暂缓所有后续块，直到展开完成；同时给单块展开加 600ms 上限，避免长 reasoning 长时间阻塞后续卡片。transcript 测试 46→47；`pnpm check` 35 files / 312 tests 通过。注意这是串行化本地展示，run_code 仍会实际执行，只延迟其卡片出现。
- [x] 审查建议修复（2026-10-19）：① 完整子命令不再返回补全 suggestion，`/reasoning map`、`/provider add` 等一次 Enter 直接提交；autocomplete 测试补断言，`scripts/fake-tty-reasoning-autocomplete.mjs` 新增 `typedMapOpened` 并 PASS。② 串行化遇到 user/notice 边界时不再 hold，优先显示新输入或通知；transcript 测试 47→48。③ 等待行只在可见 text/reasoning 或 durable assistant/message/tool/call 清除，live tool-call/image/file 不再提前清除；session-events 测试 6→7。`pnpm check` 35 files / 314 tests 通过，README 同步。
- [x] 补全与显示细节收尾（2026-10-19）：① 空格路径的 leaf 子命令补全返回完整命令行 + slash prefix，从 `/reasoning ` 选择 `map` 一次 Enter 即提交（带 hint 的子命令仍为插入）；autocomplete 测试 9→10。② `liveChunkHasOutput` 接收 thinking display 模式，`hidden` 时 reasoning 不再清除等待行；app 的 `setDisplayModes` 同步本地模式；transcript 测试 48→49。③ 新增 `scripts/fake-tty-reasoning-tool-order.mjs`，真实 run_code 串行化 PASS（reasoning 2990→3291ms，tool 3291ms，final 3291ms）。`pnpm check` 35 files / 316 tests 通过，README 同步。
- [x] UI 渲染审查修复（2026-10-19）：① revealing 期间同一 assistant block 的 answer 文本暂不渲染，thinking 完成后再显示；② reveal 与 reasoning clip 改用 grapheme 边界（Intl.Segmenter），emoji/ZWJ 不再被切断；长 reasoning 以 3000 字素预览作为 reveal 预算；③ info notice 不再绕过 hold，只有 user 和 warning/error notice 优先；④ 只有 leaf 子命令选中后自动提交，带 hint 子命令保持插入；⑤ reveal 首帧重排 transcript timer；⑥ README 明确串行平滑是 TUI 本地行为，不对齐 Web。transcript 测试 49→53、autocomplete 10→11；`pnpm check` 35 files / 321 tests 通过，stream/tool-order/autocomplete probes PASS。
- [x] 上下文 fallback 修复（2026-10-19）：`collectSessionMetrics` 在 token meter 缺失时，除 `compaction/summary` 外也扣减 `compaction/prune` 的 `shadowedTokenCount`，避免恢复会话后日志回退把已裁剪工具输出重新计入；新增 metrics 用例覆盖多次 prune。metrics 测试 31→32；`pnpm check` 35 files / 322 tests 通过，README 同步。
- [x] 流式渲染平滑优化（2026-10-19）：① `reasoning block-start` 显示 `thinking …` 占位，避免长等待后空白直接跳到大块；② renderer 按 step 维护 reveal progress，首帧从 1 个 grapheme 开始、每帧最多 160 个，不按 block-end 时间跳过；③ `block-start` / `block-end` 立即 render；④ reveal 期间不再强制 33ms，沿用 frame cost 自适应间隔；⑤ 长 reasoning 仍以 3000 字素预览为展开预算；⑥ 新增 reveal reducer benchmark（600 turns + 3000 grapheme，median 1.7ms）确认帧成本在预算内，并把 reveal/wait helpers 拆到 `reasoning-reveal.ts` / `waiting.ts`，`transcript.ts` 961 行；⑦ 新增 `scripts/fake-tty-reasoning-slow-start.mjs`，真实 Host 下 placeholder→wait→逐帧 reveal→answer 顺序 PASS。transcript 测试 53→55；`pnpm check` 35 files / 324 tests 通过；stream/waiting/short-settle/tool-order/autocomplete/slow-start probes PASS。
- [x] 自动压缩统计核对与 tool output 修复（2026-10-19）：核对本次 `compaction/summary` 的 `shadowedSeqs.length = 859`、`shadowedTokenCount = 527432`、usage `384543/2443/387370`；TUI 卡片显示完全一致，压缩后 `contextPressure` 约 298K / 1M ≈ 29.8%，与「压缩前约 801K ≈ 80%」相符。修复 ① `tool/result` 按 callId 去重，已 settled 的重复结果不再更新卡片；② 记录 `compaction/prune` 的 shadowed seq/callId，命中后折叠为 `pruned`（不显示 args/result），并忽略晚到重复 result；③ `compact-checkpoint` 在匹配 compaction 卡片存在时不再单独渲染，窗口外才显示 240 字前缀。transcript 测试 55→58；真实 session 重放 late result 0、checkpoint context 0、pruned tools 42、compaction 卡片 859/527432 保持；`pnpm check` 35 files / 327 tests 通过。Host 侧仍会持久化重复 tool result，当前由 TUI 兜底。
- [x] 工作区审查修复（2026-10-19）：① `ToolCallMemory` 跨 retained-window 持久化 settled/pruned/callBySeq，晚到重复 result 不再因原始事件被 slice 而变成孤儿 tool 卡片；② `tool/call` 也按 callId 去重（含未结算跨窗口 replay），避免生成第二张卡或覆盖结果映射；③ fallback 只在 shadowed 事件已属于最近 provider 采样时扣除 prune/summary token，采样后新增再裁剪不会低估上下文；④ 子命令补全按当前过滤结果决定提交，`/provider a`、`/settings t` 等唯一 leaf 可一次 Enter，混合列表仍保持插入；⑤ pruned tool 卡片整卡隐藏，只保留 prune notice；⑥ 更新 app 注释与 slow-start probe 的断言。transcript 测试 58→62、metrics 32→33、autocomplete 11→13；`pnpm check` 35 files / 334 tests 通过。
- [x] 串行渲染改为时间盒与逐块 hold（2026-10-19）：定位到「thinking 尚未渲染完，正文/run_code 已在展开结束瞬间一起出现」的三个成因：① reveal 按帧 +160 字素推进，帧间隔退化到 100ms 时 3000 字素要 1.9s，`REASONING_REVEAL_MAX_MS=600` 实际不成立；② `holdAfterReveal` 在展开结束的那一帧原子放开所有后续块（实测单帧 +14 行）；③ 同一 assistant 块的 answer 文本在 `revealing` 期间整段不渲染，展开结束时整段 Markdown 一次性出现。修复：① reveal 改为按 wall clock 推进（`elapsed × rate`，rate 自适应保证 3000 字素预算内完成），100ms 帧下仍 600ms 完成，且不支持回退；② hold 改为逐块判断：只有 tool/compaction/info notice 被暂缓，user 消息、warning/error notice、后续 assistant 行与同块 answer 立即显示，边界之后的行全部按事件顺序放出；③ answer 文本在展开期间照常渲染；④ `clipGraphemes` / reveal 增加按文本缓存的 grapheme 分段（8 条 LRU），50k 字符 reasoning 的 reduce 中位数从 13.3ms 降到 0.10ms（冷启动 1 次 13ms）；⑤ `compact` 模式不再参与 reveal 与 hold；⑥ reveal 进度按 step 记录并在 `assistant/attempt` 或同 step 新 live 块时清除，重试从 1 个 grapheme 重新展开，进度 map 容量上限 64；⑦ delta 路径新增 `ASSISTANT_SETTLE_MS = 150ms` 的 settle grace，assistant 行最后内容与紧随其后的 tool 卡片不再落在同一帧。文件按职责拆分：`transcript.ts` 961 → 744 行（reducer），新增 `transcript-render.ts`（块渲染）与 `transcript-renderer.ts`（组件复用与 notice 排序）。测试：`tests/transcript.spec.ts` 62 → 68 例（延帧追赶、600ms 预算、重试不继承进度、settle grace、compact 不展开、边界只放行 warning）；`pnpm check` 35 files / 340 tests 通过。真实 Host 探针：`fake-tty-reasoning-stream` PASS、`fake-tty-reasoning-tool-order` PASS、`fake-tty-reasoning-slow-start` PASS（startAt 4637 → middleAt 5201，确认逐段展开；answer 在展开期间正常到达）。
- [x] 自动压缩 E2E 验收（2026-10-19，关闭 P1「自动压缩 E2E」）：用真实会话 `native-tui-9479c8bd-1142-4288-bc5b-0f5c0e4bd2c4`（command-code / `deepseek/deepseek-v4.1-flash-fast`，1M window，maxTokens 32768）复核 25 turns / 741 steps / 741 assistant messages 的完整事件流。触发是自动的：`compaction/start` 位于 turn 21 内部、前后为 `tool/result` 与 `compaction/summary`，全会话 `command/*` 事件为 0（没有手动 `/compact`）。阈值命中：压缩前最后一次请求 prompt = 798,777 tokens，`compactionThresholdTokens(1M, 32768) = 800,000`（`min(0.8 × 1M, 1M − 32768 − 65536)` = 80%），相差 1,223 tokens 即在下一 step 前触发。生命周期完整：start(4751) → summary(4752, `shadowedSeqs` 859 / `shadowedTokenCount` 527,432 / `shadowedRange` 8–3665 / summary 8,966 chars) → user/message `compact-checkpoint`(4753, 同 compactionId) → end(4754)，耗时 22.5s，全程仅一个 compactionId。prune：42 次 `compaction/prune`（184,896 tokens）全部发生在压缩前，压缩后为 0。效果：首个压缩后请求 prompt 222,987（相比 798,777 降 72%）；状态栏口径 `collectSessionMetrics` 在压缩前 ctx 79%（est 792,713）、压缩后 ctx 27%（est 265,281），阈值文案 `compact at 80%`。TUI 渲染：`✓ Context compacted  859 item(s) · ~527432 tokens` 卡片 + 823 字 summary 摘要，42 条 `Tool output pruned · N item(s) · ~M tokens` notice，`compact-checkpoint` 未产生重复 context 行（与已有卡片按 compactionId 去重），674 张 tool 卡片无残留 pending。结论：preset 自动压缩、prune、checkpoint 去重、context 百分比与阈值口径均与 Web 一致。
- [x] CodeBuddy 按模型声明输入模态并支持图片（2026-10-19，取代 `design-task-feature-codebuddy-builtin-plugin.md` §2/§10 的 text-only 决定）：网关 `/v3/config` 实测带 `supportsImages`/`disabledMultimodal`（CN 34 / EN 27 个模型），此前移植只读 `id/maxInputTokens/tags`，两条路由恒声明 `inputModalities: ['text']`，而 Host `adapterStream` 对不含 `image` 的声明直接把图片块投影成占位文本——图片是「静默消失」而非报错。改动：① `models.ts` 增 `inputModalitiesOf`（`disabledMultimodal===true` 优先，仅 `supportsImages===true` 声明 image，其余 text-only）并让目录与 seed 产出模态；② `adapter.ts` 三处模态改读目录/覆盖，新增 `models()` 摘要与 `imageRequestTarget` 覆写（与 wire 同投影）；③ `wire.ts` `buildChatPayload` 异步化，user 与 tool 角色的图片序列化为 OpenAI `image_url` base64 data URI，读图失败降级占位文本并写诊断，system/assistant 带图仍拒绝，新增 2048² 像素 / 1 MiB 的 `imageTargetOf`（对齐 `llm-pi-ai` 默认预算）；④ `codebuddy.ts` 增 `Config.models` 覆盖表与 `resolveAttachments` 注入（未挂载 attachment 服务时全部回退 text-only）；⑤ `/codebuddy models [cn|en]` 列出各模型声明的模态与来源（catalogue/override/seed）。实测结论：`supportsImages: true` 可信，`false` 只是「网关不承诺」（`default`、`glm-5.0` 声明 false 仍能读图），故需覆盖表兜底。验证：`pnpm check` 35 files / 355 tests 通过；新增 `scripts/codebuddy-image-e2e.mjs` 用真实账号跑通目录模态、user/tool 两张图（均答 `red/green`）、占位降级与角色拒绝 9 项（无凭据时 3 项自动 SKIP）。
- [x] CodeBuddy 图片实施审查修复（2026-10-19）：独立审查后逐条复现并修复 9 项。① `offloaded` 标记被忽略导致已卸载图片重发字节——改为输出 `offloadedImageText` 且预取时跳过；② 空覆盖 `input: []`（schema 对空对象的默认）被当成「不接受任何模态」——`overrideOf` 把空数组视为无覆盖；③ attachment 解析抛错会连带炸掉 `listModels`/`resolveModel`——`attachmentService()` 捕获并降级为「无服务」+诊断；④ developer 带图从「整条丢弃」变成抛错——角色检查跳过 developer；⑤ 同一附件重复读取——按 `attachmentId` 去重；⑥ 读图全串行——改 `Promise.all` 并发，消息拼装转同步；⑦ 每模型查一次 attachment 服务——每次 listing/`modelInfo` 只查一次；⑧ 长会话图片无上限（未实现 `IMAGE_OFFLOAD_REQUIRED`，Host 的 `compaction-image-offload` 对本路由不生效）——新增 20 MiB 内联预算 + `requiredImageOffload`，超限抛 `IMAGE_OFFLOAD_REQUIRED` 并携带 `offloadImages`（修正了一处把 base64 换算做了两遍导致计数翻倍的实现错误）；⑨ TUI `/attach` 给 text-only 模型贴图无提示——文件与剪贴板两条路径在暂存后查 `resolveModelInfo` 并 warning。测试：stream 18→23、adapter 21→24，`pnpm check` 35 files / 363 tests 通过；`scripts/codebuddy-image-e2e.mjs` 9 项、`fake-tty-codebuddy.mjs` 6 项、`fake-tty-codebuddy-models.mjs` 5 项全 PASS。
- [x] CodeBuddy 图片预算作用域修正（2026-10-19，二次审查）：首版 `assertImagesFit` 按 `options.messages` 全量计价，把两类根本不会发送的图片也算进 20 MiB 内联预算——developer 消息本就被整条丢弃（实测 12 MiB 的 developer 图会让只剩一张有效图的请求被判 `IMAGE_OFFLOAD_REQUIRED`），assistant 图片本应被角色检查拒绝却先报预算错误（掩盖了可操作的 `UNSUPPORTED_CONTENT`）。修复：新增 `sendingMessages()`（`filter(carriesImages)`），`buildChatPayload` 先逐条 `assertImageRole` 再对过滤后消息做预取与预算，`wireMessage` 内的重复角色检查移除。回归测试 stream 23→25（developer 图不占预算、角色错误先于预算）；独立脚本确认被丢弃的 developer 图完全不被读取；`pnpm check` 35 files / 365 tests 通过，`codebuddy-image-e2e.mjs` 9 项仍全 PASS。
- [x] Compaction 中断恢复（2026-10-19，关闭 P2「Compaction 中断恢复」）：原实现只在新 `compaction/start`、`assistant/message` 或 `turn/end` 时把未结束的 compaction 标成 `error`，Session 恢复后最后一段 orphan start 仍停在 `running`。复核 Host 真实写入顺序后发现关键事实：resume 时 agent-loop 先追加 `turn/end{kind:'interrupted'}`、再由 Session 构造追加 `session/end-seed`（后者才是释放 durable compaction lock 的标记，见 `dsh-compaction-basic` 的 `inspectCompactionEntryState`/`assertCompactionInactive`，end-seed 之后的 start 不再被视为 active）。因此修复为：新增 `compactionCloseState(event)`——把 `session/end-seed` 以及 `turn/end{interrupted}` 判为 `interrupted`，其余 `assistant/message`/`turn/end` 仍判为 `error`（summarizer 真失败）。`TranscriptBlock.compaction.state` 增加 `interrupted`，渲染为 `⚠ Compaction interrupted` + `Stopped before it committed; the session reopened after it.`，与 `✕ Compaction failed` 区分；同时补上 `turn/end{kind:'interrupted'}` 的 notice（此前该 reason 无任何渲染，恢复后的会话会在中途无声截断）。验证：① 单测 3 例（turn/end 先到、仅 end-seed、普通边界仍为 error），transcript 68 → 71；② 新增真实 Host 探针 `scripts/fake-tty-compaction-interrupted.mjs`——从真实 probe 会话派生日志（保留 Host 写入的精确事件形状），在末尾追加 `turn/start` + `compaction/start` 模拟崩溃，再用真实 `dsh --profile tui --resume` 打开，断言卡片为 `Compaction interrupted`、不出现 `Compacting context…`/`Compaction failed`、且出现 `Turn interrupted before it finished`；探针两次运行均 PASS。修复前用同一日志复现到的是 `✕ Compaction failed / Compaction did not finish`，证明该缺陷真实存在。`pnpm check` 35 files / 343 tests 通过。
- [x] CodeBuddy 冷启动能力查询修复（2026-10-19）：`/model` 重选一次才正常、首轮必报 `UNSUPPORTED_REASONING_EFFORT: provider "codebuddy" model "deepseek-v4.1-flash" does not support reasoning effort "max"`。定位：`agent-default-model` 持久化了 `codebuddy/deepseek-v4.1-flash` + `max`，但 adapter 的能力元数据来自懒加载的 `/v3/config`；构造时只播种 `CN_SEED_MODELS`（8 个 id，不含 `deepseek-v4.1-flash`，且 seed 按设计不带任何 reasoning 声明），`resolveModel()` 冷启动直接拿 seed 列表作答 → `known === undefined` → 返回的 fallback 无 `reasoning` → Host `resolveCallWithInfo` 拒绝显式 effort。`/model` 菜单先调 `listModels()` 触发目录刷新，故重选后能力正确、effort 得以保留。修复：新增 `catalogueOf()`，`resolveModel` 与 `prepareCall` 先做 TTL 内有界的目录刷新再取元数据，`modelInfo` 改为接收目录参数；目录请求失败时仍回退 seed 列表并记诊断，不让能力查询变成传输错误。端到端复现：修复前冷启动 `fetch` 次数 0、`reasoning: NONE`，修复后 1 次且 `['off','low','high','max']`、`max` 被接受；连续 3 次能力查询 + 1 次列表仍只 1 次请求（TTL 生效）。测试：`tests/codebuddy-adapter.spec.ts` 24 → 27 例（冷启动读目录、TTL 只请求一次、目录失败仍可回答）；`pnpm check` 35 files / 368 tests 通过。
- [x] CodeBuddy 图片实施审查修复（2026-10-19，独立审查后修复 P1/P2/P3）：① **P1 覆盖失效无法识别**——`modalitiesOf` 在无 attachment 服务时把含 image 的声明降级为 text-only，而 `models()` 的 `source` 只看覆盖是否存在，导致「覆盖被降级」仍打印 `[override]`，README 却声称「覆盖是否生效在这里可见」。修复：`ModelSummary` 增 `declaredModalities`（降级前的生效声明）与 `degraded: 'no-attachment-service'`，`models()` 显式上报降级，渲染层按 `degraded` 而非猜 `statedModalities` 输出 `(<source> asks for images; no attachment service mounted, so text only)`；新增用例区分「目录声明图片」「覆盖声明图片但降级」「覆盖生效」三种状态。② **P2 索引断言**——`prepareImages` 用 `entries[index] as PreparedImage` 按位置配对，`Promise.all` 保序时正确但被 `as` 掩盖，未来改动会静默串图；改为每个任务返回 `[ref, prepared]` 按引用建映射。补乱序完成用例（A 慢 B 快）验证按 identity 配对。③ **P2 类型不一致**——`attachments.ts` 用内联结构类型绕过 `LLM`，且服务缺失时被 `?.` 静默短路；改为复用 `LLM` 并显式判空，同时给 `LLM.getModelInfo` 返回类型补 `inputModalities`。④ **P3**——`TEXT_ONLY`/`TEXT_AND_IMAGE` 加 `Object.freeze`（宿主 `detachedModalities` 每次都复制，故此前安全但引用可变）；`imageTargetOf` 对畸形尺寸不再静默投影成 1×1，改为按满像素预算的正方形，避免编码出不可读缩略图且无诊断。测试 368 → 375（新增降级上报 3 例、渲染 2 例、畸形尺寸 1 例、乱序配对 1 例）；`pnpm check` 35 files / 375 tests 通过。
- [x] 输入框 Esc 清空草稿（2026-10-19）：输入框获得焦点且存在文本时，Esc 清空输入框而不是透传；运行中同样优先清草稿，只有输入为空才取消 turn，overlay（审批、选择器）聚焦时不触发。`globalShortcut` 改为接收 `ShortcutState`（`running` / `editorFocused` / `editorHasText`），`app.ts` 用 `tui.getFocusedComponent() === editor` 与 `editor.getText()` 判定。测试：keymap 4→6 例（focused+text 清空、unfocused/empty 不清空、key release 不触发）；`pnpm check` 35 files / 377 tests 通过；真实 TUI 探针 `scripts/fake-tty-esc-clear.mjs` PASS（输入 draft-marker → Esc → 空 Enter → 输入 real-prompt 发送；agent 请求仅 1 次，body 含 real-prompt、不含 draft-marker，退出码 0）。
- [x] 插件安装脚本（2026-10-19）：新增 `scripts/install.sh`，默认安装到 `tui` profile，支持 `--profile <name>`、`--pack`（先打包到 `.tmp`，移除旧安装后再安装 tgz）、`--no-build`；默认执行 `pnpm install --frozen-lockfile` + `pnpm build`，再通过 `dsh plugin --profile <name> add` 安装（默认 link 当前 checkout），profile 不存在时由 dsh 初始化。pack 模式必须先移除旧安装：实测 profile lockfile 已锁定同一 tgz 路径与版本时，pnpm 会跳过 resolution，同版本重打包后直接 `add`（含 `--force`）仍保留旧内容；改为 remove + add 后连续两次重打包分别正确更新到 `fourth` / `fifth`。验证：`bash -n` 通过；临时 `DSH_HOME` 下 link 模式写入 `link:` 依赖、`--pack` 模式写入 `file:...tgz` 依赖且 tgz 含 `dist/index.js`、`cordis.patch.yml`、README；全新 profile 不会误报移除，`--profile` 缺值与未知参数均以退出码 1 失败；README 安装章节同步脚本用法。
- [x] PTC 内嵌 write/edit diff 卡片（2026-10-20）：`run_code` 程序里调用的 write/edit 此前只会出现在外层 run_code 的 result 文本里。现在按 Host 的 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 事件为 write/edit 建独立工具卡片，settle 时读取 `content` / `isError` / `meta.diffs` 并渲染 ± 行；只给 write/edit（或带 diffs 的子调用）建卡，bash/read 等仍折叠在 run_code 结果里，避免重复。start 被窗口裁掉时由 dispatch 直接补 settle 卡片；重复事件与 rebuild 去重；父 run_code 被 prune 时子卡片一并隐藏。另补 write 新建文件的 diff：Host 对 create 记录空 `diffs`，TUI 从调用参数 `content` 合成 `oldText: null` 的 + 行（顶层 write 同样生效）。验证：`tests/diff.spec.ts` 5→8 例、`tests/transcript.spec.ts` 71→77 例；`pnpm check` 35 files / 386 tests 通过；真实 TUI 探针 `scripts/fake-tty-ptc-diff.mjs` PASS（mock 模型调用 run_code → write + edit，屏幕出现 write 的 `│ + before` 与 edit 的 `│ - before` / `│ + after`）。
- [x] provider 导入模型保存输入类型（2026-10-20）：`/provider add` 与 `/provider models` 导入的模型此前只写容量，`input` 留空由配置 schema 物化为 `[]`，pi-ai 再把「缺失/空」都当作未声明并继承 route 的 `defaultInput`（默认 text）——实测当前 profile 的 92 个导入模型全部是 `input: []`，只有 1 个手写条目声明了 `text+image`。刷新路径还因为 `current?.input === undefined` 永远不成立（schema 返回 `[]`），即使 discovery 给了模态也不会回填。改动：① 新增 `discoveredInputModalities`，过滤 text/image、去重，未声明时返回 `['text']`；② `buildDiscoveredModelEntry` 与 `mergeDiscoveredProviderModels` 为每个导入模型显式写入 `input`，已有模型的空/缺失 `input` 视为未声明并用 discovery 声明回填，非空声明保留；③ `/provider add` 恢复 Input modalities 询问：discovery 声明 image 时默认 `Text + image`，未声明时默认 `Text only` 但可手动改成 `Text + image`；保存提示显示 `input text only` / `input text+image`。④ `/provider models` 的完成提示会说明 listing 未声明输入类型、模型按 text-only 保存。⑤ 实测 command-code 的 `GET /provider/v1/models` 只返回 `id/object/created/owned_by/name/context_length/supported_endpoints`，没有任何模态字段，该路由也不在 pi-ai catalog，所以 Host discovery 不可能给出 `inputModalities`；但用 320×160 合成图（左 green / 右 orange / 左上白方块）直接调用网关，`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-fast` 均正确回答 `left=green, right=orange, white_square=top-left`（`/chat/completions` 与 `/responses` 都可），`deepseek-v4-pro` 返回 `Unable to view image.`。结论：listing 无模态不等于模型无视觉，text-only 只能作为缺省值，必须保留手动覆盖入口。验证：`pnpm check` 35 files / 387 tests 通过（providers 12→13）；真实 Host 探针 `fake-tty-provider-fetch` / `provider-add` / `provider-discovery` / `provider-merge-second` PASS，落盘 YAML 中选中模型、同批 sibling 与刷新回填模型均为 `input: [text]`。
- [x] 手动编辑模型输入类型（2026-10-20）：command-code 的 `/provider/v1/models` 不返回模态，`/provider models` 只能按发现值/text 落盘，操作者缺少改单个模型的 UI 入口。新增：① `src/runtime/model-input.ts` 定位/校验/写回 `input`——显式 `models` 条目优先，catalog route 写 `modelOverrides.<model>.input`，`models` 来自其他配置层时确认后整体重写；空或缺省 `input` 视为 inherit。② `/provider input [provider/model]` 默认编辑当前会话模型，`/provider edit <route>` 菜单新增 **Edit model input types**（route 内模型搜索选择）；向导显示 current，可选 Text only / Text + image / Inherit route default。③ 非 llm-pi-ai route、未列出模型、非法 `input` 都有明确拒绝与修复指引。测试：新增 `tests/model-input.spec.ts` 10 例（定位、inherit、override、leaf/full-array 写回、校验、摘要）；`pnpm check` 36 files / 397 tests 通过；真实 TUI 探针 `scripts/fake-tty-provider-input.mjs` PASS（`/provider input mock/mock-model` 写 text+image → `/provider edit mock` 菜单改回 text only → 再次打开显示 `current: text only` → 选 Inherit 删除显式 `input`，落盘 YAML 不再有 `input` 字段）。
- [x] 工具卡片背景改为中性色（2026-10-20）：深色主题的全宽工具卡片原用 256 色 `22`（绿），在终端调色板映射下会变成饱和亮绿，整块卡片压过正文。改为中性暗灰 `48;5;237`（light 用 `48;5;253`），成功/失败仍由 `⚙`/`done`/`error` 标签表达。测试：新增 `tests/theme.spec.ts` 4 例（dark/light tool band、三种 band 互异、plain 无背景、真实工具卡片渲染包含 `48;5;237` 且不含 `48;5;22`）；`pnpm check` 37 files / 401 tests 通过。
- [x] 其他预设卡片渲染检查（2026-10-20）：确认只有 `ptc` 预设通过 `tool-presentation` 的 `mode: ptc` 暴露 `run_code` 并产生 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`；`standard` / `cordis` 未声明该行，继承 `dsh-tools` 默认 `native`，`write`/`edit` 走直接 `tool/call` + `tool/result`，沿用既有顶层卡片与 diff 渲染；`minimal` 的 `tool-fs` 关闭 write/edit，只剩 bash/readImage。新增 `scripts/fake-tty-native-diff.mjs` 用 standard 预设 + mock 模型直接调用 write/edit，PASS（`⚙ write` / `⚙ edit`、`│ - before` / `│ + after`、无 `run_code` 卡片）。结论：PTC 的嵌套卡片解析不需要复制到其他预设，渲染仍由事件类型驱动。
