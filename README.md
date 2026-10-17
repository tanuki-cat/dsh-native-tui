# dsh-native-tui

DeepSeek Harness 的 host-native 终端前端，基于 pi-tui。

> 状态：实施完成（30 轮 + 第三方模型引导 + 官方 MCP/computer-use 集成，117 个单元测试通过）；已知差距见进度记录。
> 目标：在 TUI 中提供 Web 模式的核心能力，而不是复制浏览器图形界面。
> 架构说明与差距清单：[Host-native 方案](docs/design-task-feature-dsh-native-tui-host-native.md)。
> 实施进度、验证证据与未验收项：[实施进度](docs/progress-dsh-native-tui.md)。

## 特性

- 新建/恢复 Session，owned root Agent。
- 流式文本、Markdown、reasoning、工具卡片（write/edit 结果渲染 ± diff 行）、turn 失败提示。
- 本地命令与宿主命令执行（compact/feedback/goal/permission/plan）；slash 命令支持子命令补全，例如 `/provider` 显示 add/list/remove。
- 审批与问答 waterfall；所有独立 overlay（Choice/TextInput/Approval、Markdown/Text Pager、Image）统一使用带边框和全宽背景的 opaque dialog frame，长内容自动换行/补齐。
- 模型选择器（LLM catalog 为空时明确提示）、reasoning effort 切换、权限预设、后台任务、子代理列表。
- 模型与 reasoning effort 通过 Host `agentDefaultModel.saveSelection` 持久化；重启或 `/new` 沿用，不再回落默认。
- 第三方模型：`/provider add` 引导配置 pi-ai gateway/catalog route，`/provider list|edit|models|remove` 管理。
- 默认集成官方 `@deepseek-ai/dsh-computer-use`、`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`、`@deepseek-ai/dsh-mcp-client`（以及 mcp-resources）。
- `/mcp add|list|remove` 配置 stdio / Streamable HTTP MCP 服务；配置持久化到 `mcp-manager.servers`。
- Agent Presets：standard / ptc / minimal / cordis；/preset 可在首个 turn 前切换当前 Session，已开始的 Session 锁定并用于下一次 /new；选择同时写入 `agent-preset-registry.selectedDefault`，重启后继续使用。
- Workspace 列表/创建/切换/pin/unpin/archive/unarchive；Schedule 列表/创建/删除；Settings 顶层/嵌套对象/数组字段编辑与 JSON 写入；Plugins 列表/官方市场/检查/安装/移除/启停（带确认，实时应用）。
- 可选 `fullscreen`：TuiAltScreen + ScrollView，header/status/editor 固定，鼠标滚轮滚动、文本选择复制。
- Transcript 层次：参考 pi agent 使用全宽背景带（用户消息、reasoning、tool 输出）、assistant/context 标签、notice 图标、turn 分隔线；本地命令输出按 durable event sequence 插入，不会一律堆在 transcript 末尾。
- 运行中 `Esc` / `Ctrl+C` 取消 turn；长文本和 tool 输出按行保持左侧色条。
- 上下文压缩：默认 preset 启用 `compaction-basic` 自动压力压缩与 context-overflow 恢复，以及 tool-result pruner；TUI 渲染 compaction start/summary/end 和 prune 通知，`/compact` 作为 Host command 可手动触发。
- 显示密度可配置：`thinkingDisplay` 与 `runCodeDisplay` 均支持 `hidden | compact | detailed`；后者覆盖 `run_code`、`bash`、`pwsh` 等代码执行工具卡。
- 状态栏常驻当前模型和会话指标：`● idle  model provider/model`、preset/effort/快捷键、turns/steps、tok/s、累计 token、cache hit、context 使用率；header 只保留 Session id 和 cwd。
- `@@<query>` 自动补全其他 Session 的 canonical mention；发送时 Host session-reference 自动注入快照。
- `/export [path]` 导出 Session JSONL；`/export zip [path]` 导出含 manifest、attachments、deliverables 的 ZIP bundle；`/export html [path]` 导出静态 HTML transcript；`/open` 预览文本文件，Markdown 以 pi-tui Markdown 样式分页渲染；`/preview` 渲染 PNG/JPEG/GIF/WebP 图片；`/files` 浏览目录并预览；`/attach` 暂存文件/图片或剪贴板图片并随下一条 prompt 发送（8 MiB 上限），`/attach preview <i>` 可内联预览暂存项，`/attachments` 打开暂存附件管理器（预览/移除）；`/deliverables` 可列出、打开 panel、预览或用系统文件管理器定位 present 交付文件；`/tools` 列出工具调用，`/tool <index>` 分页查看完整参数/结果，`/diff [index]` 查看 write/edit 的独立 diff。
- 问答/审批在 preset Agent 上仍可用（question probe 已通过）。
- `@file` 主机端补全（file-reference-local）与 `/` 本地/宿主命令补全；选中的路径作为普通 prompt 文本，模型需用 read 工具读取。
- 会话列表/按 id 恢复、状态、清屏、安全退出、终端恢复；恢复 Session 时读取持久化的 model/selection 与 request/header，恢复模型、reasoning effort 和 preset；退出后打印 Session ID 和可直接执行的 `--resume` 命令。
- 非 TTY 显式失败；Ctrl+C/Ctrl+D/SIGTERM/SIGHUP 安全退出。

