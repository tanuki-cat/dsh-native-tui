# dsh-native-tui

DeepSeek Harness 的 host-native 终端前端，基于 pi-tui。

> 状态：实施完成（30 轮 + 第三方模型引导 + 官方 MCP/computer-use 集成，117 个单元测试通过）；已知差距见进度记录。
> 目标：在 TUI 中提供 Web 模式的核心能力，而不是复制浏览器图形界面。
> 架构说明与差距清单：[Host-native 方案](docs/design-task-feature-dsh-native-tui-host-native.md)。
> 实施进度、验证证据与未验收项：[实施进度](docs/progress-dsh-native-tui.md)。

## 特性

- 新建/恢复 Session，owned root Agent。
- 流式文本、Markdown、reasoning（含网关只在完成时回传的完整块）、工具卡片（write/edit 结果渲染 ± diff 行，含 `run_code` 内嵌子调用与 native 直接调用）、turn 失败提示。
- 本地命令与宿主命令执行（compact/feedback/goal/permission/plan）；slash 命令支持子命令补全，例如 `/provider` 显示 add/list/edit/models/input/remove，`/reasoning` 后输入空格显示 map；子命令已完整输入时回车直接执行；从补全中选中时，如果当前过滤结果只包含无参数子命令则直接执行；混有带参数子命令时保持插入，继续输入参数。
- 审批与问答 waterfall；所有独立 overlay（Choice/TextInput/Approval、Markdown/Text Pager、Image）统一使用带边框和全宽背景的 opaque dialog frame，长内容自动换行/补齐。问答面板支持单选与多选：多选用 Space 勾选、Enter 提交，Other 提供自由文本（多选时会与已勾选项一并返回）；每题统一提供 `Skip this question` 行（无选项文本题为 `Answer… / Skip this question` 菜单），跳过只返回 `{ id, selected: [] }` 并继续批次；Esc 或请求 signal 中止则以 `UserQuestionError(ASK_ABORTED)` 取消整个批次。
- 模型选择器（LLM catalog 为空时明确提示）、reasoning effort 切换与映射编辑、权限预设、后台任务、子代理列表。
- 模型与 reasoning effort 通过 Host `agentDefaultModel.saveSelection` 持久化；重启或 `/new` 沿用，不再回落默认。
- 第三方模型：`/provider add` 引导配置 pi-ai gateway/catalog route，`/provider list|edit|models|input|remove` 管理；`/provider input` 可手动编辑当前或指定模型的输入类型（text / text + image）。
- 默认集成官方 `@deepseek-ai/dsh-computer-use`、`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`、`@deepseek-ai/dsh-mcp-client`（以及 mcp-resources）。
- `/mcp add|list|remove` 配置 stdio / Streamable HTTP MCP 服务；配置持久化到 `mcp-manager.servers`。
- Agent Presets：standard / ptc / minimal / cordis；/preset 可在首个 turn 前切换当前 Session，已开始的 Session 锁定并用于下一次 /new；选择同时写入 `agent-preset-registry.selectedDefault`，重启后继续使用。
- Workspace 列表/创建/切换/pin/unpin/archive/unarchive；Schedule 列表/创建/删除；Settings 引导式 TUI 配置页（全部 native-tui 字段：显示模式、transcript、theme/fullscreen、title、cwd、sessionId、agentPreset，带即时/重启/下次启动标注与暂存 diff）与 Host 命名空间内嵌编辑器（搜索、类型化编辑、数组增删/JSON、secret 保护、revision 冲突重试）；Plugins 列表/官方市场/检查/安装/移除/启停（带确认，实时应用）。
- 可选 `fullscreen`：TuiAltScreen + ScrollView，header/status/editor 固定，鼠标滚轮滚动、文本选择复制。
- Transcript 层次：全宽背景带（用户消息、reasoning、tool 输出）、assistant/context 标签、notice 图标、turn 分隔线；本地命令输出按 durable event sequence 插入。每个行组件按宽度缓存渲染结果（`MemoBlock`），避免重复遍历和格式化不变的历史。`maxTranscriptEntries` 默认 600，限制每帧保留的 transcript 行组件数量。
- 流式节拍：帧间隔按**上次绘制时刻**对齐（`nextFrameDelay`），chunk 突发不会把帧间隔拉成 33/66 ms 交替；内容签名（修订号 + 等待行文本）未变的帧直接跳过重绘。帧成本按「rebuild + 本帧迟到量」实测（`frameOverrunMs`），间隔取两者之和的 2 倍，上限 `STREAM_PAINT_CEILING_MS`；迟到量按当前帧间隔封顶（`frameCostMs`），读流解析、GC、审批框或 OS 调度这类与绘制无关的停顿只能让间隔翻倍一次，却仍能让真正重绘超预算的窗口逐帧翻倍到两倍成本：pi-tui 的逐行处理（光标解析、行 reset、差分写入）随屏幕行数增长且不在任何组件自己的计时里，只按 rebuild 计时会让 2000 行窗口以 33 ms 间隔连续重绘，抢走读流的事件循环——这正是长会话 tok/s 越跑越低、而 Web（Host 与前端分进程）不出现的原因。mock SSE（1200 chunks × 8 字符 / 12 ms）实测 26 fps、gap p50 34 ms / p90 41 ms（修复前 14 fps、44–51 ms）；fullscreen（alt-screen）下每帧通常只重写 1 行，main-screen 因整屏 diff 会在换行时重写尾部区域，推荐开启 `fullscreen`。main-screen 只能 patch 可见行：已滚入 scrollback 的行一旦变化，pi-tui 会清屏 + 清 scrollback 并重写整份 transcript，所以块首行（`◆ assistant`、`⚙ name`、`◆ compaction`）在块创建后保持不变，运行状态由状态行或卡片尾行表达。
- 流式内容直接跟随 provider：每帧显示已经收到的全部 text/reasoning，`block-end` 与 `assistant/message` 立即采用完整内容，没有额外逐字动画、播放队列或 settle grace。reasoning、正文、工具卡片按 provider/event 顺序展示，可以落在同一帧；只收到 reasoning `block-start` 时显示 `thinking …` 占位。长会话仍保留增量事件归并、组件复用和自适应帧合并。`DSH_NATIVE_TUI_DEBUG=1` 输出 chunk 字符数与帧成本。
- 执行状态独立于内容渲染：turn 开始后显示 `⟳ working · Ns`，收到文本、reasoning、工具调用或 stream/end 都不会将它清除，直到 turn/end 或切换会话才结束。Host 调度自动重试时立即显示 `⟳ retry N/M after CODE (automatic) · Ns`，新 attempt 或恢复收流后回到 working；秒数按本轮执行时长计数。断流检测、超时和重试策略归 Host/provider 所有，TUI 不根据画面是否变化判断网络状态；失败与取消 notice 保留已收到内容并直接展示。
- 运行中 `Esc` / `Ctrl+C` 取消 turn；输入框有草稿时 `Esc` 先清空草稿，空输入才取消 turn（overlay 聚焦时不触发）。长文本和 tool 输出按行保持左侧色条。
- 上下文压缩：默认 preset 启用 `compaction-basic` 自动压力压缩与 context-overflow 恢复，以及 tool-result pruner；TUI 渲染 compaction start/summary/end；prune 会隐藏对应 tool 卡片并保留 prune notice；session 级 tool memory 会忽略同一 callId 的晚到/重复 call/result，即使原始事件已离开 retained window；`compact-checkpoint` 在匹配的 compaction 卡片已存在时不再重复渲染完整 checkpoint。进程在 `compaction/start` 与 `compaction/end` 之间崩溃时，resume 写入的 `turn/end{interrupted}` / `session/end-seed` 会释放 Host 的压缩锁，卡片尾行随之显示 `⚠ interrupted` 而不是一直停在 `⟳ compacting…`；同一 resume 的 `Turn interrupted before it finished` 也会作为 notice 显示。`/compact` 作为 Host command 可手动触发。
- 显示密度可配置：`thinkingDisplay` 与 `runCodeDisplay` 均支持 `hidden | compact | detailed`；后者覆盖 `run_code`、`bash`、`pwsh` 等代码执行工具卡。
- 工具卡片来源与配色：`ptc` 预设的 `run_code` 内嵌 `write`/`edit` 由 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 建独立卡片；`standard` / `cordis` 等 native 预设直接走 `tool/call` / `tool/result` 顶层卡片，`minimal` 不暴露 write/edit。两条路径共用同一 diff 渲染，不按预设分支。背景带使用中性暗灰 `48;5;237`（dark）/ 浅灰 `48;5;253`（light），状态色只出现在 `⚙` 与卡片尾行的 `└ running…/done/error` 上。卡片首行（`⚙ name`、`◆ assistant`、`◆ compaction`）在卡片创建后不再变化：main-screen 只能 patch 可见行，改写已滚入 scrollback 的首行会让 pi-tui 清屏并重写整份 transcript，因此运行状态一律放在卡片尾行或底部状态行。
- 宽松排版：header 三行（产品标题、Session id、cwd）；transcript 只保留上下留白；状态区独立成块（`● idle   model provider/model   think max` + 空行 + preset/快捷键），transcript/状态区/输入框/分隔线/编辑框边框共用同一满宽列、无左右留白（宽度取自终端当前宽度并随 resize 自适应）；reasoning effort 同时决定 `think` 标签、状态栏上分隔线和编辑器上下边框的颜色（low 暗绿 / medium 浅蓝 / high 粉红 / max 红；未设置或未知 effort 保持 dim，`plain` 主题不着色）。状态栏其余部分：provider 蓝色、model 青色、preset 紫色、attached 数量青色；footer 的 `ctx` 在自动压缩触发点前 20 个百分点内转黄、达到触发点转红。Prompt 下方 footer 两行分别显示 `↳ turns · steps · tok/s · tok · cache` 和 `ctx ...`。context 与 Web 端同口径：读 token meter 的 `contextPressure` 投影（最近一次 provider 采样 + 此后 surface 增减，compaction 的影响已含在内），渲染为 `ctx 42%  (~420K / 1M · compact at 80%)`，其中 `compact at` 是按 `compaction-basic` 的 `thresholdRatio`、`headroomTokens` 与该请求预留输出复算出的自动压缩触发点；首次 provider 采样之前显示 `ctx —`，不猜占用（与 Web ContextMeter 一致）。token 用量与 cache 命中率同样按 Web 口径：总量取四桶之和、部分命中不会显示成 100%，数字格式与 Web 统计 pill 一致。tok/s 为整段 Session 的累计 decode 速率（Host `sessionStats` 的 `decodeTokens / (decodeMs / 1000)`，与 Web 统计 pill 同式），不是瞬时速率；低于 10 时保留一位小数。未挂载 `sessionStats` 投影时，从 `assistant/message` 的 stream 首 token 与 output tokens 回退计算。未挂载 token meter 时，日志回退只在被 shadow 的事件已属于最近一次 provider 采样时，扣除 `compaction/summary` / `compaction/prune` 的 `shadowedTokenCount`；采样后新增再被裁剪的结果不会被重复扣除。
- `@@<query>` 自动补全其他 Session 的 canonical mention；发送时 Host session-reference 自动注入快照。
- `/export [path]` 导出 Session JSONL；`/export zip [path]` 导出含 manifest、attachments、deliverables 的 ZIP bundle；`/export html [path]` 导出静态 HTML transcript；`/open` 预览文本文件，Markdown 以 pi-tui Markdown 样式分页渲染；`/preview` 渲染 PNG/JPEG/GIF/WebP 图片；`/files` 浏览目录并预览；`/attach` 暂存文件/图片或剪贴板图片并随下一条 prompt 发送（8 MiB 上限），`/attach preview <i>` 可内联预览暂存项，`/attachments` 打开暂存附件管理器（预览/移除）；`/deliverables` 可列出、打开 panel、预览或用系统文件管理器定位 present 交付文件；`/tools` 列出工具调用，`/tool <index>` 分页查看完整参数/结果，`/diff [index]` 查看 write/edit 的独立 diff。
- 问答/审批在 preset Agent 上仍可用（question probe 已通过）。
- `@file` 主机端补全（file-reference-local）与 `/` 本地/宿主命令+技能补全：`@` 菜单每行是「文件名 + 类型 · 完整路径」（与 pi agent 的文件补全一致），类型放在第二列开头，路径过长时被截断的是路径而不是「这是文件还是目录」；长路径只截断第一列的文件名，不会让所有行停在同一个公共目录前缀上；`/` 菜单在命令之后列出 Host `ctx.skills` 的用户可调用技能（仅用户可调用的标注 `user-only`），选中插入 `/skill-name`，回车按普通 prompt 发送，由 `dsh-tool-skill` 读取 `/name` 手势并注入技能正文；选中的路径作为普通 prompt 文本，模型需用 read 工具读取。
- 会话列表/按 id 恢复、状态、清屏、安全退出、终端恢复；恢复 Session 时读取持久化的 model/selection 与 request/header，恢复模型、reasoning effort 和 preset；退出后打印 Session ID 和可直接执行的 `--resume` 命令。
- 非 TTY 显式失败；Ctrl+C/Ctrl+D/SIGTERM/SIGHUP 安全退出。

