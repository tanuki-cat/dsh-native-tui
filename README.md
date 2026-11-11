# dsh-native-tui

DeepSeek Harness 的 host-native 终端前端，基于 [pi-tui](https://github.com/earendil-works/pi-tui)。

Session、模型、工具、审批、压缩、MCP、插件都由 Host 提供，本包只负责终端界面与少量 Host 侧适配：它要在终端里做到 Web 模式的核心能力，而不是把浏览器界面搬进 TUI。

> 设计方案与差距清单：[Host-native 方案](docs/design-task-feature-dsh-native-tui-host-native.md)
> 实施进度、验证证据与未验收项：[实施进度](docs/progress-dsh-native-tui.md)
> rc.1 适配范围与验收：[版本评估和实施记录](docs/design-task-upgrade-dsh-0-2-2-rc-1.md)

## 快速开始

### 环境要求

- Node `>=24.9.0`
- pnpm（仓库使用 `pnpm-lock.yaml`，不要用 npm / yarn）
- 全局安装的 `dsh` 0.2.2-rc.1

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

`pnpm` 版本：脚本默认让 pnpm 使用**已安装的版本**，跳过 `package.json` 中 `packageManager: pnpm@12.14.0` 的自动下载。原因见下节。需要严格使用锁定版本时，设 `DSH_NATIVE_TUI_STRICT_PNPM_VERSION=1`。

> 为什么跳过版本自举：pnpm 12 会先把锁定版本下载到 `~/Library/pnpm/package-manager-store` 再执行。该下载在只读 home、沙箱或 store 中只存有旧版原生二进制时会失败，报 `no @pnpm/exe.darwin-arm64 native binary was found for this host`，看起来像 lockfile 损坏，实际是 CLI 自身无法就位。依赖图来自 `pnpm-lock.yaml`，`packageManager` 只决定 CLI 版本，因此用已安装的 pnpm 是安全的。脚本执行前还会探测一次 `pnpm --version`，失败时给出明确修复提示而不是把 pnpm 的原始报错直接抛给用户。

`--pack` 会在打包前清空 `.tmp/*.tgz`，并校验 `pnpm pack` 的产物确实落在 `.tmp` 内，避免装到旧包或检出的根目录遗留 tgz。

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
- 模型与 reasoning effort 由 Host `agent.model` 读写并随 Session 持久化；恢复会话和 `/reload` 沿用记录，provider 默认思考档保持自动，不固化为显式选择。preset 从 Session 记录恢复。
- Agent Presets：`standard` / `ptc` / `minimal` / `cordis`。`/preset` 可在首个 turn 前切换当前 Session；已开始的 Session 锁定，选择用于下一次 `/new`，同时写入 `agent-preset-registry.selectedDefault`。
- Workspace 列表 / 创建 / 切换 / pin / unpin / archive / unarchive；Schedule 列表 / 创建 / 删除。
- 子代理列表（`/agents`）、后台任务列表与终止（`/jobs`）。
- 退出后打印 Session ID 与可直接执行的 `--resume` 命令。

### 模型与凭据

- 模型与 reasoning effort 通过 Host `agentDefaultModel.saveSelection` 持久化，重启或 `/new` 沿用它，不回落默认。
- `/model` 打开可搜索的模型列表，显示 Host 提供的模型角标；打开期间按 provider 独立刷新，保留搜索词和选中项，某个目录失败或变慢不阻塞其他目录更新。也可直接 `/model provider/model` 切换；连续选择以最新有效请求为准。
- `/reasoning` 列出或切换思考强度：`/reasoning high`、`/reasoning default`（清除显式 effort）、`/reasoning map`（编辑 level → wire 映射）。输入框获得焦点时，`Shift+Tab` 按当前模型提供的档位顺序循环，末档回到首档；未显式选档时从 provider 默认档的下一档开始，没有默认档则从首档开始。它只选择档位，不修改 level → wire 映射，沿用 `/reasoning` 的保存方式，并用于后续 step。
- `/provider` 管理第三方模型路由：添加、查看、刷新模型目录、编辑输入模态、删除。
- `/codex` 登录 ChatGPT Codex 并查询额度。
- `/codebuddy` 登录 CodeBuddy / WorkBuddy（内置插件，见下文）。

### 工具、审批与问答

- 流式文本、Markdown、reasoning、工具卡片、turn 失败提示。
- 工具卡片按来源区分，两条路径共用同一套 diff 渲染，不按预设分支：
  - `ptc` 预设的 `run_code` 内嵌子调用由 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 建卡片。
  - `standard` / `cordis` 等 native 预设直接走 `tool/call` / `tool/result` 顶层卡片；`minimal` 不暴露 `write`/`edit`。
- 文件卡片按操作语义显示标签：新建或尚未确认操作的 `write` 显示 `Write`，Host 确认更新已有文件后显示 `Edit`，直接调用 `edit` 也显示 `Edit`。有实际 diff 时展示带行号和增删统计的差异，否则保留编号源码预览；Session 日志和 `/tool` 中的实际工具标识不变。圆点颜色表示执行状态。
- 审批与问答 waterfall。普通选择、输入、分页和图片 overlay 使用带边框的不透明背景；审批使用屏幕下方的编号选项与分隔线，突出实际调用和原因。审批按 toolName 与 callId 精确读取本次原生或 PTC 调用的参数，展示实际命令、目标路径或 MCP 方法；无法匹配时明确显示参数不可用，不借用相邻调用。`View full request details` 可查看完整 JSON，按视觉行翻页并随窗口缩放；Esc 返回原审批，查看详情本身不批准请求。长预览会标记截断，为批准、拒绝与取消保留空间。
- 权限问答（`approval` intent）只提供调用方声明的批准、拒绝及可选持久授权，默认选中拒绝，不显示 Other 或跳过。动作保持可见，完整权限说明可分页查看，查看详情不会授权。展示标签与授权答案值分离；Esc 或请求中止不会批准。
- 普通问答面板支持单选与多选：Space 勾选、Enter 提交，Other 提供自由文本（多选时会与已勾选项一并返回）；每题都有 `Skip this question` 行（无选项文本题为 `Answer… / Skip this question` 菜单），跳过只返回 `{ id, selected: [] }` 并继续批次；Esc 或请求 signal 中止会以 `UserQuestionError(ASK_ABORTED)` 取消整批。
- 运行中 `Esc` / `Ctrl+C` 取消 turn；全屏浏览历史时 `Esc` 先回到末尾并保留草稿与运行状态；已在末尾时，输入框有草稿则 `Esc` 先清空草稿，空输入才取消（overlay 聚焦时不触发）。

### 渲染与显示

- Transcript 使用轻量的圆点和缩进层次：用户消息以 `›` 开头，使用中性灰阶背景和上下留白；正文直接渲染 Markdown，以 `•` 标记消息，标题使用字重区分层级；thinking 使用灰色斜体。工具标题以 `•` 开头，结果缩进到 `└` 下方；本地命令输出和审批回执按 durable event sequence 插入。
- `◇ context` 默认显示来源和淡色 `Show details · ctrl+o`，展开后入口变为 `Hide details · ctrl+o`。`Ctrl+O` 可展开/收起保留的 context 正文；fullscreen 下也可点击标题或详情行单独切换。此设置只影响终端视图，Host 事件、实际模型上下文和导出保留原有内容。
- 流式内容直接跟随 provider：每帧显示已收到的全部 text/reasoning，`block-end` 与 `assistant/message` 立即采用完整内容，没有额外逐字动画、播放队列或 settle grace。reasoning、正文、工具卡片按 provider/event 顺序展示，可以落在同一帧。
- 执行状态独立于内容渲染：turn 开始后显示 `• Working (5s · esc to interrupt)`，使用中性圆点、清晰标题和次级时间提示；满一分钟显示 `1m 5s`，满一小时显示 `1h 2m 3s`，不补零，超过 24 小时继续累计小时。收到文本、reasoning、工具调用或 stream/end 都不视为完成。自动重试显示 `• Retrying N/M (1m 5s · CODE · automatic · esc to interrupt)`，沿用本轮累计时长；新 attempt 或恢复收流后回到 Working。断流检测、超时与重试策略归 Host/provider。
- 真正收到 turn/end 后显示 `Worked for 2m 22s · 10:49`，取消、失败、blocked 与 token limit 使用对应的结束词，错误正文继续保留。回执停止计时并保持到下一轮开始或切换/关闭会话；它是当前终端的状态，不写入 Session 历史或导出。等待、重试和完成均占固定一行，按窗口宽度截断。
- 上下文压缩使用 `• Compact context`、缩进正文和次级状态回执，区分完成、失败与中断，保留摘要和错误详情。普通选择器、审批、设置与命令补全共用 `›` 和整行蓝色选中背景；未选中的模型徽标保留语义色，选中时使用统一对比色并保留徽标文字。
- Markdown 与差异预览按当前宽度和终端颜色重新绘制；`/diff` 共用内联差异的行号和增删背景。多行输入弹窗使用 `›`、空白边界和原生编辑操作，弹窗外框继续保留。
- 显示密度可配置：`thinkingDisplay` 与 `runCodeDisplay` 均为 `hidden | compact | detailed`，见[配置](#配置)。reasoning 若以 provider 的 `<signature>` 块开头，显示层会剥掉签名与随后的换行，纯签名块不渲染 thinking 卡片；`compact` 的预览在流式时取最后一个已完成段落的首行，结束后取首行，并去掉 `**` 标记。
- PTC 的 `run_code` 卡片在 `compact` 下列出实际子调用：`skill` 显示实际技能名，如 `Skill daily-log-writer`；文件工具显示路径；bash/pwsh 优先显示实际命令及显式 workdir，多行命令用 `↵` 标记；MCP 显示服务、方法与目标，如 `MCP idea.get_file_problems src/a.ts`；`todo_write` 显示任务数量、进行中/完成数量和当前任务，不虚构文件路径。同一摘要只出现一次，长值标记截断，路径优先保留文件名；超过 10 行折叠为 `+ N more calls`，失败时保留错误首行。
- 上下文压缩：默认 preset 启用 `compaction-basic` 与 tool-result pruner。TUI 渲染 compaction start/summary/end；prune 隐藏对应 tool 卡片并保留 prune notice；session 级 tool memory 会忽略同一 callId 的晚到 / 重复 call/result，即使原始事件已离开 retained window。进程在 compaction 中途崩溃后 resume，卡片尾行显示 `⚠ interrupted` 而不是一直停在 `⟳ compacting…`。`/compact` 作为 Host command 可手动触发。
- 终端窗口标题：启动后写入 `<产品标题> · <workspace 目录名>`（OSC 0），标签页能直接看出是哪个 checkout 的会话，例如 `DeepSeek Harness · dsh-native-tui`。控制字符会被压平（BEL 会截断 OSC 序列），目录名超过 48 字符截断；只在标题变化时写入。
- 页面骨架：header 展示产品标题和 Session id，区域之间使用留白。输入框以 `›` 开头，空输入时显示 `Ask DeepSeek Harness to do anything`；提示不进入草稿或请求。面板通过终端实际背景混色，滚动时保留隐藏行数提示；执行等待/重试行位于输入框上方。输入框下方固定两行：`provider/model effort · ~/workspace · Ready · Context 42% used`，以及模式、原生权限与快捷键。字段以低对比度的 ` · ` 分隔，工作目录会将 home 简写为 `~`。
- 状态栏按终端显示列宽自适应：宽屏补充 preset、附件数与已产生的 turns/steps/tok/s/tok/cache，零值计数和未知统计不占主状态行；窄屏缩短目录和字段标签、隐藏辅助字段，优先保留模型、Ready/Working、上下文和附件提示。模式与原生权限优先于快捷键。两行均不自动折行，极窄窗口截断；放大终端会恢复被隐藏的信息，中文、emoji 和 ANSI 着色均按实际列宽计算。
- 模型名与 reasoning effort 统一使用柔和暖色，目录绿色、Ready 紫色；provider 使用次级文本；上下文与统计字段整段着色：上下文按阈值由强调蓝转黄/红，turns/steps 强调蓝、tok/s 绿色、tok 暖色、cache 紫色。推理选择控件保留 7 档颜色（off 灰 / minimal 青绿 / low 暗绿 / medium 浅蓝 / high 粉红 / xhigh 洋红 / max 红）；preset 保留紫色，附件和交互强调使用蓝色。Working、告警、危险权限和上下文阈值保留警示色；`plain` 主题不着色。
- 启动时限时查询终端前景与背景；`auto` 随实际背景选择深浅配色。支持真彩色及 256 色降级，收到迟到的颜色回复或终端主题变化通知时刷新画面，并保留工具/context 展开状态；终端不响应时继续使用回退配色。
- 上下文读 token meter 的 `contextPressure` 投影（最近一次 provider 采样 + 此后 surface 增减，包含 compaction 影响），首次 provider 采样前显示 `Context —`。接近自动压缩阈值时整段转黄色、达到阈值转红色；阈值按 `compaction-basic` 的 `thresholdRatio`、`headroomTokens` 与请求预留输出复算。`/context` 查看完整 token 数、容量、压缩阈值和构成明细。
- token 用量与 cache 命中率按 Web 口径：总量取四桶之和、部分命中不会显示成 100%，数字格式与 Web 统计 pill 一致。`tok/s` 是整段 Session 的累计 decode 速率（`decodeTokens / (decodeMs / 1000)`），不是瞬时速率，低于 10 时保留一位小数。
- 可选 `fullscreen`：TuiAltScreen + ScrollView，header/status/editor 固定，鼠标滚轮滚动、文本选择复制。向上滚动离开末尾后，输入区域上方的固定间隔行居中显示 `↓ Back to bottom · esc`，使用浅蓝文字和紧凑中性背景。点击按钮、按 `Esc` 或 `Ctrl+End` 回到最新消息并恢复自动跟随；回到末尾后恢复空白间隔。浏览历史时 Esc 保留草稿，overlay 保留自身的 Esc 操作。
- 长会话渲染优化：每个行组件按宽度缓存结果（`MemoBlock`），`maxTranscriptEntries` 默认 600 限制每帧保留的行组件数；帧间隔按上次绘制时刻对齐并按实测帧成本自适应，内容签名未变的帧跳过重绘。
- 工具卡片的动作关键字单独以主题蓝色高亮（shell 仍整条突出实际命令），路径和搜索表达式使用普通文字。标签统一句首大写（如 `Todo write`），`grep` / `glob` / `find` 显示为 `Search`，MCP 前缀使用大写缩写；服务名、方法名、命令和路径保持原样。shell 运行中为 `• Running command` / `• Running PS> command`，结束后改为 `• Ran …`，文件工具为 `• Read path` / `• Write path` / `• Edit path`，MCP 为 `• MCP service/tool`，PTC 为 `• Running code` / `• Ran code`，执行卡片不再追加 `running…` 尾行；文件工具标题不随时态变化，运行中保留 `running…`。shell 首行最多 120 字符，多行命令标记省略行数；路径与查询等标签最多 160 字符，路径保留末尾。展开后查看原命令，正文仍有安全预览上限。
- 成功的 read 默认收起，write 新建文件显示带行号的源码预览；shell 保留末尾 5 个视觉行，通用结果保留前 10 个视觉行，省略行数独立展示。工具、源码、diff、PTC 与 context 统一使用卡片底部的淡色 `Show details · ctrl+o` / `Hide details · ctrl+o`，每张卡片仅一个详情入口。折叠状态仍展示错误正文。edit 和有实际更新 diff 的 write 使用 Host 变更元数据，展示 `(+N -N)`、行号、红绿增删行和附近上下文，默认最多 24 个 diff 行；超出计算预算的变更范围用 `~` 标记估算计数，整文件替换保留删除和新增两侧样本。空文件、行尾换行不虚增行数；没有实际 diff 时不推测旧内容。`/diff` 可分页查看会话记录的 diff，仍受预览上限约束。
- 工具首行的 `•` 用颜色区分状态：黄色运行、绿色完成、红色失败、灰色停止，不额外增加完成提示行；标题保持单行，错误/停止原因继续展示，`plain` 主题不着色。write 在 Host 确认更新后可由 `Write` 改为 `Edit`。main-screen 可见执行标题立即从 `Running` 改为 `Ran`；已进入终端滚动历史的标题和圆点延后到必要的完整重绘再刷新，避免为状态变化清空历史；fullscreen 直接使用最新状态。默认 main-screen 不支持点击卡片；fullscreen 下点击卡片首行或详情行可单独展开/收起，正文点击不切换。`Ctrl+O` 在两种模式下均切换所有保留工具卡片和 context 正文。
- 审批在屏幕下方突出实际命令、原因与 cwd，所有操作带编号：方向键或编号键移动选择，Enter 才确认，Esc 取消；详情页完整展示调用参数。单次允许显示 `✓ You approved … this time`，拒绝和取消分别显示真实结果。只提供 Host 声明的操作和授权范围，原生单次审批不会增加长期授权选项。
- **main-screen 手动全局展开的代价**：视口上方的历史卡片高度变化时，pi-tui 会整屏重绘并清除终端 scrollback；Session 日志不受影响。这不属于自动结算零重绘的保证范围。只查看单次完整输出时，可使用 `/tools`、`/tool <index>` 的独立预览，避免全局重排。

### 输入与补全

- `/help`、`/init`（生成 `AGENTS.md` 贡献指南，已存在不覆盖）。
- `/` 命令、子命令和技能候选显示在输入框上方，最多八项，命令名与说明分列对齐；选中项使用 `›` 和蓝色整行高亮，plain 主题只保留前缀。↑/↓ 选择、Tab 补全，Enter 沿用原有命令执行规则；窄屏会截断长行，短屏优先保留当前选中项。普通与全屏模式共用布局，全屏支持鼠标选择。
- slash 命令支持子命令补全，例如 `/provider` 显示 add/list/edit/models/input/remove。子命令已完整输入时回车直接执行；从补全中选中时，如果当前过滤结果只包含无参数子命令则直接执行，混有带参数子命令时保持插入。
- `@file` 主机端补全（`file-reference-local`）：每行是「文件名 + 类型 · 完整路径」，与 pi agent 的文件补全一致。长路径只截断第一列的文件名，不会让所有行停在同一个公共目录前缀上。选中的路径作为普通 prompt 文本，模型需用 `read` 工具读取。
- `/` 补全在本地/宿主命令之后列出用户可调用技能，支持 `/<name>` 和 pi 风格的 `/skill:<name>`，并显示来源、调用标签与描述。输入 `/skill:` 可只筛选技能；技能与命令同名时使用 `/skill:<name>`。发送时由终端转换为 Host 的 `/<name>` 手势，交给 `dsh-tool-skill` 注入正文；输入历史保留 `/skill:<name>`，按 ↑ 回填后仍调用技能。
- `/skill` 无参数打开可搜索选择器，选中后把 `/skill:<name> ` 放进输入框，保留原有草稿并聚焦。按 Enter 调用，也可以先补充指令（`/skill:alpha-skill 把这份报告改成表格`）；选择本身不会发送请求。`/skill <name>` 直接暂存调用；`/skill list [page]` 分页查看全表（每页 15 条）；`/skill read <name>` 阅读正文。
- 列表按名称、调用标签、描述三列对齐，标签形如 `[u,m:user-agents]`——`u` 人可调用、`m` 模型可调用、两者都有才写 `u,m`；冒号后是发现来源（`project-dsh`、`user-agents` 等），包提供的技能显示包名（`bundled` 根下的 `bigpowers` 显示为 `[u:bigpowers]`）。`/skill list` **同时包含仅模型可调用的技能**，否则无法审查模型能自行调用什么；选择器只列人可调用的，模型专属技能会被宿主在注入边界拒绝，列出来等于承诺无法兑现。
- `@@<query>` 引用其他 Session；发送时 Host session-reference 自动注入快照。

### 文件、导出与预览

- `/export` 导出 Session JSONL；`/export zip` 导出含 manifest、attachments、deliverables 的 ZIP bundle；`/export html` 导出静态 HTML transcript。三种导出都以 `wx` 写入，不覆盖已有文件。
- `/open` 预览文本（16 KiB 上限），Markdown 以 pi-tui Markdown 样式分页渲染。
- `/preview` 渲染 PNG/JPEG/GIF/WebP；终端不支持时显示文本占位。
- `/files` 浏览目录并预览文件（Enter 进入目录 / 预览，Esc 退出，含 `../`）。
- `/attach` 暂存文件 / 图片 / 剪贴板图片并随下一条 prompt 发送（8 MiB 上限），`/attach preview <i>` 可内联预览，`/attachments` 打开暂存附件管理器。
- 粘贴本地图片路径或文字中的 `@图片路径` 会自动暂存为图片，在输入面板中以 `[Image #1] [Image #2]` 与文字同行展示，长路径不占用草稿。支持图片协议的终端自动显示最多两张缩略预览；窄终端标签换行，不支持预览时保留标签。支持引号、shell 转义与 `file://`；读取失败保留原文。空输入框按 Backspace 移除最后一张图片，`/attachments` 可完整预览或移除，`/attach clear` 清空。发送成功清除标签和缩略图，发送失败保留图片与文字草稿；历史用户消息也使用编号图片标签。
缩略预览沿用 pi-tui 的图片协议和格式支持；全屏模式下 pi-tui 禁用 iTerm2 图片协议，此时保留文字标签。
- `/deliverables` 列出、打开 panel、预览或用系统文件管理器定位 `present` 交付文件。
- `/changes` 查看最近一轮 workspace 变更文件与单文件 diff。
- `/tools` / `/tool <index>` 列出工具调用或分页查看完整参数与结果；`/diff [index]` 查看 write/edit 的独立 diff。三者使用相同的最近 50 次调用索引，包含原生调用和 PTC 子调用；`/diff` 无参数时打开其中最近一次有实际 diff 的调用。
- 同一轮中连续成功的文件修改汇总为 `Edited N files (+A -D)`，逐文件显示相对路径、累计增删行数和带行号的 diff；同一路径只计一个文件。默认最多预览八个文件，每文件四行；Ctrl+O 展开上下文，全屏还可点击汇总标题或 `Show details`。运行中、失败、停止、`write` 新建及缺少 diff 的调用保留独立卡片。统计来自已应用的修改片段，`~` 表示有界算法的估算；完整调用仍可用 `/tool`、`/diff` 查看。

### 扩展与集成

- 默认集成官方 `@deepseek-ai/dsh-computer-use`、`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`、`@deepseek-ai/dsh-mcp-client` 与 `mcp-resources`。
- MCP 服务配置持久化到 `mcp-manager.servers`，变更实时 reconcile，无需重启，见[MCP 服务](#mcp-服务)。
- `/plugins` 列表 / 官方市场 / 检查 / 安装 / 移除 / 启停（带确认，实时应用）。
- `/settings` 引导式 TUI 配置页与 Host 命名空间内嵌编辑器，见[配置](#配置)。

### 终端卫生

- Host / 插件日志不会覆盖画面：TUI 占用终端期间接管 `console`（与 `warnings.ts` 接管 `process.emitWarning` 同一思路），`warn`/`error` 转成 transcript notice，`log`/`info`/`debug`/`trace` 只进 `DSH_NATIVE_TUI_DEBUG=1` 的 stderr 追踪，退出时恢复原方法。
- 模型目录刷新失败（`[llm-deepseek-*] model listing … failed`）按「URL + 原因」只播报一次：宿主会按 route、按重试重放同一行，合盖休眠再唤醒时尤其集中；重复副本只进 `DSH_NATIVE_TUI_DEBUG=1` 的追踪并标注 `(repeat)`，不再多占 transcript 行。
- 非 TTY 显式失败；Ctrl+C / Ctrl+D / SIGTERM / SIGHUP 安全退出，退出后恢复终端。

## 命令

`Enter` 发送；运行中 `Enter` 作为 steer；`Ctrl+C` 取消/退出；`Ctrl+D` 退出。

| 快捷键 | 作用 |
|---|---|
| `Ctrl+O` | 展开/收起保留的工具卡片和 context 正文；main-screen 可能重绘历史并清除终端 scrollback |
| 点击工具或 context 首行 | 仅 fullscreen：切换该项的展开状态 |
| `Ctrl+N` | 打开同 workspace、preset 的空白 Session，没有匹配项时新建 |
| `Alt+S` | 打开 Session 选择器，切换时保留各自的草稿与附件 |
| `Shift+Tab` | 输入框中循环切换当前模型提供的思考强度，保留草稿；弹窗中不触发 |

### 会话与界面

| 命令 | 作用 |
|---|---|
| `/help` | 本地命令、宿主命令、按键提示 |
| `/new` | 复用当前进程访问过的同 workspace、preset 空白 Session，或新建后切换 |
| `/init` | 在当前项目生成 `AGENTS.md` 贡献指南（已存在则不覆盖） |
| `/sessions` | 列出本终端创建的 Session |
| `/resume <id>` | 恢复指定 Session |
| `/status` | Session、cwd、模型、状态、事件数 |
| `/context` | 上下文占用、压缩触发点，以及系统提示词 / 工具定义 / 对话消息的占比（三项合计等于占用） |
| `/skill [<name>\|list [page]\|read <name>]` | 选择技能并暂存调用（Enter 发送）、分页查看全表、或阅读正文 |
| `/skill:<name> [instructions]` | 调用指定技能并附带指令，不受同名命令遮蔽 |
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
| `/codex [status\|setup\|login [browser\|device]\|logout\|models [refresh]\|help]` | ChatGPT Codex 登录、路由、模型目录与额度 |
| `/codebuddy [status\|login [cn\|en\|all]\|logout [cn\|en\|all]\|models [refresh]\|quota\|checkin\|prompt [show\|reset]\|doctor]` | CodeBuddy / WorkBuddy 账号与模型 |
| `/mode [manual\|accept-edits\|plan\|auto\|off]` | 打开模式选择器或切换当前会话模式 |
| `/permissions [preset]`、`/permission [preset]` | 打开原生 DSH 权限选择器或直接切换 permission preset；`/mode` 单独选择交互模式 |

### 交互模式

新会话默认 **off**（原生 `workspace-write` 权限）；显式的 `DSH_PERMISSION_MODE` 或 profile 默认权限配置优先，恢复会话沿用 Host 中已保存的权限和规划状态。输入框下方显示当前模式，`/mode` 打开选择器。Shift+Tab 仍切换思考强度，不用于切换权限。

| 模式 | 行为 |
|---|---|
| `off` | 完全使用 DSH 原生 permission，不叠加 TUI 的工具审批、Plan guard 或 Auto 审核 |
| `manual` | 文件 sandbox 为 read-only；写操作通过 Host 的一次性扩大范围请求审批，其他非只读工具逐次询问 |
| `accept-edits` | 文件 sandbox 为 workspace-write；工作区 `write`/`edit` 自动执行，超出文件范围仍需审批；shell、未知 MCP 等非只读工具逐次询问 |
| `plan` | 启用 Host 规划提示词和 read-only 文件 sandbox；guard 拒绝写入、shell、委派和未知 MCP 调用，只开放已知读取、搜索、提问和计划审核工具 |
| `auto` | EXP：使用当前 Agent 模型逐次审核受控工具调用，并以 Full access 执行获准调用；拒绝时询问用户，审核失败则不执行 |

使用 `/mode manual`、`/mode accept-edits`、`/mode plan`、`/mode auto` 或 `/mode off` 直接选择。模式切换仅允许在当前 turn 空闲时进行。选择 Auto 必须额外确认风险，不会把 Auto 保存为新会话默认值；原始 `danger-full-access` preset 不显示为 Auto。

`minimal` 使用持久 shell，不提供 Plan。若活动终端阻止 `/mode` 或 `/permissions` 改变 sandbox，TUI 会先询问是否重建当前 Agent：默认取消；确认后等待旧 Agent 清理，再恢复同一 Session 并重试切换。会话历史保留，但 shell 的当前目录、环境变量等状态会丢失，Agent 所属后台工作也可能停止。取消时保留原权限，清理或恢复失败时不报告切换成功。

`/mode off` 退出 TUI 规划状态，恢复最近一次原生 permission preset；没有原生选择记录时使用 profile 的原生默认 preset，若默认值也是 TUI 模式则使用 `workspace-write`。原生 preset（包括高级 `/permissions <preset>` 选择）显示为 `off`，其 sandbox 和 approval 仍由 DSH 执行；`off` 不代表无限权限。状态栏在 `off` 旁显示 `permission <preset>`，随权限切换和会话恢复更新。原生 preset 已不可用时切换失败，不会自动扩大权限。

Plan 保留工具目录，用策略和最终 guard 限制受控调用；`exit_plan_mode` 展示完整计划，用户选择继续规划时保持限制，批准后从下一 step 恢复进入 Plan 前的权限。若原 reviewer/preset 已不可用，保留 Plan 限制，用户需要显式选择可用模式。Plan 中不能用高级 `/permissions` 绕过限制。

这些模式复用 DSH Host 的权限语义，并非 Claude Code 权限引擎的完整替代。PTC 内层 `tools.*` 调用接受相同 guard 和 Auto 审核；外层程序仍由 Host 文件 sandbox 约束，但任意 Node 网络副作用不属于完整逐调用审核边界。Auto 可能误判并消耗额外模型 tokens；需要严格的外部副作用隔离时，应另用受限 profile、容器或专用工具策略，不能仅依赖交互模式。

### 环境与扩展

| 命令 | 作用 |
|---|---|
| `/mcp [add\|list\|remove <name>]` | 配置、查看或删除 MCP 服务 |
| `/plugins [list\|market [query]\|inspect <spec>\|install <spec>\|remove <bundle>\|versions <bundle>\|update <bundle> [version]\|enable <entryId>\|disable <entryId>]` | 管理 bundle 与插件项；registry 第三方 bundle 可查询并确认更新，link/tgz 安装不支持此更新入口 |
| `/workspaces [new <path>\|use <id\|path>\|pin\|unpin\|archive\|unarchive]` | 列出/创建/切换/固定/归档 workspace 会话 |
| `/schedule [list [offset] [all\|active\|inactive]\|add <seconds> <title>\|create [JSON]\|view\|edit\|pause\|resume\|run\|delete\|history <id>]` | 宿主全部任务的分页、创建、编辑、暂停/恢复、立即投递、删除和历史；新任务默认投递到当前 Session |
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
    runCodeDisplay: detailed      # hidden 隐藏代码执行；compact/detailed 选择 PTC 预览，shell 输出默认保留末尾 5 行
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
  - PTC 的 `run_code` 改为列出程序实际派发的子调用（`read src/a.ts`、`bash <description>`、MCP 显示服务名 `mcp idea`），文件编辑子调用走独立的文件修改展示，相邻成功修改可汇总为一个文件列表。
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
| `/codex models refresh` | 从账号目录拉取全量模型，预览缺失项后写入显式列表（未登录、过期、网络失败都不写入） |

- 路由的 `models: []` 表示使用 pi-ai 原生目录，不覆盖模型列表。
- `/codex models refresh` 写入的是**显式列表**：之后 pi-ai 新增的模型不会再自动出现，需要再次 refresh。宿主无法表达 `ultra` 推理等级，预览会把它单列为被省略的等级。
- 凭据由 pi-ai 经 DSH 凭据 seam 写入共享的 `~/.dsh/.credentials.yaml`，key 为 `llm-pi-ai/openai-codex`，**跨 profile 共享**：登出会影响其他 profile。
- 若路由配置了 `apiKeyEnv`，OAuth 会静默失效；`setup` 会检测并拒绝这种冲突。
- 登录方式：`browser` 监听 `localhost:1455` 接回调；端口被 Codex CLI 占用时回退为粘贴回调 URL，也可手动粘贴授权码。`device` 走 device code（有效期 15 分钟）。
- 额度来自 `GET https://chatgpt.com/backend-api/wham/usage`，按窗口时长识别（5 小时 = 18000 秒，周 = 604800 秒），不依赖 primary/secondary 顺序。

## 任务与文件防护

`/schedule` 管理宿主全部任务，不只当前 Session。

- `/schedule add 300 检查构建` 保留一次性提醒用法，明确投递到当前 Session。
- `/schedule create` 打开 JSON 编辑器；可填写 `after`、`at`、`every`、`daily`、`weekly`、`cron` 或 `rrule` timing，以及 `session`、`new_once` 或 `new` target。`daily`、`weekly`、`cron` 必须填写明确的 `time_zone`。
- `/schedule edit <id>` 只提交填写的字段；省略的 `timing` 与 `target` 保持原值。冲突会提示重新读取，不覆盖其他编辑。
- `/schedule run <id>` 和删除均需确认。history 中的记录表示持久投递成功，不等于模型任务完成。

Schedule 新存储格式不支持旧程序直接打开。正式升级前备份 DSH 数据；降级需恢复升级前备份。

本 bundle 显式启用先读后写和外部修改检查，不随 rc.1 的核心默认值改变。profile 的后续 patch 仍可覆盖。多文件补丁默认关闭，可在启动前设 `DSH_NATIVE_TUI_APPLY_PATCH=1` 为各 preset 启用核心 `apply_patch`；它仍受观察策略与文件沙箱约束。停止或部分失败时，卡片保留已完成 diff 和原始诊断，不承诺回滚。

插件安装显示本次操作的日志、失败阶段、原始诊断和完整日志路径；更新后是否即时生效、是否需要 /reload，以及旧版本恢复结果，都以 Host 返回为准。

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

可在 `/settings edit codebuddy` 中设置正整数 `maxRequestImages`，限制每次请求保留的图片出现次数（同一附件重复出现也分别计数）。未设置时仍只使用原有字节预算；超限通过 Host 图片卸载与重试处理，不会直接丢弃当前图片。该设置重载插件后生效。

### 系统提示词与指纹校验

国内网关会做客户端指纹校验：系统提示里出现第三方 agent 的原文措辞，会返回 HTTP 400 `code 11128`（`Illegal API invocation from an unapproved channel`）。`codebuddy` 路由在发送前把已测到的指纹片段改写为中性表述——无论提示放在 `system` 字段还是 in-history 的 system 消息里（TUI 走后者）——其余提示（工具说明、工作区规则、用户指令）逐字保留。国际版不做该校验。

校验只针对系统提示：同一段文字出现在 user 消息或工具结果里不会被拦。匹配的是原文措辞而不是语义——换一种说法、调整语序或替换个别词都能通过，所以命中范围很小：

| 版本 | 被拦片段 | 发送时的改写 |
| --- | --- | --- |
| 2026-10-20 | 开场身份句 `You are an AI agent powered by …` 整行 | `You are a software engineering assistant.` |
| 2026-10-28 | `Tokens prefixed with @ are paths the user explicitly referenced.`（所在段落的首句） | `Tokens starting with @ name paths the user referenced.` |

清单在 `src/codebuddy/prompt.ts` 的 `RESTATEMENTS`，只放真实实测被拒的片段；新增一条前先用真实账号确认「只改这一处就能通过」。

需要整体调整发往 CodeBuddy 的系统提示时，用 `/codebuddy prompt`：

- **Add / Edit the custom template** 打开多行编辑器（Enter 保存，Shift+Enter 或 Ctrl+J 换行）。模板含 `{prompt}` 时，harness 当次组装的系统提示会在该位置展开，只展开一次；不含占位符则整段替换。
- **Use the default prompt** 删除自定义模板，回到内置的指纹片段改写。
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
/mcp reload [name]
/mcp remove <name>
~~~

`/mcp add` 支持：

- `stdio`：command、args（空格分隔或 JSON 数组）、env JSON；args/env 留空表示无参数、无额外环境变量。
- `streamable-http`：URL、headers JSON。

配置写入 profile 的 `mcp-manager.servers`。mcp-manager 把每个条目映射为官方 `mcp-client` Loader row，并在 Loader fiber 激活后记录状态；settings 变更会实时 reconcile 这组 row，因此新增、修改、删除服务都无需重启 TUI。

`/mcp list` 每行显示 `connected` / `starting` / `error: ...` / `disconnected: ...` / `not loaded`。mcp-manager 使用 `failOnStartupError` 并 await fiber，初始连接失败会显示错误而不是静默成功。

mcp-manager 自己拥有断线判定与重建，因为 mcp-client 只通过传输 close 信号发现断线，而 Streamable HTTP 传输在服务端重启后不会发出该信号——工具一直保持注册，每次调用都以连接错误失败。因此：

- **工具调用是健康信号**：某次调用以连接类错误失败即标记 `disconnected` 并自动重建该服务的 row；调用成功则清除退避预算。判定以 SDK 的 `ConnectionClosed` 错误码为准，其次才匹配 `Connection closed`、`server is disconnected`、`fetch failed`、`socket hang up`、`ECONNRESET` 等传输层固定文案；工具自身输出里出现 `terminated`、`not connected` 之类的业务措辞不会被当成断线。
- **工具注销仍会被识别**：mcp-client 放弃重连后注销工具，manager 通过 `tools/change` 观测到并同样进入重建。
- **已判定故障的服务不会被 `tools/change` 翻回 `connected`**：故障 row 在重建前一直保留旧的工具注册，只有调用成功或重建成功才清除故障标记。这条保证任何一次不相关的工具注册变化都不会把断开的服务显示成已连接。
- **重建使用 500 ms 起、上限 30 s、最多 5 次的指数退避**；用尽后状态停在 `disconnected` 并提示 `/mcp reload <name>`。正常重启场景下首次重试即恢复（约 500 ms）。

`/mcp reload [name]` 是手动重建入口：不带参数重建全部服务，带参数只重建一个，并立即显示重建后的状态。它和自动重建走同一条 Loader 路径，但**总是把退避预算重置为 0**，因此是退避耗尽后唯一的恢复方式。重建以当前 settings 快照为准且只读，不会改写 `mcp-manager.servers`；对未配置的服务名会直接报错而不是静默忽略。

新增或修改配置后 mcp-manager 立即装载（`/mcp list` 会短暂显示 `not loaded` / `starting`），无需重启。MCP tools 以 `mcp__<serverName>__<toolName>` 暴露。

## 开发与验证

### 门禁

~~~sh
pnpm check      # typecheck + 单元测试 + build
pnpm test
pnpm test:watch
pnpm build      # tsc -p tsconfig.build.json → dist/（gitignored）
~~~

测试文件与用例数量以 `pnpm test` 当次输出为准。代码风格见仓库根目录 `AGENTS.md`：TypeScript ESM（NodeNext），两空格缩进、单引号、无分号，单个源文件不超过 1000 行。

### 真实 Host 探针

开发环境无法创建 PTY，因此用 fake TTY 包装器跑真实 Host。`scripts/` 下约有 100 个 `fake-tty-*.mjs` 探针，每个验证一类用户可见行为；它们都会打印 `EXIT ... pass true/false` 与抓取到的终端输出。

多数探针需要 disposable `DSH_HOME`，首次要先把当前构建装进该 home：

~~~sh
pnpm build
pnpm pack --pack-destination .tmp
DSH_HOME=/tmp/dsh-native-tui-approval-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.2-rc.1.tgz
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
node scripts/fake-tty-context.mjs            # /context 占用、占比图与三个分项（自建 mock provider）
node scripts/fake-tty-skills.mjs             # /skill 列表、分页、标签、选择过滤与真实调用链路（自建临时 workspace 与技能）
node scripts/fake-tty-reasoning-cycle.mjs    # Shift+Tab 编码、连按、草稿、弹窗及 level → wire 映射（自建临时 profile 与 mock provider）
node scripts/fake-tty-interaction-modes.mjs native # 五模式、真实文件效果、原生 permission、plan 审核和 Auto 审核（自建临时 profile）
node scripts/fake-tty-interaction-modes.mjs ptc    # 相同边界的 PTC 内层链路；需要宿主允许创建子进程 sandbox
node scripts/fake-tty-tool-details.mjs             # 显式 accept-edits 下的真实 PTC 卡片及审批详情；使用隔离 profile、本地 MCP 命名 fixture 和 mock provider
node scripts/fake-tty-write-update-diff.mjs        # 原生/PTC × 普通/全屏：write 更新 diff、空文件插入、新建预览与 /diff 最新/索引查看
node scripts/fake-tty-tool-keywords.mjs            # 原生/PTC × 普通/全屏 × 深浅/宽窄：Read/Search 关键字高亮范围、大小写和真实工具结果；PTC 组需要可用的内层 sandbox
node scripts/fake-tty-slash-autocomplete.mjs       # 普通/全屏 × 100/50 列：向上命令补全、整行选中、键盘、子命令、输入框位置及全屏鼠标
node scripts/fake-tty-permission-restart.mjs       # minimal 同会话 Agent 重建、取消及权限恢复；使用终端 fence fixture，不依赖物理 PTY
~~~

升级核心时，`scripts/upgrade-core-e2e.mjs` 要求 `DSH_CLI_ENTRY` 指向已安装的 `0.2.2-rc.1` CLI 的 `lib/bin.js`；探针使用独立的 `.tmp/upgrade-core-*` profile 和本地 mock provider，保留输出证据。通用 fake-TTY 入口同样支持该变量，不设置时仍使用既有全局安装路径。`scripts/rc1-capabilities-e2e.mjs` 使用同一变量，验证 Schedule 宿主级管理、补丁默认关闭、原生/PTC 显式启用、未读编辑拒绝，以及多文件增删移动的真实磁盘效果。

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

- DSH 依赖统一为 `0.2.2-rc.1`，Cordis 为 `4.1.0`；使用隔离安装的目标 CLI 通过四套预设的新建、恢复、模型路由及 reload 探针，不依赖全局 CLI 版本。旧核心不在本版本支持范围。
- Preset patch 从 `@deepseek-ai/dsh-web-app` 的 standard/ptc/minimal/cordis 复制而来：standard/ptc/minimal 需要 `subagent-model-selection-settings` Host 行，cordis 需要 cordis host-runner 与 `tool-cordis/host`。
- `@file` 补全依赖 `@deepseek-ai/dsh-file-reference-local`。
- pi-tui 1.4.0；Node `>=24.9.0`。

## License

[MIT](LICENSE)。package 仍为 private。
