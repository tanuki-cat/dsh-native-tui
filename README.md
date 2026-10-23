# dsh-native-tui

DeepSeek Harness 的 host-native 终端前端，基于 [pi-tui](https://github.com/earendil-works/pi-tui)。

Session、模型、工具、审批、压缩、MCP、插件都由 Host 提供，本包只负责终端界面与少量 Host 侧适配：它要在终端里做到 Web 模式的核心能力，而不是把浏览器界面搬进 TUI。

> 设计方案与差距清单：[Host-native 方案](docs/design-task-feature-dsh-native-tui-host-native.md)
> 实施进度、验证证据与未验收项：[实施进度](docs/progress-dsh-native-tui.md)

## 快速开始

### 环境要求

- Node `^22.19.0 || >=24.0.0`
- pnpm（仓库使用 `pnpm-lock.yaml`，不要用 npm / yarn）
- 全局安装的 `dsh` 0.2.1-rc.2

### 安装

~~~sh
# 一键安装到默认 tui profile（link 当前 checkout；--pack 改为安装 .tmp 下的 tgz）
./scripts/install.sh

# 指定 profile
./scripts/install.sh --profile work

# 等价手动步骤
pnpm install
pnpm build
dsh plugin --profile tui add /absolute/path/to/dsh-native-tui
~~~

`scripts/install.sh` 默认执行 `pnpm install --frozen-lockfile` 与 `pnpm build`，再通过 `dsh plugin --profile tui add` 安装。可选参数：

| 参数 | 作用 |
|---|---|
| `-p, --profile <name>` | 安装到指定 profile，默认 `tui` |
| `--no-build` | 跳过 install 与 build 前置步骤 |
| `--pack` | 先打包，再移除旧安装并安装独立副本（版本号未变也会装新内容） |
| `--command <name>` | 自定义生成的启动命令名 |

安装成功后脚本在 `$XDG_BIN_HOME`（未设置时为 `~/.local/bin`）写入启动命令：`tui` profile 为 `dnt`，其他 profile 为 `dnt-<profile>`，等价于 `dsh --profile <profile>` 且原样透传参数。

直接用 `dsh plugin add` 安装时，插件会在默认 DSH home 下首次启动补建同样的命令。以下情况不自动创建：`DSH_HOME` 不是默认的 `~/.dsh`（测试/探针/自定义 home），或设置了 `DSH_NATIVE_TUI_NO_LAUNCHER=1`。目标文件已存在且不带 `dsh-native-tui launcher` 标记时不会覆盖。

### 启动

~~~sh
dnt                              # 等价于 dsh --profile tui
dsh --profile tui                # 未生成 dnt 时直接启动
dnt --resume <session-id>        # 参数原样透传；退出时会打印这条命令
~~~

用 link: 方式安装时，修改源码后重新 `pnpm build` 即可生效。更新插件后，在 TUI 内执行 `/reload` 会保存当前模型选择、恢复当前 Session 并替换进程。

### 首次配置

1. `/model` 选择模型。列表为空通常是凭据问题，见[排障](#排障)。
2. 需要第三方网关时用 `/provider add`，见[模型与 provider](#模型与-provider)。
3. 需要 ChatGPT Codex 时用 `/codex login`，见[ChatGPT Codex](#chatgpt-codex)。

## 特性

### 会话与 Agent

- 新建 / 恢复 Session，owned root Agent；`/sessions` 只列出本终端创建的 Session（排除 Web Session 与 subagent 子会话）。
- 恢复 Session 时读取持久化的 model/selection 与 `request/header`，恢复模型、reasoning effort 和 preset。
- Agent Presets：`standard` / `ptc` / `minimal` / `cordis`。`/preset` 可在首个 turn 前切换当前 Session；已开始的 Session 锁定，选择用于下一次 `/new`，同时写入 `agent-preset-registry.selectedDefault`。
- Workspace 列表 / 创建 / 切换 / pin / unpin / archive / unarchive；Schedule 列表 / 创建 / 删除。
- 子代理列表（`/agents`）、后台任务列表与终止（`/jobs`）。
- 退出后打印 Session ID 与可直接执行的 `--resume` 命令。

### 模型与凭据

- 模型与 reasoning effort 通过 Host `agentDefaultModel.saveSelection` 持久化，重启或 `/new` 沿用它，不回落默认。
- `/model` 打开可搜索的模型列表，也可直接 `/model provider/model` 切换。
- `/reasoning` 列出或切换思考强度：`/reasoning high`、`/reasoning default`（清除显式 effort）、`/reasoning map`（编辑 level → wire 映射）。
- `/provider` 管理第三方模型路由：添加、查看、刷新模型目录、编辑输入模态、删除。
- `/codex` 登录 ChatGPT Codex 并查询额度。
- `/codebuddy` 登录 CodeBuddy / WorkBuddy（内置插件，见下文）。

### 工具、审批与问答

- 流式文本、Markdown、reasoning、工具卡片、turn 失败提示。
- 工具卡片按来源区分，两条路径共用同一套 diff 渲染，不按预设分支：
  - `ptc` 预设的 `run_code` 内嵌子调用由 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 建卡片。
  - `standard` / `cordis` 等 native 预设直接走 `tool/call` / `tool/result` 顶层卡片；`minimal` 不暴露 `write`/`edit`。
- `write`/`edit` 渲染 ± diff 行，卡片头显示产生它的工具与文件，如 `⚙ edit · src/file.ts`。
- 审批与问答 waterfall。所有独立 overlay（Choice / TextInput / Approval、Markdown / Text Pager、Image）统一使用带边框和全宽背景的 opaque dialog frame，长内容自动换行 / 补齐。
- 问答面板支持单选与多选：Space 勾选、Enter 提交，Other 提供自由文本（多选时会与已勾选项一并返回）；每题都有 `Skip this question` 行（无选项文本题为 `Answer… / Skip this question` 菜单），跳过只返回 `{ id, selected: [] }` 并继续批次；Esc 或请求 signal 中止会以 `UserQuestionError(ASK_ABORTED)` 取消整批。
- 运行中 `Esc` / `Ctrl+C` 取消 turn；输入框有草稿时 `Esc` 先清空草稿，空输入才取消（overlay 聚焦时不触发）。

### 渲染与显示

- Transcript 层次：全宽背景带（用户消息、reasoning、tool 输出）、assistant/context 标签、notice 图标、turn 分隔线；本地命令输出按 durable event sequence 插入。
- 流式内容直接跟随 provider：每帧显示已收到的全部 text/reasoning，`block-end` 与 `assistant/message` 立即采用完整内容，没有额外逐字动画、播放队列或 settle grace。reasoning、正文、工具卡片按 provider/event 顺序展示，可以落在同一帧。
- 执行状态独立于内容渲染：turn 开始后显示 `⟳ working · Ns`；收到文本、reasoning、工具调用或 stream/end 都不清除它，直到 `turn/end` 或切换会话。Host 调度自动重试时显示 `⟳ retry N/M after CODE (automatic) · Ns`，新 attempt 或恢复收流后回到 working。断流检测、超时与重试策略归 Host/provider，TUI 不根据画面是否变化判断网络状态。
- 显示密度可配置：`thinkingDisplay` 与 `runCodeDisplay` 均为 `hidden | compact | detailed`，见[配置](#配置)。
- PTC 的 `run_code` 卡片在 `compact` 下列出程序实际派发的子调用：`read src/a.ts`、`bash <description>`、MCP 工具显示服务名 `mcp idea`；同一行只出现一次，超过 10 行折叠为 `├ … N more`，失败时额外显示一行 `├ ✕ <错误首行>`。
- 上下文压缩：默认 preset 启用 `compaction-basic` 与 tool-result pruner。TUI 渲染 compaction start/summary/end；prune 隐藏对应 tool 卡片并保留 prune notice；session 级 tool memory 会忽略同一 callId 的晚到 / 重复 call/result，即使原始事件已离开 retained window。进程在 compaction 中途崩溃后 resume，卡片尾行显示 `⚠ interrupted` 而不是一直停在 `⟳ compacting…`。`/compact` 作为 Host command 可手动触发。
- 终端窗口标题：启动后写入 `<产品标题> · <workspace 目录名>`（OSC 0），标签页能直接看出是哪个 checkout 的会话，例如 `DeepSeek Harness · dsh-native-tui`。控制字符会被压平（BEL 会截断 OSC 序列），目录名超过 48 字符截断；只在标题变化时写入。
- 宽松排版：header 三行（产品标题、Session id、cwd）；transcript 只保留上下留白；状态区独立成块（`● idle   model provider/model   think max` + 空行 + preset/快捷键）；transcript / 状态区 / 输入框 / 分隔线 / 编辑框边框共用同一满宽列，无左右留白，宽度随终端 resize 自适应。
- reasoning effort 同时决定 `think` 标签、状态栏分隔线和编辑器上下边框的颜色（low 暗绿 / medium 浅蓝 / high 粉红 / max 红；未设置或未知 effort 保持 dim，`plain` 主题不着色）。provider 蓝、model 青、preset 紫、attached 数量青。
- footer 两行：`↳ turns · steps · tok/s · tok · cache` 与 `ctx ...`。`ctx` 读 token meter 的 `contextPressure` 投影（最近一次 provider 采样 + 此后 surface 增减，compaction 影响已含在内），渲染为 `ctx 42%  (~420K / 1M · compact at 80%)`；`compact at` 是按 `compaction-basic` 的 `thresholdRatio`、`headroomTokens` 与该请求预留输出复算的触发点。首次 provider 采样前显示 `ctx —`，不猜占用。
- token 用量与 cache 命中率按 Web 口径：总量取四桶之和、部分命中不会显示成 100%，数字格式与 Web 统计 pill 一致。`tok/s` 是整段 Session 的累计 decode 速率（`decodeTokens / (decodeMs / 1000)`），不是瞬时速率，低于 10 时保留一位小数。
- 可选 `fullscreen`：TuiAltScreen + ScrollView，header/status/editor 固定，鼠标滚轮滚动、文本选择复制。向上滚动离开末尾后，视口末行显示可点击的 `↓ jump to latest`，点击回到最新消息并恢复自动跟随（也可 `Ctrl+End`）。
- 长会话渲染优化：每个行组件按宽度缓存结果（`MemoBlock`），`maxTranscriptEntries` 默认 600 限制每帧保留的行组件数；帧间隔按上次绘制时刻对齐并按实测帧成本自适应，内容签名未变的帧跳过重绘。
- 卡片首行（`⚙ name`、`◆ assistant`、`◆ compaction`）在卡片创建后不再变化。main-screen 只能 patch 可见行，改写已滚入 scrollback 的首行会让 pi-tui 清屏并重写整份 transcript，因此运行状态一律放在卡片尾行或底部状态行。

### 输入与补全

- `/help`、`/init`（生成 `AGENTS.md` 贡献指南，已存在不覆盖）。
- slash 命令支持子命令补全，例如 `/provider` 显示 add/list/edit/models/input/remove。子命令已完整输入时回车直接执行；从补全中选中时，如果当前过滤结果只包含无参数子命令则直接执行，混有带参数子命令时保持插入。
- `@file` 主机端补全（`file-reference-local`）：每行是「文件名 + 类型 · 完整路径」，与 pi agent 的文件补全一致。长路径只截断第一列的文件名，不会让所有行停在同一个公共目录前缀上。选中的路径作为普通 prompt 文本，模型需用 `read` 工具读取。
- `/ <query>` 的本地/宿主命令+技能补全：命令之后列出 Host `ctx.skills` 的用户可调用技能（仅用户可调用的标注 `user-only`）。选中插入 `/skill-name`，回车按普通 prompt 发送，由 `dsh-tool-skill` 读取 `/name` 手势并注入技能正文。
- `@@<query>` 引用其他 Session；发送时 Host session-reference 自动注入快照。

### 文件、导出与预览

- `/export` 导出 Session JSONL；`/export zip` 导出含 manifest、attachments、deliverables 的 ZIP bundle；`/export html` 导出静态 HTML transcript。三种导出都以 `wx` 写入，不覆盖已有文件。
- `/open` 预览文本（16 KiB 上限），Markdown 以 pi-tui Markdown 样式分页渲染。
- `/preview` 渲染 PNG/JPEG/GIF/WebP；终端不支持时显示文本占位。
- `/files` 浏览目录并预览文件（Enter 进入目录 / 预览，Esc 退出，含 `../`）。
- `/attach` 暂存文件 / 图片 / 剪贴板图片并随下一条 prompt 发送（8 MiB 上限），`/attach preview <i>` 可内联预览，`/attachments` 打开暂存附件管理器。
- `/deliverables` 列出、打开 panel、预览或用系统文件管理器定位 `present` 交付文件。
- `/changes` 查看最近一轮 workspace 变更文件与单文件 diff。
- `/tools` / `/tool <index>` 列出工具调用或分页查看完整参数与结果；`/diff [index]` 查看 write/edit 的独立 diff。

### 扩展与集成

- 默认集成官方 `@deepseek-ai/dsh-computer-use`、`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`、`@deepseek-ai/dsh-mcp-client` 与 `mcp-resources`。
- MCP 服务配置持久化到 `mcp-manager.servers`，变更实时 reconcile，无需重启，见[MCP 服务](#mcp-服务)。
- `/plugins` 列表 / 官方市场 / 检查 / 安装 / 移除 / 启停（带确认，实时应用）。
- `/settings` 引导式 TUI 配置页与 Host 命名空间内嵌编辑器，见[配置](#配置)。

### 终端卫生

- Host / 插件日志不会覆盖画面：TUI 占用终端期间接管 `console`（与 `warnings.ts` 接管 `process.emitWarning` 同一思路），`warn`/`error` 转成 transcript notice，`log`/`info`/`debug`/`trace` 只进 `DSH_NATIVE_TUI_DEBUG=1` 的 stderr 追踪，退出时恢复原方法。
- 非 TTY 显式失败；Ctrl+C / Ctrl+D / SIGTERM / SIGHUP 安全退出，退出后恢复终端。

## 命令

`Enter` 发送；运行中 `Enter` 作为 steer；`Ctrl+C` 取消/退出；`Ctrl+D` 退出。

### 会话与界面

| 命令 | 作用 |
|---|---|
| `/help` | 本地命令、宿主命令、按键提示 |
| `/new` | 创建新 Session 并切换 |
| `/init` | 在当前项目生成 `AGENTS.md` 贡献指南（已存在则不覆盖） |
| `/sessions` | 列出本终端创建的 Session |
| `/resume <id>` | 恢复指定 Session |
| `/status` | Session、cwd、模型、状态、事件数 |
| `/clear` | 仅清空终端视图 |
| `/cancel` | 取消当前 turn |
| `/preset [id]` | 切换当前或下一次 `/new` 的 preset，并保存默认 preset |
| `/reload` | 重新加载 TUI 与插件并恢复当前 Session |
| `/exit`, `/quit` | 退出并恢复终端；也可直接输入裸 `exit` / `quit` |

### 模型与推理

| 命令 | 作用 |
|---|---|
| `/model [provider/model]` | 打开可搜索的模型列表或直接切换；选择同时保存为默认模型 |
| `/reasoning [effort\|default\|map]` | 列出或切换思考强度并保存；`default` 清除显式 effort；`map` 引导编辑 level → wire 映射 |
| `/provider [add\|list\|edit [route]\|models <route>\|input [provider/model]\|remove <route>]` | 配置或查看 provider；刷新模型目录；编辑输入模态；删除 route |
| `/codex [status\|setup\|login [browser\|device]\|logout\|models\|help]` | ChatGPT Codex 登录、路由与额度 |
| `/codebuddy [status\|login [cn\|en\|all]\|logout [cn\|en\|all]\|models [refresh]\|quota\|checkin\|prompt [show\|reset]\|doctor]` | CodeBuddy / WorkBuddy 账号与模型 |
| `/permissions [preset]` | 列出或切换权限预设 |

### 环境与扩展

| 命令 | 作用 |
|---|---|
| `/mcp [add\|list\|remove <name>]` | 配置、查看或删除 MCP 服务 |
| `/plugins [list\|market [query]\|inspect <spec>\|install <spec>\|remove <bundle>\|enable <entryId>\|disable <entryId>]` | 列出、浏览官方市场、检查/安装/移除 bundle，或启停插件项 |
| `/workspaces [new <path>\|use <id\|path>\|pin\|unpin\|archive\|unarchive]` | 列出/创建/切换/固定/归档 workspace 会话 |
| `/schedule [add <seconds> <title>\|delete <id>]` | 列出/创建/删除一次性提醒 |
| `/jobs [kill <id>]` | 列出或终止后台任务 |
| `/agents` | 列出直接子代理 |
| `/settings [tui\|host\|edit [ns]\|items <ns> <field>\|set <ns> <json>]` | 引导式 TUI 配置页、Host 命名空间编辑器，或脚本化写入 |

### 文件与导出

| 命令 | 作用 |
|---|---|
| `/export [path\|zip [path]\|html [path]]` | 导出 JSONL、ZIP bundle 或静态 HTML transcript |
| `/open <path>` | 预览文本（16 KiB 上限） |
| `/files [path]` | 目录浏览与预览 |
| `/preview <image>` | 用 pi-tui Image 渲染图片 |
| `/changes [diff <index>]` | 查看最近一轮 workspace 变更 |
| `/deliverables [panel\|open\|reveal <index>]` | 列出、打开或定位 present 交付文件 |
| `/tools` · `/tool <index>` | 列出工具调用，或分页查看完整参数与结果 |
| `/diff [index]` | 分页查看 write/edit diff |
| `/attach <path>\|paste\|preview <i>\|list\|clear` | 暂存或预览附件，随下一条 prompt 发送 |
| `/attachments` | 暂存附件管理器：预览或移除 |

## 配置

~~~yaml
- id: native-tui
  name: dsh-native-tui
  config:
    sessionId: native-tui-fixed   # 可选：恢复固定 Session
    cwd: /path/to/workspace
    showReasoning: true           # legacy boolean；false 等价于 thinkingDisplay: hidden
    thinkingDisplay: detailed     # hidden | compact | detailed
    runCodeDisplay: detailed      # run_code/bash/pwsh 卡片：hidden | compact | detailed
    maxTranscriptEntries: 600     # 每帧重绘的行预算；越大流式帧越慢
    fullscreen: false             # true 使用 alt-screen + 鼠标/应用滚动
    theme: auto                   # auto | dark | light | plain
    agentPreset: ptc              # ptc | standard | minimal | cordis
    title: DeepSeek Harness
~~~

| 字段 | 生效时机 |
|---|---|
| `thinkingDisplay` / `runCodeDisplay` / `showReasoning` / `maxTranscriptEntries` / `title` | 立即 |
| `theme` / `fullscreen` | 重启后 |
| `cwd` / `sessionId` / `agentPreset` | 下次启动 |

以上字段全部注册为 native-tui 的 live settings（volatile），`/settings` 引导页写入 profile patch；schema 里的 description 同时用于 TUI 与 Host 设置页的字段说明。

### 显示模式

- `hidden`：不渲染 reasoning / `run_code` / `bash` / `pwsh` 块。
- `compact`：reasoning 只显示首行摘要；代码执行工具只显示状态 + description/command/code 单行摘要。
  - PTC 的 `run_code` 改为列出程序实际派发的子调用（`read src/a.ts`、`bash <description>`、MCP 显示服务名 `mcp idea`），文件编辑子调用仍走各自的 diff 卡片。
  - 路径过长时保留尾部：文件名才是区分不同文件的部分，从左侧截断会让同目录下的两个文件渲染成同一行而被去重。说明 / 命令等其他参数保留开头。
  - 失败时额外显示 `├ ✕ <错误首行>`，否则失败卡片只有 `error` 而没有原因。
- `detailed`：完整 reasoning 区带与代码执行工具 args/result 卡片。

### /settings

`/settings`（或 `/settings tui`）打开引导式 TUI 配置页，覆盖全部 native-tui 字段：thinking / code execution 显示模式、Show reasoning（legacy）、transcript entries、theme、fullscreen、header title、cwd、resume session、agent preset。

- 每行显示当前有效值、字段说明与生效时机；编辑先暂存。
- `Save and apply` 以一次 path-addressed mutation 写入（revision 冲突自动按新 revision 重试一次），然后关闭页面并输出保存回执；`Discard changes` 丢弃暂存。
- 保存回执按生效时机（立即 / 重启 / 下次启动）分组说明。

`/settings host` 或 `/settings edit [ns]` 打开 Host 命名空间内嵌编辑器：按 schema 列出可编辑路径（支持嵌套对象、动态 record、数组 item、JSON 值），可搜索、类型化编辑、append/remove 数组项、reset 到继承值。secret 字段只显示不可编辑，含 secret 的对象不允许整体 JSON 覆盖；每次写入使用路径操作，避免重述并删除被 redact 的 secret。`/settings items` 是数组项管理的兼容入口，`/settings set` 保留 JSON merge 写入。

默认模型来自 Host 的 `ctx.agentDefaultModel`（Base 默认 `deepseek-official/deepseek-flash`）。没有凭据时首个请求显示 `MISSING_CREDENTIAL`。

## 模型与 provider

### 添加 route

`/provider add` 是引导流程：

1. 选择 Custom OpenAI-compatible / OpenAI Responses / Anthropic-compatible gateway，或 Built-in pi-ai catalog route。内置目录来自 Host `listConfigurableProviders`，与 Web 端 Models 页一致（`amazon-bedrock`、`anthropic`、`deepseek`…），目录不可用时才回退手输 catalog id。
2. 选择 Credential source：
   - **Use built-in environment auth**（provider 声明原生认证时出现，默认项）：写入不带 `apiKeyEnv` 的 profile，沿用 provider 自己的环境变量，例如 `amazon-bedrock` → `AWS_BEARER_TOKEN_BEDROCK`。
   - **Store API key in DSH credentials（推荐）**：直接粘贴 key，存入 DSH credential store（`~/.dsh/.credentials.yaml`，权限 0600），不写入 profile，无需 export。输入时 key 在终端可见。
   - **Use an environment variable**：输入 UPPERCASE 变量名，启动 dsh 前在 shell export。catalog route 的默认值是 provider 原生 env，无原生认证时回退 `<ROUTE>_API_KEY`。
3. custom gateway 会调用 Host `discoverModels` 请求 `GET {baseURL}/models`（5 秒超时）；catalog route 直接使用 provider 内置模型列表。
4. 从内置 / 自动发现的模型中选择，或回退手动输入 model id / context window / max tokens。发现列表中的其他模型也会写入该 route，之后可在 `/model` 直接切换。
   - 其他模型的 `input` 随 discovery 一起保存：catalog 或 endpoint 声明了输入类型就写声明值；未声明（自定义网关的 `/models` 通常只返回容量）则显式保存为 `[text]`，不留空继承 route 的 `defaultInput`。
   - 选中的模型会再询问 **Input modalities**：discovery 声明 image 时默认 `Text + image`，否则默认 `Text only`。这一步必要，因为已有网关（如 command-code）的 listing 完全不提供模态信息，但模型实际能读图。
5. 输入 Reasoning levels（逗号分隔，默认 `low,medium,high`；留空表示不支持 reasoning）。生成的配置写入 `reasoningEfforts`，之后可用 `/reasoning` 切换或 `/reasoning map` 修改映射。

`apiKeyEnv` 保存的是 credential reference（环境变量名或 DSH credential 名称），不是 key 明文。env 模式下若变量未设置会拒绝保存；store 模式直接写 credential store。

已有旧 provider 不会被自动改写。重新 `/provider add` 同一 route 时，选择 **Add/replace this model, keep other models** 会重新导入并保留已有模型。也可以手动补：

~~~yaml
input:
  - text
  - image
reasoningEfforts:
  low: low
  medium: medium
  high: high
~~~

route 级的 `defaultInput: [text, image]` 会让该 route 下未声明 `input` 的模型继承；已显式保存 `input` 的模型优先用自己的声明。

**不要在 env 模式把 key 填进变量名。** 流程要求 UPPERCASE 环境变量名并拒绝形似 key 的输入。若旧配置已把 key 写入 `apiKeyEnv`，立即 `/provider remove <route>`、检查 `cordis.patch.yml` 并轮换该 key。

### 刷新模型目录

~~~text
/provider
/provider edit command-code
/provider models command-code
~~~

`/provider` 打开 provider 选择；`edit` 进入配置菜单（Fetch available models / Edit model input types）；`models` 直接获取。查询使用已保存的 baseURL / API 协议 / credential，把 endpoint 返回的模型合并进 route：新模型追加，已有模型更新容量。

`input` 与模型列表一起保存：discovery 声明了输入类型就写入新模型；已有模型显式声明的 `input` 保留，`input` 缺失或为空时用 discovery 声明回填，discovery 也未声明则保存为 `[text]`。`reasoningEfforts` 保持原样；新增模型若未声明会自动写入默认同名映射 `low/medium/high`，使其在 `/reasoning` 中可直接切换；已有模型（包括留空表示不支持 reasoning 的）不会被回填。

### 编辑模型的输入模态

~~~text
/provider input                                             # 当前模型
/provider input command-code/deepseek/deepseek-v4.1-flash   # 指定模型
/provider edit command-code                                 # 菜单里选 Edit model input types
~~~

向导显示当前声明，可选 `Text only`、`Text + image`，或 `Inherit route default` 删除显式 `input` 让 route 的 `defaultInput` / catalog 生效。这是**手动能力声明**，不会探测模型：只有模型或网关确实接受图片时才选 `Text + image`，否则请求会失败。

写入位置与 `/reasoning map` 一致：显式 `models` 条目写 `models[].input`；catalog route 写 `modelOverrides.<model>.input`；`models` 来自其他配置层时会先确认再整体重写该数组。

### reasoning 映射

`/reasoning map`（或 effort 菜单里的 **Edit reasoning map…**）对当前 `provider/model` 提供：

- **Add or update a level**：从 `off/minimal/low/medium/high/xhigh/max` 选择 level，再输入该网关实际接收的 wire spelling；`off` 留空表示不下发字段（`null`）。
- **Remove a level**：移除一个 level，至少保留一个非 `off` level。
- **Use same-name defaults**：重置为 `low/medium/high` 同名映射。

修改先暂存在内存，**Save and apply** 才写入 `llm-pi-ai` 设置；Esc / Cancel 不落盘。

写入位置取决于 route：显式 `models` 列表中的模型更新该条目的 `reasoningEfforts`；catalog route 没有显式 `models` 时写入 `modelOverrides.<model>.reasoningEfforts`，不复制整个模型目录。若模型还没有存储映射，向导会从 catalog 报告的 level 生成同名暂存映射并视为待保存修改，提示核对 wire spelling 后再保存。若 `models` 数组来自其他配置层，保存前会确认把合并后的完整数组写入 profile patch，避免静默遮蔽 base 层配置。保存后当前显式 effort 若已不存在，会自动回到 provider default。

该向导只编辑由 `llm-pi-ai` 提供的模型；CodeBuddy 等适配器自己管理 level，不能用它修改。

### 查看与删除

`/provider list` 显示已配置 route、可见模型数与 credential 状态（`(stored)` / `(not set)`）；`/provider remove <route>` 删除 route。若 `/model` 仍为空，确认 credential 可用：llm-pi-ai 在凭据缺失时会故意返回空模型列表。

env 模式示例：

~~~sh
export MY_GATEWAY_API_KEY=...
dsh --profile tui
~~~

## ChatGPT Codex

`/codex` 复用 Host 的 `authorization` / `credentials` seam 与 pi-ai 的 OAuth flow，不依赖 `dsh-llm-chatgpt`：

| 命令 | 作用 |
|---|---|
| `/codex status` | 登录状态、凭据到期、路由、模型数量，并查询 5 小时与周额度 |
| `/codex setup` | 只确保 `llm-pi-ai.providers.openai-codex` 路由存在，不触发登录 |
| `/codex login [browser\|device]` | 走 OAuth；成功后自动补建路由 |
| `/codex logout` | 确认后取消进行中的登录、删除凭据并回读确认 |
| `/codex models` | 列出 `openai-codex` 可用模型 |

- 路由的 `models: []` 表示使用 pi-ai 原生目录，不覆盖模型列表。
- 凭据由 pi-ai 经 DSH 凭据 seam 写入共享的 `~/.dsh/.credentials.yaml`，key 为 `llm-pi-ai/openai-codex`，**跨 profile 共享**：登出会影响其他 profile。
- 若路由配置了 `apiKeyEnv`，OAuth 会静默失效；`setup` 会检测并拒绝这种冲突。
- 登录方式：`browser` 监听 `localhost:1455` 接回调；端口被 Codex CLI 占用时回退为粘贴回调 URL，也可手动粘贴授权码。`device` 走 device code（有效期 15 分钟）。
- 额度来自 `GET https://chatgpt.com/backend-api/wham/usage`，按窗口时长识别（5 小时 = 18000 秒，周 = 604800 秒），不依赖 primary/secondary 顺序。

## CodeBuddy / WorkBuddy

内置 `codebuddy` 插件（bundle 行 `dsh-native-tui/codebuddy`）把两个部署注册为 DSH LLM 路由：

- `codebuddy` — CodeBuddy 国内版（copilot.tencent.com）
- `codebuddy-en` — WorkBuddy 国际版（www.workbuddy.ai）

两者不依赖 Web 端 router 插件，也不需要本地代理：浏览器 OAuth 登录，凭据走 DSH authorization / credential seam，续期在 credential record 的互斥写内完成。

~~~text
/codebuddy status                    # 登录态、token 轮换时间、模型目录与最近错误
/codebuddy login [cn|en|all]         # 打开浏览器授权并轮询（最多 5 分钟）
/codebuddy logout [cn|en|all]
/codebuddy models [cn|en]            # 列出模型及其声明的输入模态与来源
/codebuddy models refresh            # 拉取 GET /v3/config 目录
/codebuddy quota [cn|en]             # 剩余额度（只读，显式执行）
/codebuddy checkin [cn|en]           # 显式签到（调用厂商自有端点，请自行确认条款）
/codebuddy prompt [show|reset]       # 引导式配置系统提示词 / 打印 / 恢复默认
/codebuddy doctor                    # 端点、请求形态与目录连通性探测，不含凭据
~~~

登录前 `/model` 已能看到两条路由与 seed 模型（CN 8 个 / EN 6 个，未经真实账号验证）；登录后 `models refresh` 会用账号目录替换。

### 系统提示词与指纹校验

国内网关会做客户端指纹校验：系统提示若以第三方 agent 身份句（`You are an AI agent powered by …`）开头，会返回 HTTP 400 `code 11128`（`Illegal API invocation from an unapproved channel`）。`codebuddy` 路由在发送前把这类身份句改写为中性表述——无论提示放在 `system` 字段还是 in-history 的 system 消息里（TUI 走后者）——其余提示（工具说明、工作区规则、用户指令）逐字保留。国际版不做该校验。

需要整体调整发往 CodeBuddy 的系统提示时，用 `/codebuddy prompt`：

- **Add / Edit the custom template** 打开多行编辑器（Enter 保存，Shift+Enter 或 Ctrl+J 换行）。模板含 `{prompt}` 时，harness 当次组装的系统提示会在该位置展开，只展开一次；不含占位符则整段替换。
- **Use the default prompt** 删除自定义模板，回到身份句改写。
- 编辑器提交空内容等同恢复默认；不含 `{prompt}` 的模板保存前会二次确认。

写入的是 profile patch 的 `codebuddy.systemPrompt`（volatile 字段），下一条请求即生效，无需重启：

~~~yaml
- id: codebuddy
  name: dsh-native-tui/codebuddy
  config:
    systemPrompt: |
      You are CodeBuddy, a coding assistant.
      {prompt}
~~~

整段替换会同时丢掉工具说明与工作区规则，通常保留 `{prompt}`、只改写开头更稳妥。配置对两条路由同时生效，CN 的身份句改写仍作用在最终文本上；其他 provider 的请求不经过本插件的 wire 层。

### 输入模态与图片

输入模态按模型取自网关目录的 `supportsImages` / `disabledMultimodal`：

- `supportsImages: true` → 声明 `text` + `image`，图片以 OpenAI `image_url`（base64 data URI）随 user 消息或 tool 结果发出，两个角色均已实测可读图。
- `supportsImages: false` 或缺失 → 保持 text-only；Host 会把图片块投影为占位文本，不会把无法识别的图发给上游。
- `disabledMultimodal: true` 优先于 `supportsImages`。
- 登录前（seed 列表）与手填未命中目录的模型 id 一律 text-only。
- 未挂载 attachment 服务时全部声明 text-only。

`supportsImages: false` 不等于不能看图（实测 `default`、`glm-5.0` 声明 false 但仍能读图）。这类模型用插件配置按模型覆盖：

~~~yaml
- id: codebuddy
  name: dsh-native-tui/codebuddy
  config:
    models:
      default:
        input: [text, image]
~~~

`/codebuddy models` 会打印每个模型实际声明的模态与来源（`catalogue` / `override` / `seed`）。当某个声明要求图片、但当前组合拿不到图片字节时，该行会追加 `(... asks for images; no attachment service mounted, so text only)`，因此能区分「覆盖生效」与「覆盖被降级」。

图片请求按 2048² 像素 / 1 MiB 预算投影（与 `llm-pi-ai` 默认值一致）；读图失败降级为占位文本并写诊断，不让整轮失败。同一附件在一个请求里只读取一次，多张图并发读取；已标记 `offloaded` 的图片直接发占位文本。

整段会话的内联图片总量超过 20 MiB 时，请求以 `IMAGE_OFFLOAD_REQUIRED` 失败并携带需要卸载的数量，由 base bundle 的 `compaction-image-offload` 把最旧的图片换成占位文本后重试。

### 已知限制

- OAuth、模型授权、真实思考档位与额度字段仍为协议转写（来源 `CARVIN94/dsh-router-codebuddy`，MIT），未用真实账号验收；模态字段与图片收发已用真实账号实测。
- 图片计费（visual tokens）未接入 token meter，用量面板会低估图片请求成本。
- 图片只允许出现在 user 消息与 tool 结果；system/assistant 携带图片会以 `UNSUPPORTED_CONTENT` 拒绝，developer 消息整条丢弃。
- `/attach` 给 text-only 模型贴图会提示，但终端不拦截：prompt 直接进 agent，不经过 session-controller 的图片准入检查。
- 上游请求不带 `stream_options`，不返回 `usage`；此时不显示 token 用量，也不伪造 0。
- 路由名 `codebuddy` / `codebuddy-en` 由本插件独占。若此前在 `llm-pi-ai` 设置里手工配置过同名 route，请先 `/provider remove codebuddy`（及 `codebuddy-en`），否则 llm-pi-ai 注册同名路由会失败并输出诊断。
- 登录入口只在终端内（`/codebuddy login`），Web Models 页不提供这两个 provider 的 OAuth。

## MCP 服务

默认 bundle 集成官方 `mcp-client` 与 `mcp-resources`。TUI 通过 `mcp-manager` 管理服务配置：

~~~text
/mcp list
/mcp add
/mcp remove <name>
~~~

`/mcp add` 支持：

- `stdio`：command、args（空格分隔或 JSON 数组）、env JSON；args/env 留空表示无参数、无额外环境变量。
- `streamable-http`：URL、headers JSON。

配置写入 profile 的 `mcp-manager.servers`。mcp-manager 把每个条目映射为官方 `mcp-client` Loader row，并在 Loader fiber 激活后记录状态；settings 变更会实时 reconcile 这组 row，因此新增、修改、删除服务都无需重启 TUI。

`/mcp list` 每行显示 `connected` / `starting` / `error: ...` / `disconnected: ...` / `not loaded`。mcp-manager 使用 `failOnStartupError` 并 await fiber，初始连接失败会显示错误而不是静默成功。运行中 mcp-client 会自行重连：重连期间其工具保持注册，状态仍为 `connected`；一旦重连耗尽或禁用重连，mcp-client 注销该服务的工具，mcp-manager 通过 `tools/change` 观测到后标记 `disconnected`。

新增或修改配置后 mcp-manager 立即装载（`/mcp list` 会短暂显示 `not loaded` / `starting`），无需重启。MCP tools 以 `mcp__<serverName>__<toolName>` 暴露。

## 开发与验证

### 门禁

~~~sh
pnpm check      # typecheck + 单元测试 + build
pnpm test
pnpm test:watch
pnpm build      # tsc -p tsconfig.build.json → dist/（gitignored）
~~~

当前状态：64 个测试文件 / 729 个用例。代码风格见仓库根目录 `AGENTS.md`：TypeScript ESM（NodeNext），两空格缩进、单引号、无分号，单个源文件不超过 1000 行。

### 真实 Host 探针

开发环境无法创建 PTY，因此用 fake TTY 包装器跑真实 Host。`scripts/` 下约有 100 个 `fake-tty-*.mjs` 探针，每个验证一类用户可见行为；它们都会打印 `EXIT ... pass true/false` 与抓取到的终端输出。

多数探针需要 disposable `DSH_HOME`，首次要先把当前构建装进该 home：

~~~sh
pnpm build
pnpm pack --pack-destination .tmp
DSH_HOME=/tmp/dsh-native-tui-approval-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
DSH_HOME=/tmp/dsh-native-tui-approval-home node scripts/fake-tty-approval.mjs
~~~

部分探针自建临时 profile 与 mock provider，直接跑即可：

~~~sh
node scripts/fake-tty-ptc-compact.mjs        # PTC compact 调用列表（含 PTC_COMPACT_FAIL=1 失败分支）
node scripts/fake-tty-presets-compact.mjs    # standard / minimal 不受 PTC 改动影响
node scripts/fake-tty-thinking-tool.mjs      # reasoning 占位符与工具调用的先后
node scripts/fake-tty-window-title.mjs       # 终端窗口标题（OSC 0）
node scripts/fake-tty-stream-smooth.mjs      # 流式大 chunk
node scripts/fake-tty-main-screen-scroll.mjs # main-screen 长 transcript
node scripts/fake-tty-model-picker.mjs       # /model 选择器与冷/热路径耗时（需网络：查 CodeBuddy 目录）
~~~

普通终端环境可运行真实 PTY 冒烟：

~~~sh
python3 scripts/pty-smoke.py
~~~

### 工作流

- 修改后按改动范围跑对应探针，再跑 `pnpm check`。
- 新增用户可见行为时优先补探针；纯逻辑补 `tests/<module>.spec.ts`。
- 提交使用 Conventional Commits 加中文 subject；不要提交 `dist/`、`*.tgz` 或生成的 profile 文件。

## 排障

| 现象 | 处理 |
|---|---|
| 首个请求报 `MISSING_CREDENTIAL` | 没有可用凭据：`/provider add` 配置 key，或 export 对应环境变量 |
| `/model` 列表为空 | llm-pi-ai 在凭据缺失时会故意返回空列表，先确认 credential 状态（`/provider list`） |
| `/codex login` 后模型不可见 | 跑 `/codex status` 看路由与凭据；必要时 `/codex setup` 补路由 |
| CodeBuddy 报 `code 11128` | 客户端指纹校验未通过，见[系统提示词与指纹校验](#系统提示词与指纹校验) |
| CodeBuddy 路由注册失败 | `llm-pi-ai` 里存在同名 route，先 `/provider remove codebuddy` |
| 终端出现 `(node warning)` | 正常：warning 被暂存，退出后才输出，避免覆盖画面 |
| 画面被日志覆盖 | 已由 `console` 接管机制处理；仍有输出时用 `DSH_NATIVE_TUI_DEBUG=1` 定位来源 |
| `dnt` 命令不存在 | 用 `dsh --profile tui` 启动；或检查 `DSH_HOME` 是否为默认值、`DSH_NATIVE_TUI_NO_LAUNCHER` 是否被设置 |
| 终端标题没变化 | 部分终端默认忽略 OSC 0；需在终端设置里允许应用修改标签页标题 |

## 已知差距

- Plugin Manager 官方目录之外的市场搜索未实现（官方目录浏览已实现）。
- PDF / Office 富文档预览未实现（Markdown 已支持）。
- 会话级附件管理器未实现（当前覆盖 staged 附件）。
- 远端连接未实现。
- MCP 状态覆盖初始激活与运行中的工具注销，但 `dsh-mcp-client` 未暴露「重连进行中」的中间态。
- 自动压缩已接入 preset 并有事件卡，真实长上下文 E2E 仍需补。

详见[架构文档](docs/design-task-feature-dsh-native-tui-host-native.md)第 6 节。

## 兼容性

- 已在全局 dsh 0.2.1-rc.2 上安装并启动；生产与开发依赖统一为 0.2.1-rc.2。
- Preset patch 从 `@deepseek-ai/dsh-web-app` 的 standard/ptc/minimal/cordis 复制而来：standard/ptc/minimal 需要 `subagent-model-selection-settings` Host 行，cordis 需要 cordis host-runner 与 `tool-cordis/host`。
- `@file` 补全依赖 `@deepseek-ai/dsh-file-reference-local`。
- pi-tui 1.4.0；Node `^22.19.0 || >=24.0.0`。

## License

[MIT](LICENSE)。package 仍为 private。