## 安装

~~~sh
# 一键安装到默认 tui profile（link 当前 checkout；--pack 改为安装 .tmp 下的 tgz）
./scripts/install.sh

# 指定 profile
./scripts/install.sh --profile work

# 等价手动步骤
pnpm install
pnpm build
dsh plugin --profile tui add /absolute/path/to/dsh-native-tui

# 启动（安装脚本或首次启动会创建 dnt，等价于 dsh --profile tui）
dnt

# 手动安装或未生成 dnt 时直接启动
dsh --profile tui

# 参数原样透传，例如恢复上次 Session（退出时打印的 Resume 命令）
dnt --resume <session-id>
~~~

`scripts/install.sh` 默认执行 `pnpm install --frozen-lockfile` 与 `pnpm build`，再通过 `dsh plugin --profile tui add` 安装；`--no-build` 跳过前置步骤，`--pack` 先打包，再移除旧安装并安装独立副本（版本号未变也会安装新内容）。安装成功后脚本会在 `$XDG_BIN_HOME`（未设置时为 `~/.local/bin`）写入启动命令：`tui` profile 为 `dnt`，其他 profile 为 `dnt-<profile>`，作用等价于 `dsh --profile <profile>` 并原样透传参数；`--command <name>` 可以改名。直接用 `dsh plugin add` 安装时，插件在默认 DSH home 下首次启动也会补建同样的命令；`DSH_HOME` 不是默认的 `~/.dsh`（测试/探针或自定义 home）或设置 `DSH_NATIVE_TUI_NO_LAUNCHER=1` 时不自动创建。目标文件已存在且不是本插件生成的（不带 `dsh-native-tui launcher` 标记）时不会覆盖；不再需要时删除该文件即可。DSH Host 包由当前 dsh 安装提供；插件运行时还依赖 pi-tui、schemastery、fflate，以及官方 computer-use / mcp / session-stats rc.2 包。
安装路径使用 link: 时，修改源码后重新 pnpm build 即可生效；更新 TUI 插件或其他插件后，在 TUI 内执行 `/reload` 会保存当前模型选择、恢复当前 Session 并重新加载进程。

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
| /reasoning [effort|default|map] | 列出或切换当前模型的思考强度并保存；default 清除显式 effort；map 引导编辑当前模型的 level → wire 映射 |
| /provider [add|list|edit [route]|models <route>|input [provider/model]|remove <route>] | 配置/查看 provider；打开配置获取可用模型；编辑模型输入类型；刷新或删除 route |
| /mcp [add|list|remove <name>] | 配置、查看或删除 MCP 服务 |
| /permissions [preset] | 列出或切换权限预设 |
| /jobs [kill <id>] | 列出或终止后台任务 |
| /agents | 列出直接子代理 |
| /preset [id] | 首个 turn 前切换当前 Session；已开始则用于下一次 /new；同时保存默认 preset |
| /workspaces [new <path>|use <id|path>|pin|unpin|archive|unarchive] | 列出/创建/切换/固定/归档 workspace 会话 |
| /schedule [add <seconds> <title>|delete <id>] | 列出/创建/删除一次性提醒 |
| /plugins [list|market [query]|inspect <spec>|install <spec>|remove <bundle>|enable <entryId>|disable <entryId>] | 列出、浏览官方市场、检查/安装/移除 bundle，或启停插件项 |
| /settings [tui\|host\|edit [ns]\|items <ns> <field>\|set <ns> <json>] | 默认打开引导式 TUI 配置页（全部 native-tui 字段，暂存后一次保存）；`host`/`edit [ns]` 打开 Host 命名空间内嵌编辑器（搜索、类型化编辑、数组增删/JSON、secret 保护、冲突重试）；`items`/`set` 保留脚本化入口 |
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
| /reload | 重新加载 TUI 与插件并恢复当前 Session；用于插件更新后生效 |
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
    maxTranscriptEntries: 600     # 每帧重绘的行预算；越大流式帧越慢
    fullscreen: false              # true 使用 alt-screen + 鼠标/应用滚动
    theme: auto                    # auto | dark | light | plain
    agentPreset: ptc               # 默认 ptc | standard | minimal | cordis
    title: DeepSeek Harness
