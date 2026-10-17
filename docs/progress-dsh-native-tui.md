# dsh-native-tui 实施进度

> 记录时间：2026-10-17 17:48 CST
> 工作区：`/Users/wangzy/WorkSpace/WebStormProjects/dsh-native-tui`
> 状态：**Goal complete**（30/30 轮），插件可构建、可测试、可安装
> 包版本：`dsh-native-tui@0.1.0`
> 关联文档：[README](../README.md)、[Host-native 方案](design-task-feature-dsh-native-tui-host-native.md)

## 1. 结论

已完成一个可在最新 DeepSeek Harness 上通过 `dsh --profile tui` 启动的 host-native TUI 插件。实现覆盖会话、流式对话、Markdown、工具卡片、审批/问答、模型/命令、Workspace、Schedule、Agent Presets、Settings、Plugin Manager，以及文件、附件、图片、跨 Session 引用、变更摘要、Deliverables、导出和全屏终端模式。

交付物是可安装的 tarball 与完整源码，不是一次性的演示脚本：

```sh
pnpm check
pnpm pack --pack-destination .tmp
dsh plugin --profile tui add .tmp/dsh-native-tui-0.1.0.tgz
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
| 对话 | 流式 assistant/reasoning、Markdown、steer、cancel、失败 turn 展示 |
| 工具 | 工具卡片、write/edit diff 行、`/tools`、`/tool <index>` 分页、`/diff [index]` |
| 审批/问答 | approval waterfall、question 面板、Other 自由文本 |
| 模型/命令 | 模型选择、第三方 provider 引导、权限预设、Host commands、jobs、subagents |
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

Test Files  17 passed (17)
Tests       86 passed (86)
```

### 安装与启动

最终验证使用全新 DSH_HOME：

```text
DSH_HOME=/tmp/dsh-native-tui-pack30-home
dsh plugin --profile tui add .tmp/dsh-native-tui-0.1.0.tgz
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

### 未完成真实验证

- **没有模型凭据**，真实模型流式回合、真实工具调用、真实审批/问答 waterfall 未端到端跑通；只验证了事件管线、失败 turn、UI 路径和 Host 服务。
- 沙箱无法创建真实 PTY，使用 fake-TTY 包装验证。
- 真实 `present` 工具事件未触发，deliverables panel/reveal 只有格式化和空缺路径验证。
- 真实终端鼠标拖拽/选择复制未验证。

## 5. 主要产物

```text
package.json                 dsh-native-tui@0.1.0
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
.tmp/dsh-native-tui-0.1.0.tgz
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
- 真实审批/工具/模型流式回合缺少凭据验收。
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

当前代码与 111 个测试通过（25 个测试文件）；以下按优先级保留，不再混入已完成项。

### P1

- [ ] **自动压缩 E2E**：用低 context window 模型跑多轮长历史，断言 compaction start/summary/end/prune、下一轮请求 token 下降、context 百分比下降；当前只验证 preset wiring、手动 `/compact` 和事件渲染。
- [ ] **Settings 覆盖完整化**：当前 wizard 覆盖 thinking/run_code/transcript entries/theme/fullscreen；title、cwd、sessionId、showReasoning 仍需 profile YAML 或高级命令。`Host settings…` 仍只是 namespace 列表，不是完整内嵌编辑器。

### P2

- [ ] **Compaction 中断恢复**：已能在新 start/assistant/turn end 时把未结束 compaction 标 error；若 Session 恢复时最后一个事件就是未结束的 start，仍会显示 running。需要 resume 时处理 orphan start 或加 stale 标记。
- [ ] **Context 百分比精确性**：compaction 后只按 `shadowedTokenCount` 做近似扣减，未计 summary 本身 token；需要结合 token meter/下一次 usage 修正。
- [ ] **真实 PTY**：fullscreen 鼠标滚动、选择复制、Ctrl+D 恢复尚未在普通终端验收。
- [ ] **真实审批/模型/tool waterfall**：approval 已有 allow/reject/cancel 弹窗测试，但真实模型流式、工具调用和审批链路仍缺凭据环境验收。
- [ ] **Settings wizard 自动化测试**：覆盖打开弹窗、修改 mode/entries、settings 持久化、theme/fullscreen restart 提示。

### P3

- [ ] 远端连接（连接已有 dsh web Host）。
- [ ] 官方目录之外的市场搜索。
- [ ] PDF/Office 富文档预览。
- [ ] 多 Agent 并发/后台会话视图。
- [ ] 发布名称、scope、CI/publish 策略；当前 package 为 private。

### 已完成，不再作为剩余项

- [x] Session resume 恢复 model/reasoning effort/preset。
- [x] `/model` 内联搜索。
- [x] computer-use 用户侧实机可用。
- [x] approval dialog allow/reject/cancel 与 reason 渲染测试。
- [x] MCP fiber 激活失败 Loader row 清理。
- [x] MCP settings 实时 reconcile：`settings/document-updated` 驱动 manager 对新增/修改/删除 server 就地装载或卸载，不再需要重启 TUI；`tools/change` 加工具集合驱动 connect/disconnect 回推（mcp-manager 共 13 个单测）。
- [x] MCP 真实 tools/call E2E：`scripts/mcp-tools-call-e2e.mjs` 用真实 cordis 加官方 mcp-client 连接 `scripts/fake-mcp-stdio.mjs`，断言 `mcp__demo__echo` 的 stdio 往返结果。
- [x] MCP 真实 TUI 回归：`scripts/fake-tty-mcp.mjs` 以绝对路径 `node` 启动 `scripts/fake-mcp-stdio.mjs`，`/mcp add` 后**不重启**直接 `/mcp list` 显示 `connected`，证明 settings → reconcile 与状态回推在真实 Host 中生效。
- [x] 修复 MCP 状态探测导致的误判：mcp-manager 原先直接读 `ctx.tools`，但它未 inject `tools`，而 Cordis 代理对未注入服务读属性会抛 `cannot get property "tools" without inject`，使连接成功的 server 被判为 error 并卸载。改为 `ctx.get('tools')` 并对探测失败完全容错；单测补了对应回归防护（mock 复现该抛错行为）。
- [x] 修复 `/mcp add`（stdio）参数输入：arguments/environment 原先预填 `[]`/`{}`，用户输入会被插到前面并保存成 `path[]`，导致 `Cannot find module ...path[]`。改为不预填、由 placeholder 提示，并让 `showTextInput` 支持空提交（新增 `allowEmpty`），回车即表示无参数/无额外环境变量。
- [x] MCP 真实服务器实测：官方 mcp-client 直连 profile 中的 `idea`（streamable-http，`127.0.0.1:64342/stream`），注册 67 个工具，`get_all_open_file_paths`、`get_project_modules` 两次只读 `tools/call` 均返回真实数据。IDEA 侧要求显式 `projectPath`，未传时以业务错误返回当前打开项目列表。
- [x] compaction 事件卡片、`/compact` 输出去重、context 近似扣减。