## 安装

~~~sh
pnpm install
pnpm build

# 在全新或已有的 DSH profile 中安装；dsh 会启用 bundle
dsh plugin --profile tui add /absolute/path/to/dsh-native-tui

# 启动
dsh --profile tui

# 直接恢复上次 Session（退出时打印的 Resume 命令）
dsh --profile tui --resume <session-id>
~~~

DSH Host 包由当前 dsh 安装提供；插件运行时还依赖 pi-tui、schemastery、fflate，以及官方 computer-use / mcp / session-stats rc.2 包。
安装路径使用 link: 时，修改源码后重新 pnpm build 即可生效。

## 命令

| 命令 | 作用 |
|---|---|
| /help | 本地命令、宿主命令、按键提示 |
| /new | 创建新 Session 并切换 |
| /init | 在当前项目生成 AGENTS.md 贡献指南（已存在则不覆盖） |
| /sessions | 列出本终端创建的 Session（排除 Web Session 与 subagent 子会话） |
| /resume <id> | 恢复指定 Session |
| /status | Session、cwd、模型、状态、事件数 |
| /clear | 仅清空终端视图 |
| /cancel | 取消当前 turn |
| /model [provider/model] | 打开可搜索的模型列表或直接切换；选择同时保存为默认模型 |
| /reasoning [effort|default] | 列出或切换当前模型的思考强度并保存；default 清除显式 effort |
| /provider [add|list|edit [route]|models <route>|remove <route>] | 配置/查看 provider；打开配置获取可用模型；刷新或删除 route |
| /mcp [add|list|remove <name>] | 配置、查看或删除 MCP 服务 |
| /permissions [preset] | 列出或切换权限预设 |
| /jobs [kill <id>] | 列出或终止后台任务 |
| /agents | 列出直接子代理 |
| /preset [id] | 首个 turn 前切换当前 Session；已开始则用于下一次 /new；同时保存默认 preset |
| /workspaces [new <path>|use <id|path>|pin|unpin|archive|unarchive] | 列出/创建/切换/固定/归档 workspace 会话 |
| /schedule [add <seconds> <title>|delete <id>] | 列出/创建/删除一次性提醒 |
| /plugins [list|market [query]|inspect <spec>|install <spec>|remove <bundle>|enable <entryId>|disable <entryId>] | 列出、浏览官方市场、检查/安装/移除 bundle，或启停插件项 |
| /settings [tui|host|edit <ns>|items <ns> <field>|set <ns> <json>] | `tui` 打开基础显示/终端配置弹窗（thinking、code execution、transcript、theme、fullscreen）；`host`/`edit`/`items`/`set` 进入高级 Host settings |
| /export [path|zip [path]|html [path]] | 导出 JSONL、ZIP bundle，或静态 HTML transcript（不覆盖已有文件） |
| /open <path> | 预览文本（16 KiB 上限）；Markdown 渲染为样式化分页 |
| /files [path] | 目录浏览：Enter 进入目录/预览文件，Esc 退出，含 ../ |
| /preview <image> | 用 pi-tui Image 渲染 PNG/JPEG/GIF/WebP；不支持时显示文本占位 |
| /changes [diff <index>] | 查看最近一轮 workspace 变更文件/单文件 diff |
| /deliverables [panel|open|reveal <index>] | 列出、打开 panel、预览或用系统应用定位 present 交付文件 |
| /tools · /tool <index> | 列出工具调用，或分页查看完整参数与结果 |
| /diff [index] | 分页查看最近/指定工具调用的 write/edit diff |
| /attach <path>|paste|preview <i>|list|clear | 暂存或预览文件/图片/剪贴板图片，随下一条 prompt 发送 |
| /attachments | 暂存附件管理器：预览或移除 |
| /exit, /quit | 退出并恢复终端；也可直接输入裸 `exit` / `quit` |