~~~

以上字段全部注册为 native-tui 的 live settings（volatile），`/settings` 引导页写入 profile patch；schema 中的 description 同时用于 TUI 与 Host 设置页的字段说明。

显示模式：

- `hidden`：不渲染 reasoning / `run_code` / `bash` / `pwsh` 块。
- `compact`：reasoning 只显示首行摘要；代码执行工具只显示状态 + description/command/code 单行摘要。
- `detailed`：当前完整 reasoning 区带与代码执行工具 args/result 卡片。

`/settings` 默认打开 **TUI settings** 引导页，覆盖全部 native-tui 字段：thinking / code execution 显示模式、Show reasoning（legacy）、transcript entries、theme、fullscreen、header title、cwd、resume session、agent preset。每行显示当前有效值、字段说明和生效时机；编辑先暂存，`Save and apply` 以一次 path-addressed mutation 写入（revision 冲突自动按新 revision 重试一次）后关闭页面并输出保存回执，`Discard changes` 丢弃暂存。thinking / code execution / Show reasoning / transcript entries / title 立即生效；theme / fullscreen 重启后生效；cwd / sessionId / agentPreset 下次启动生效。保存回执按生效时机分组说明。`/settings host` 或 `/settings edit [ns]` 打开 Host 命名空间内嵌编辑器：按 schema 列出可编辑路径（支持嵌套对象、动态 record、数组 item、JSON 值），可搜索、类型化编辑、append/remove 数组项、reset 到继承值；secret 字段只显示不可编辑，含 secret 的对象不允许整体 JSON 覆盖；每次写入使用路径操作，避免重述并删除被 redact 的 secret。`/settings items` 打开对应命名空间编辑器作为兼容入口，`/settings set` 保留 JSON merge 写入。

默认模型来自 Host 的 ctx.agentDefaultModel（Base 默认 deepseek-official/deepseek-flash）。没有凭据时首个请求会显示 MISSING_CREDENTIAL。

## 第三方模型

`/provider add` 提供引导流程：

1. 选择 Custom OpenAI-compatible / OpenAI Responses / Anthropic-compatible gateway，或 Built-in pi-ai catalog route。
   - **Built-in pi-ai catalog route**：从 Host `listConfigurableProviders` 提供的内置目录搜索选择（`amazon-bedrock`、`anthropic`、`deepseek`…），与 Web 端 Models 页一致，不再手输路由名；目录不可用时才回退手输 catalog id。
2. 选择 Credential source：
   - **Use built-in environment auth**：provider 声明原生认证时出现（默认项）。写入不带 `apiKeyEnv` 的 profile，沿用 provider 自己的环境变量，例如 `amazon-bedrock` → `AWS_BEARER_TOKEN_BEDROCK`。
   - **Store API key in DSH credentials（推荐）**：直接粘贴 key。key 存入 DSH credential store（`~/.dsh/.credentials.yaml`，权限 0600），不写入 profile；无需 export。输入时 key 在终端可见。
   - **Use an environment variable**：输入 UPPERCASE 变量名，启动 dsh 前在 shell export；catalog route 的默认值是 provider 原生 env（无原生认证时回退 `<ROUTE>_API_KEY`）。