Enter 发送；运行中 Enter 作为 steer；Ctrl+C 取消/退出；Ctrl+D 退出。

## 配置

~~~yaml
- id: native-tui
  name: dsh-native-tui
  config:
    sessionId: native-tui-fixed   # 可选：恢复固定 Session
    cwd: /path/to/workspace
    showReasoning: true         # legacy boolean; false maps thinkingDisplay to hidden
    thinkingDisplay: detailed   # hidden | compact | detailed
    runCodeDisplay: detailed    # code execution cards (run_code/bash/pwsh): hidden | compact | detailed
    maxTranscriptEntries: 2000
    fullscreen: false              # true 使用 alt-screen + 鼠标/应用滚动
    theme: auto                    # auto | dark | light | plain
    agentPreset: ptc               # 默认 ptc | standard | minimal | cordis
    title: DeepSeek Harness
~~~

显示模式：

- `hidden`：不渲染 reasoning / `run_code` / `bash` / `pwsh` 块。
- `compact`：reasoning 只显示首行摘要；代码执行工具只显示状态 + description/command/code 单行摘要。
- `detailed`：当前完整 reasoning 区带与代码执行工具 args/result 卡片。

`/settings` 默认打开 **TUI settings** 独立弹窗，可修改 thinking/code execution 显示模式、transcript entries，以及 theme/fullscreen；显示模式和 transcript entries 立即生效，theme/fullscreen 保存后重启生效。`/settings host` 查看高级 Host settings 命名空间，原有的 `/settings edit|items|set` 仍可用。

默认模型来自 Host 的 ctx.agentDefaultModel（Base 默认 deepseek-official/deepseek-flash）。没有凭据时首个请求会显示 MISSING_CREDENTIAL。

## 第三方模型

`/provider add` 提供引导流程：

1. 选择 Custom OpenAI-compatible / OpenAI Responses / Anthropic-compatible gateway，或 Built-in pi-ai catalog route。
2. 输入 route、baseURL，然后选择 Credential source：
   - **Store API key in DSH credentials（推荐）**：直接粘贴 key。key 存入 DSH credential store（`~/.dsh/.credentials.yaml`，权限 0600），不写入 profile；无需 export。输入时 key 在终端可见。
   - **Use an environment variable**：输入 UPPERCASE 变量名，启动 dsh 前在 shell export。
3. custom gateway 会调用 Host `discoverModels` 请求 `GET {baseURL}/models` 并列出模型（5 秒超时）。
4. 从自动发现的模型中选择，或回退到手动输入 model id/context window/max tokens。**发现列表中的其他模型也会写入该 route**，之后可在 `/model` 中直接切换；选中模型会带上本次选择的 input/reasoning，其他模型使用 discovery 返回的容量/模态。
5. 选择 Input modalities：`Text + image`（vision）或 `Text only`。生成的模型配置会显式写入 `input`；未知能力的自定义网关默认先选 `Text + image`。
6. 输入 Reasoning levels（逗号分隔，默认 `low,medium,high`；留空表示不支持 reasoning）。生成的模型配置会写入 `reasoningEfforts`，之后可用 `/reasoning` 切换。

`apiKeyEnv` 保存的是 credential reference（环境变量名或 DSH credential 名称），不是 key 明文。env 模式下若变量未设置会拒绝保存；store 模式直接写 credential store。

已有旧 provider 不会被自动改写；重新 `/provider add` 同一 route 时选择 **Add/replace this model, keep other models** 会重新导入并保留已有模型，不会只剩一个。也可以手动补：

```yaml
input:
  - text
  - image
reasoningEfforts:
  low: low
  medium: medium
  high: high
```

也可以在 route 级使用 `defaultInput: [text, image]`，让该 route 下未声明 `input` 的模型继承。`reasoningEfforts` 的 key 是 Harness 选择项，value 是该网关实际接收的 wire spelling；引导默认同名映射，网关拼写不同（例如 `minimal`）时请按实际值修改。

切换思考强度：

```text
/reasoning
/reasoning high
/reasoning default
```

运行中切换会在下一 step 生效；状态栏会显示 `effort high`。