3. custom gateway 会调用 Host `discoverModels` 请求 `GET {baseURL}/models` 并列出模型（5 秒超时）；catalog route 直接使用 provider 内置模型列表。
4. 从内置/自动发现的模型中选择，或回退到手动输入 model id/context window/max tokens。**发现列表中的其他模型也会写入该 route**，之后可在 `/model` 中直接切换。
   - 自动导入的其他模型：`input` 随 discovery 一起保存，catalog 或 endpoint 声明了输入类型就写声明值；未声明（自定义网关的 `/models` 通常只返回容量）则显式保存为 `[text]`，不再留空继承 route 的 `defaultInput`。
   - 选中的模型会再询问 **Input modalities**：discovery 声明 image 时默认 `Text + image`；未声明或只声明 text 时默认 `Text only`，可手动改成 `Text + image`。这一步是必要的，因为已有网关（如 command-code）的 listing 完全不提供模态信息，但模型实际能读图。
   - 其他模型使用 discovery 返回的容量/模态，并写入默认 `reasoningEfforts`（`low/medium/high` 同名映射）。
5. 输入 Reasoning levels（逗号分隔，默认 `low,medium,high`；留空表示不支持 reasoning）。生成的模型配置会写入 `reasoningEfforts`，之后可用 `/reasoning` 切换，或运行 `/reasoning map` 引导修改 level → wire 映射。

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

也可以在 route 级使用 `defaultInput: [text, image]`，让该 route 下未声明 `input` 的模型继承；已显式保存 `input` 的模型优先用自己的声明。endpoint 未声明输入类型、但实际支持图片的网关，可在对应模型上手动补 `input`（或为 route 设置 `defaultInput`）。`reasoningEfforts` 的 key 是 Harness 选择项，value 是该网关实际接收的 wire spelling；引导默认同名映射，网关拼写不同（例如 `minimal`）时请按实际值修改。

切换思考强度：

```text
/reasoning
/reasoning high
/reasoning default
```

运行中切换会在下一 step 生效；状态栏会显示 `think high`。

编辑当前模型的思考强度映射：

```text
/reasoning map
```

`/reasoning` 的 effort 选择菜单里也有 **Edit reasoning map…** 入口；输入 `/reasoning` 后跟空格时补全会提示 `map` 子命令，而精确输入 `/reasoning` 时第一项仍是命令本身，回车打开 effort 选择器；从 `/reasoning ` 的补全中选择 map，或完整输入 `/reasoning map` 后回车，都会一次执行，不再需要第二次补全确认。向导会对当前 `provider/model` 提供：

- **Add or update a level**：从 `off/minimal/low/medium/high/xhigh/max` 中选择 level，再输入该网关实际接收的 wire spelling；`off` 留空表示不下发字段（`null`）。
- **Remove a level**：从当前映射中移除一个 level；至少保留一个非 `off` level。
- **Use same-name defaults**：重置为 `low/medium/high` 同名映射。
- 修改先暂存在内存，选择 **Save and apply** 才写入 `llm-pi-ai` 设置；Esc / Cancel 不落盘。

写入位置取决于 route：显式 `models` 列表中的模型更新该条目的 `reasoningEfforts`；catalog route 没有显式 `models` 时写入 `modelOverrides.<model>.reasoningEfforts`，不复制整个模型目录。若模型还没有存储映射（包括显式 `models` 条目省略 `reasoningEfforts`，以及 `modelOverrides` 未设置映射），向导会从 catalog 报告的 level 生成同名的暂存映射，并将其视为待保存修改；提示核对 wire spelling 后再 **Save and apply**。若 `models` 数组来自其他配置层，保存前会确认将合并后的完整数组写入 profile patch，避免静默遮蔽 base 层配置。如果当前显式 effort 在保存后已不存在，会自动回到 provider default。该向导只编辑由 `llm-pi-ai` 提供的模型；CodeBuddy 等适配器自己管理 level，不能用它修改。

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

`/provider` 打开 provider 选择；`edit` 进入配置菜单（Fetch available models / Edit model input types）；`models` 直接获取。查询使用已保存的 baseURL/API 协议/credential，把 endpoint 返回的模型合并进 route：新模型追加，已有模型更新容量。`input` 与模型列表一起保存：discovery 声明了输入类型就写入新模型；已有模型显式声明的 `input` 保留，`input` 缺失或为空（schema 对缺省数组的物化结果）时用 discovery 声明回填，discovery 也未声明则保存为 `[text]`。`reasoningEfforts` 保持原样；新增模型若未声明，会自动写入默认同名映射 `low/medium/high`，使其在 `/reasoning` 中可直接切换；已有模型（包括留空表示不支持 reasoning 的）不会被回填。

编辑单个模型的输入类型：

```text
/provider input                                             # 当前模型
/provider input command-code/deepseek/deepseek-v4.1-flash   # 指定模型
/provider edit command-code                                 # 菜单里选 Edit model input types
```

向导会显示当前声明，并可选择 `Text only`、`Text + image`，或 `Inherit route default` 删除显式 `input` 让 route 的 `defaultInput` / catalog 生效。这是**手动能力声明**，不会探测模型：只有当模型或网关确实接受图片时才选 `Text + image`，否则请求会失败。写入位置与 `/reasoning map` 一致：显式 `models` 条目写 `models[].input`；catalog route 写 `modelOverrides.<model>.input`；`models` 来自其他配置层时会先确认再整体重写该数组。

**不要在 env 模式把 key 填进变量名。** 流程要求 UPPERCASE 环境变量名，并拒绝形似 key 的输入。若旧配置已经把 key 写入 `apiKeyEnv`，立即执行 `/provider remove <route>`，检查 `cordis.patch.yml` 中对应配置，并轮换该 key。手工 JSON 配置仍可通过 `/settings set llm-pi-ai ...` 或 Web Models page 完成。

## CodeBuddy / WorkBuddy（内置插件）

`dsh-native-tui` 内置 `codebuddy` 插件（bundle 行 `dsh-native-tui/codebuddy`），把两个部署注册为 DSH LLM 路由：

- `codebuddy` — CodeBuddy 国内版（copilot.tencent.com）
- `codebuddy-en` — WorkBuddy 国际版（www.workbuddy.ai）

两者不依赖 Web 端的 router 插件，也不需要任何本地代理：浏览器 OAuth 登录，凭据走 DSH authorization / credential seam，续期在 credential record 的互斥写内完成。

```text
/codebuddy status            # 登录态、token 轮换时间、模型目录与最近错误
/codebuddy login [cn|en|all] # 打开浏览器授权并轮询（最多 5 分钟）
/codebuddy logout [cn|en|all]
/codebuddy models [cn|en]    # 列出模型及其声明的输入模态与来源
/codebuddy models refresh    # 拉取 GET /v3/config 目录
/codebuddy quota [cn|en]     # 剩余额度（只读，显式执行）
/codebuddy checkin [cn|en]   # 显式签到（调用厂商自有端点，请自行确认条款）
/codebuddy prompt            # 引导式配置系统提示词（自定义模板或恢复默认）
/codebuddy prompt show|reset # 打印当前模板 / 删除自定义模板
/codebuddy doctor            # 端点、请求形态与目录连通性探测，不含凭据
```

登录前 `/model` 已能看到两条路由与 seed 模型（CN 8 个 / EN 6 个，未经真实账号验证）；登录后 `models refresh` 会用账号目录替换。

国内网关会做客户端指纹校验：系统提示若以第三方 agent 身份句（`You are an AI agent powered by …`）开头，会返回 HTTP 400 `code 11128`（`Illegal API invocation from an unapproved channel`，提示「渠道校验未通过，可能不是官方客户端」）。`codebuddy` 路由在发送前把这类身份句改写为中性表述——无论提示放在 `system` 字段还是 in-history 的 system 消息里（TUI 走后者）——其余提示（工具说明、工作区规则、用户指令）逐字保留；国际版不做该校验，提示保持原样。异常时按 `code 11128` 的 hint 排查。

### 系统提示词

网关按系统提示做客户端指纹校验，规则可能变化。插件默认只把 harness 身份句改写为中性表述（见上），其余系统提示逐字保留；需要调整发往 CodeBuddy 的系统提示时，用 `/codebuddy prompt` 的引导界面：