env 模式示例：

```sh
export MY_GATEWAY_API_KEY=...
dsh --profile tui
```

`/provider list` 显示已配置 route、可见模型数以及 credential 状态（`(stored)` / `(not set)`）；`/provider remove <route>` 删除 route。若 `/model` 仍为空，确认 credential 可用；llm-pi-ai 在凭据缺失时会故意返回空模型列表。

刷新已有 provider 的模型目录：

```text
/provider
/provider edit command-code
/provider models command-code
```

`/provider` 打开 provider 选择；`edit` 进入配置菜单（Fetch available models）；`models` 直接获取。查询使用已保存的 baseURL/API 协议/credential，把 endpoint 返回的模型合并进 route：新模型追加，已有模型更新容量，保留已有 input/reasoningEfforts。

**不要在 env 模式把 key 填进变量名。** 流程要求 UPPERCASE 环境变量名，并拒绝形似 key 的输入。若旧配置已经把 key 写入 `apiKeyEnv`，立即执行 `/provider remove <route>`，检查 `cordis.patch.yml` 中对应配置，并轮换该 key。手工 JSON 配置仍可通过 `/settings set llm-pi-ai ...` 或 Web Models page 完成。

## MCP 服务

默认 bundle 集成官方 `mcp-client` 与 `mcp-resources`。TUI 通过 `mcp-manager` 管理服务配置：

```text
/mcp list
/mcp add
/mcp remove <name>
```

`/mcp add` 支持：

- `stdio`：command、args（空格分隔或 JSON 数组）、env JSON；args/env 留空即表示无参数、无额外环境变量
- `streamable-http`：URL、headers JSON

配置写入 profile 的 `mcp-manager.servers`；mcp-manager 将每个条目映射为官方 `mcp-client` Loader row，并在 Loader fiber 激活后记录状态。settings 变更会实时 reconcile 这组 row，因此新增、修改、删除服务都无需重启 TUI。

```text
/mcp list
```

每行显示 `connected` / `starting` / `error: ...` / `disconnected: ...` / `not loaded`。mcp-manager 使用 `failOnStartupError` 并 await fiber，因此初始连接失败会显示错误，而不是静默成功。运行中 mcp-client 会自行重连：重连期间其工具保持注册，状态仍为 `connected`；一旦重连耗尽或禁用重连，mcp-client 注销该服务的工具，mcp-manager 通过 `tools/change` 观测到后标记 `disconnected`。

新增或修改配置后 mcp-manager 立即装载（`/mcp list` 会短暂显示 `not loaded`/`starting`），无需重启。MCP tools 以 `mcp__<serverName>__<toolName>` 暴露。

## 开发与验证

~~~sh
pnpm check          # typecheck + 117 unit tests + build
pnpm test
pnpm build
~~~

当前沙箱无法创建 PTY，使用 fake TTY 包装器验证真实 Host 启动：

~~~sh
# 使用已有的测试 profile（外部目录，不污染仓库）
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-smoke.mjs

# 命令、失败路径、问答题探针
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-interaction.mjs
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-question.mjs
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-preset.mjs
~~~

普通终端环境可运行真实 PTY 冒烟：

~~~sh
python3 scripts/pty-smoke.py
~~~

## 已知差距

Plugin Manager 官方目录之外的市场搜索（官方目录浏览已实现）、PDF/Office 富文档预览（Markdown 已支持）、会话级附件管理器（当前覆盖 staged 附件）、远端连接尚未实现。computer-use 已经可用；MCP 状态覆盖初始激活与运行中的工具注销，但 `dsh-mcp-client` 未暴露"重连进行中"的中间态；自动压缩已接入 preset 并有事件卡，但真实长上下文 E2E 仍需补。详见架构文档第 6 节。

## 兼容性

- 已在全局 dsh 0.2.1-rc.2 上安装并启动；生产与开发依赖统一为 0.2.1-rc.2。
- Preset patch 从 `@deepseek-ai/dsh-web-app` 的 standard/ptc/minimal/cordis 复制而来；standard/ptc/minimal 需要 `subagent-model-selection-settings` Host 行，cordis 需要 cordis host-runner 与 tool-cordis/host。`@file` 补全依赖 `@deepseek-ai/dsh-file-reference-local`。
- pi-tui 1.3.0；Node 22.23.3。

## License

[MIT](LICENSE)
- package 仍为 private；许可证为 MIT。