- **Add / Edit the custom template** 打开多行编辑器（Enter 保存，Shift+Enter 或 Ctrl+J 换行）。模板含 `{prompt}` 时，harness 当次组装的系统提示（工具说明、工作区规则、技能等）会在该位置展开，只展开一次；不含占位符则整段替换。
- **Use the default prompt** 删除自定义模板，回到身份句改写。
- 编辑器提交空内容等同恢复默认；不含 `{prompt}` 的模板保存前会二次确认。

`/codebuddy prompt show` 打印当前模板，`/codebuddy prompt reset` 直接恢复默认。写入的是 profile patch 的 `codebuddy.systemPrompt`（volatile 字段），下一条请求即生效，无需重启。等价的配置写法：

~~~yaml
- id: codebuddy
  name: dsh-native-tui/codebuddy
  config:
    systemPrompt: |
      You are CodeBuddy, a coding assistant.
      {prompt}
~~~

整段替换会同时丢掉工具说明与工作区规则，通常保留 `{prompt}`、只改写开头更稳妥。配置对 `codebuddy` 与 `codebuddy-en` 两条路由同时生效，CN 的身份句改写仍作用在最终文本上；其他 provider 的请求不经过本插件的 wire 层，系统提示仍由 Host 按默认规则组装，不受这里影响。

### 输入模态与图片

输入模态按模型取自网关目录的 `supportsImages` / `disabledMultimodal`（2026-10-19 实测：CN 34 个模型、EN 27 个模型都带该字段）：

- `supportsImages: true` → 声明 `text` + `image`，图片以 OpenAI `image_url`（base64 data URI）随 user 消息或 tool 结果发出，两个角色均已实测可读图。
- `supportsImages: false` 或缺失 → 保持 text-only；Host 会把图片块投影为占位文本，不会把无法识别的图发给上游。
- `disabledMultimodal: true` 优先于 `supportsImages`。
- 登录前（seed 列表）与手填未命中目录的模型 id 一律 text-only。
- 未挂载 attachment 服务时全部声明 text-only：拿不到图片字节，声明图片只会在中途失败。

`supportsImages: false` 不等于不能看图（实测 `default`、`glm-5.0` 声明 false 但仍能读图）。这类模型用插件配置按模型覆盖：

~~~yaml
- id: codebuddy
  name: dsh-native-tui/codebuddy
  config:
    models:
      default:
        input: [text, image]
~~~

`/codebuddy models` 会打印每个模型实际声明的模态与来源（`catalogue` / `override` / `seed`）。当某个声明要求图片、但当前组合拿不到图片字节时，该行会追加 `(... asks for images; no attachment service mounted, so text only)`——覆盖同样适用，所以这里能区分「覆盖生效」与「覆盖被降级」。

图片请求会按 2048² 像素 / 1 MiB 的预算投影（与 `llm-pi-ai` 默认值一致）；读图失败降级为占位文本并写诊断，不让整轮失败。同一附件在一个请求里只读取一次，多张图并发读取；已标记 `offloaded` 的图片直接发占位文本，不重读字节。

整段会话的内联图片总量超过 20 MiB 时，请求以 `IMAGE_OFFLOAD_REQUIRED` 失败并携带需要卸载的数量，由 base bundle 的 `compaction-image-offload` 把最旧的图片换成占位文本后重试——这样长会话的请求体不会无上限增长。

已知限制：

- OAuth、模型授权、真实思考档位与额度字段仍为协议转写（来源 `CARVIN94/dsh-router-codebuddy`，MIT），未用真实账号验收；模态字段与图片收发已用真实账号实测（见 `scripts/codebuddy-image-e2e.mjs`）。
- 图片计费（visual tokens）未接入 token meter，用量面板会低估图片请求成本。
- 图片只允许出现在 user 消息与 tool 结果；system/assistant 携带图片会以 `UNSUPPORTED_CONTENT` 拒绝，developer 消息整条丢弃。
- `/attach` 给 text-only 模型贴图会提示，但终端不拦截：prompt 直接进 agent，不经过 session-controller 的图片准入检查。
- 上游请求不带 `stream_options`，不返回 `usage`；此时不显示 token 用量，也不伪造 0。
- 路由名 `codebuddy` / `codebuddy-en` 由本插件独占。若此前在 `llm-pi-ai` 设置里手工配置过同名 route，请先 `/provider remove codebuddy`（及 `codebuddy-en`），否则 llm-pi-ai 注册同名路由会失败并输出诊断。
- 登录入口只在终端内（`/codebuddy login`），Web Models 页不提供这两个 provider 的 OAuth。

真实 Host 冒烟（离线即可，不需要账号；需用一个没有存储凭据的 DSH_HOME，否则断言「未登录」的用例会失败）：

~~~sh
pnpm build
pnpm pack --pack-destination .tmp
DSH_HOME=/tmp/dsh-native-tui-codebuddy-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
DSH_HOME=/tmp/dsh-native-tui-codebuddy-home node scripts/fake-tty-codebuddy.mjs
~~~

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
pnpm check          # typecheck + 138 unit tests + build
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

真实审批 waterfall 用 mock 模型 + 真实 Host 跑 allow/reject/cancel（首次需把当前构建装进一个临时 home）：

~~~sh
pnpm pack --pack-destination .tmp
DSH_HOME=/tmp/dsh-native-tui-approval-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
DSH_HOME=/tmp/dsh-native-tui-approval-home node scripts/fake-tty-approval.mjs
~~~

内置 provider 目录（catalog 选择器、原生环境认证、保存后内置模型列表）同样用真实 Host 冒烟：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-catalog-home node scripts/fake-tty-provider-catalog.mjs
~~~

手动编辑模型输入类型（`/provider input` 与 `/provider edit` 菜单、Text only / Text + image / Inherit 三种写入）用真实 Host 探针：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-input-home node scripts/fake-tty-provider-input.mjs
~~~

其他预设（standard）的原生 write/edit 卡片（直接 `tool/call`，不经过 `run_code`）同样用真实 Host 探针：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-native-diff-home node scripts/fake-tty-native-diff.mjs
~~~

`/reload`（保存当前模型、恢复同一 Session 并替换进程）用自建临时 profile 的探针验证：

~~~sh
node scripts/fake-tty-reload.mjs
~~~

流式大 chunk 与 settlement 收尾用同一类探针验证（212 字单 chunk 与 100 字 chunk / 300 ms 的连续流，内容完整显示且没有本地逐字播放）：

~~~sh
node scripts/fake-tty-stream-smooth.mjs
node scripts/fake-tty-stream-chunks.mjs
~~~

`fullscreen: false`（main-screen）下长 transcript 的流式渲染另用探针验证：assistant 块结算时头部不再变化，因此不会触发 pi-tui 的整屏重绘（清屏 + 清 scrollback），流式答案跟随收到的内容并完整落地：

~~~sh
node scripts/fake-tty-main-screen-scroll.mjs
node scripts/fake-tty-card-head.mjs
~~~

工具调用参数分帧流出时，working 行保持可见，直到整个 turn 结束；断流恢复探针在完整显示部分 reasoning 后主动断开 SSE，断言 working 持续、自动重试可见、恢复响应后回到 idle：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-wait-tool-phase-home node scripts/fake-tty-wait-tool-phase.mjs
node scripts/fake-tty-stream-recovery.mjs
~~~

`@file` 补全的长文件名布局同样用真实 Host 探针验证（同名前缀的 `docs/design-task-*` 文件，断言每行第一列是文件名而不是公共目录前缀）：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-reasoning-stream-home node scripts/fake-tty-file-completion.mjs
~~~

卡片首行不变量与饱和窗口的批量裁切由离线用例直接驱动真实 `TuiMainScreen`（假终端，断言 `fullRedraws === 0`），不需要 Host：

~~~sh
pnpm vitest run tests/main-screen-cards.spec.ts
~~~

内置 CodeBuddy 插件（两条路由挂载、`/codebuddy status|doctor`、`/model` seed 模型）用真实 Host 冒烟，离线可跑：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-codebuddy-home node scripts/fake-tty-codebuddy.mjs
~~~

`/codebuddy prompt` 的引导流程（菜单 → 多行编辑器 → settings 写入 → show/reset）用同一套临时 profile 验证。探针会重置该 profile 的 `cordis.patch.yml`，只接受 `/tmp/dsh-native-tui-*` 下的 disposable home：

~~~sh
pnpm build
pnpm pack --pack-destination .tmp
cp -a /tmp/dsh-native-tui-codebuddy-home /tmp/dsh-native-tui-cb-prompt-home
DSH_HOME=/tmp/dsh-native-tui-cb-prompt-home dsh plugin --profile tui remove dsh-native-tui
DSH_HOME=/tmp/dsh-native-tui-cb-prompt-home dsh plugin --profile tui add "$PWD/.tmp/dsh-native-tui-0.2.1-rc.2.tgz"
DSH_HOME=/tmp/dsh-native-tui-cb-prompt-home node scripts/fake-tty-codebuddy-prompt.mjs
~~~

CodeBuddy 输入模态与图片收发用真实 Gateway 验证（有凭据时跑真实对话，无凭据时跳过联网检查）：

~~~sh
pnpm build
node scripts/codebuddy-image-e2e.mjs
~~~

`/codebuddy models` 的渲染用真实 Host 冒烟（脚本自建仅本人可读的假凭据，拒绝覆盖真实凭据）：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-cb-models-home node scripts/fake-tty-codebuddy-models.mjs
~~~

手动调用技能（`/` 菜单列出技能、`/skill-name` 注入技能正文）用真实 Host 冒烟（脚本自建 fixture skill）：

~~~sh
DSH_HOME=/tmp/dsh-native-tui-skill-home node scripts/fake-tty-skill.mjs
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