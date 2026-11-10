# 对齐 Codex CLI 的终端渲染风格

日期：2026-11-10；状态：已实施

## 目标与现状

延续现有工具列表、diff、流式 Markdown、双行状态和图片标签，将本插件的整体视觉层次向 Codex CLI 靠拢。当前用户消息使用青色整行背景，输入区域叠加状态分隔线和编辑器上下边框，标题与常驻状态有较多装饰色；Host 注入的 context 正文占用大量对话空间。

参考本机 `codex-cli 0.167.0` 对应的官方源码：

- [语义样式与灰阶表面](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/style.rs)：用户消息、输入表面使用中性背景，选中项和状态使用有限的强调色。
- [消息历史](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/history_cell/messages.rs)：用户消息使用 `›`、缩进及上下留白，assistant 正文与活动输出保留轻量层次。
- [输入区域](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/bottom_pane/chat_composer.rs)：输入与状态、快捷提示分层，补全位于输入上方。

## 实施方案

1. 用户消息改用中性灰阶背景和上下留白；去除轮次间重复横线。保留 assistant 圆点、淡色 reasoning、工具树形缩进、diff 和代码高亮。
2. 输入框使用 `›` 与低对比度背景面板，以留白代替横线；保留原生三行几何、滚动行数提示、光标、鼠标映射及原生补全。图片标签仍独立显示。应用顶栏、输入前的装饰分隔线改为留白。
3. 标题去掉装饰图标；provider、目录和空闲状态使用弱化文字，模型保持加粗，推理级别保留既有颜色。强调色使用适配深浅主题的蓝色；warning、error、危险权限和上下文阈值继续保留语义配色。Markdown 标题以字重建立层次。
4. context 行默认仅展示来源标签和展开提示；点击标题或 Ctrl+O 展开既有正文。复用原有工具展开入口与缓存，展开状态在普通流式更新后保留。仅改变视图，原始事件、模型上下文、导出和权限不变。
5. 同步受输入提示符、边框和颜色变化影响的测试及 fake-TTY 探针。保留 plain 模式无 ANSI、深浅主题、宽窄终端、main-screen 与 fullscreen。

## 影响范围与约束

主题、输入编辑器、应用布局、状态行、transcript 渲染和缓存包装，新增 context 视图组件。每个源码文件不超过 1000 行。不新增运行时依赖，不改变 Host 事件折叠和工具行为，不自动提交或安装插件。

## 验证与验收

- 单元测试验证灰阶背景、提示符不进入正文、保留光标和补全坐标、context 展开及缓存、正文顺序、危险状态颜色与窄屏宽度。
- `pnpm check` 类型检查、测试与构建通过。
- 运行真实 Host + 本地 mock 的状态栏、补全、工具审批与 diff、图片输入探针，覆盖主屏/全屏和宽窄终端，检查行宽溢出、状态与输入位置、权限选择和实际图片请求。
- 通过渲染帧记录确认输入区域无重复横线、用户灰阶背景、淡色常驻状态、context 折叠/展开及完整用户可见答案。记录实际验证边界。

## 实施与验证记录

- 用户表面采用深色 238 / 浅色 255 的中性背景，编辑面板采用深色 236 / 浅色 255；保留 terminal 默认前景。输入区以原生上下两行作为留白，隐藏行数和硬件光标位置保留。
- 新增 `ContextMessage`，默认单行，点击和 Ctrl+O 均能切换正文；`MemoBlock` 失效相应行缓存，后续普通事件追加复用已有展开状态。
- `pnpm check` 通过：104 个测试文件 / 1510 项测试，类型检查与构建成功。新增 8 项 context 行为测试、3 项编辑面板测试和 2 项用户消息样式测试；原有语义和交互断言同步更新。
- `node scripts/fake-tty-statusline.mjs`：4 组 PASS（main-screen/fullscreen × 160 列 dark / 60 列 light）。检查面板背景、留白、弱化 Ready、context 正文展开/收起、两行状态位置和行宽。
- `node scripts/fake-tty-slash-autocomplete.mjs`：4 组 PASS（main-screen/fullscreen × 100/50 列）。检查蓝色选中项、键盘、子命令、Escape、fullscreen 鼠标与 footer 定位；本地命令未调用模型。
- `node scripts/fake-tty-transcript-presentation.mjs`：6 组 PASS，覆盖普通工具允许/拒绝、PTC compact/detailed、write/edit diff、thinking、审批与输出展开。context 展开后按实际可见帧翻页定位工具源码。
- `node scripts/fake-tty-image-input.mjs`：2 组 PASS，主屏/全屏编号标签、移除/清空与原始 PNG 请求内容正常，无行宽溢出。
- 8 个修改后的探针脚本语法检查与 `git diff --check` 通过。其余历史探针未逐一执行。
- 集成探针使用隔离临时 profile、真实 Host 与本地 mock；端口监听经授权在沙箱外执行。未接入外部模型，不代表物理终端、系统截图或平台图片协议的人工视觉验收。

## 第二轮：按实际截图修正（2026-11-10）

用户提供了同机 Codex CLI 与本插件截图。第一轮固定灰色面板没有保留终端背景的色相；SGR dim 使目录和常驻状态过暗；空输入缺少 placeholder。已有探针主要验证几何和交互，没有模拟截图的前景、背景和长模型名。

修正方案：

- 使用 pi-tui 已有 `queryTerminalColors` 读取终端前景/背景，启动查询限时，未响应使用现有回退；晚到的颜色回复也应用。`auto` 根据实际背景判定深浅主题，混合生成面板背景和次级文本颜色，并遵循终端色深。面板采用 Codex CLI 的背景混合方式，终端主题色不再被纯灰覆盖。
- 保持 Palette 样式函数引用稳定，收到颜色后刷新已有渲染缓存并保留工具/context 的展开状态。关闭后忽略迟到回复，控制序列不进入编辑框。
- 模型和 effort 统一为柔和暖色，目录使用绿色、Ready 使用紫色；错误、危险权限与上下文告警仍使用已有语义。未产生的 turns/steps/tok 等统计不占主状态行，已产生的上下文与统计字段整段着色，按类别使用强调蓝、绿色、暖色和紫色。保留所有实际权限信息，不补造分支、任务标题或账户额度。
- 空输入显示 `Ask DeepSeek Harness to do anything` 的次级提示，不写入草稿、不影响硬件光标、提交、补全与图片附件。输入后立即消失。
- 增加按截图终端背景和前景响应的真实 Host 探针，覆盖深浅主题、颜色超时与晚到、长模型和目录、placeholder、光标、鼠标、换行及 resize。记录实际生成的色值与渲染帧，再运行相关回归。

第二轮验证：

- 只读解析用户截图的 PNG 像素：Codex 主背景 `40,41,54`、输入面板 `65,66,78`；本插件主背景 `40,42,54`、固定输入面板 `48,48,48`。使用本插件截图的背景按 12% 白色混合，当前实际输出 `48;2;65;67;78`，保留终端背景色相。
- `pnpm check` 通过：105 个文件 / 1526 项测试，类型检查与构建成功。新增终端颜色、迟到/过期回复、plain 与色深回退、缓存重绘保留展开状态、placeholder 光标/提交/鼠标与窄屏验证。
- 4 组状态栏探针改为 `auto`，用真实 OSC 10/11 和 DA1 回复模拟截图终端与浅色终端，使用 `deepseek/deepseek-v4.1-flash` 长模型名。主屏/全屏 160 列深色输出 `48;2;65;67;78`，60 列浅色在 250 ms 迟到回复后输出 `48;2;244;244;244`；placeholder、Ready 配色、未知用量省略、context 展开与列宽全部通过。
- 同步复验补全 4 组、工具/审批/PTC 6 组、图片输入 2 组，共 16 组全部 PASS。颜色回复未进入草稿，图片请求仍包含原始 PNG 字节。
- 集成探针模拟终端协议并检查实际渲染帧；本机窗口重新加载后的物理视觉效果未由这些探针替代验收。

## 审查遗漏修复

目标：补齐预览主题刷新、语义颜色、选择行、压缩状态和多行编辑五类遗漏。

- 分页器持有组件而非预着色字符串；Markdown 按当前可用宽度和 Palette 重新绘制，主题切换和 resize 后保留有效滚动位置。标题、提示和图片关闭提示也在绘制时着色。
- `/diff` 复用内联 diff 的行号、增删背景与安全文本处理，通过组件分页；普通文本分页继续清理外部控制序列。模型徽标使用文本和语义 tone 数据，在选择器内安全着色，支持筛选和目录热更新。
- 原生 SelectList 与 SettingsList 保留键盘、筛选、滚动和子菜单逻辑，复用整行蓝底、`›` 标记及次级描述。所选模型徽标保留文字，未选中时显示语义色，避免覆盖选中行的对比色。
- 压缩标题和内容采用轻量圆点与缩进；运行状态和完成、失败、中断回执复用轮次状态的视觉规则，保留 Host 状态与错误信息，不推算历史耗时。
- 多行弹窗复用 PromptEditor 的提示符、空白边界、原生编辑与粘贴逻辑，保留弹窗外框、提交和取消行为。

验证：为主题晚到/切换及 resize、真实 `/diff` 命令渲染、模型徽标与控制序列清理、选择行及设置子菜单、压缩各状态、多行输入提交/换行/取消增加持久回归；运行定向测试、`pnpm check` 和相关真实 Host fake-TTY 探针。保留本轮之前的工作区改动，不自动提交。

修复验证记录：

- 新增 21 项回归，覆盖以上五类遗漏；工具命令测试直接驱动真实分页组件，避免只检查交给分页器之前的字符串。
- `pnpm check` 通过：108 个测试文件 / 1560 项测试，类型检查与构建成功；定向测试 13 个文件 / 268 项通过。
- `node scripts/fake-tty-write-update-diff.mjs` 四组 PASS（原生/PTC × 主屏/全屏），检查独立 `/diff` 最新与索引入口的真实红绿背景和行号。
- `node scripts/fake-tty-slash-autocomplete.mjs` 四组 PASS（主屏/全屏 × 100/50 列），新增模型与设置的选中背景、Markdown 预览着色检查；按实际弹窗帧与关闭状态同步后再验证退出，未调用模型。
- `node scripts/fake-tty-transcript-presentation.mjs` 六组 PASS，覆盖工具、审批允许/拒绝、PTC 和主屏/全屏；所测帧无行宽溢出。回环监听在沙箱内被拒绝后，通过授权在沙箱外运行本地 mock，未连接外部模型。
- 深浅主题切换与多行编辑由组件回归覆盖；物理终端窗口的视觉验收未由探针替代。

## 工具动作关键字高亮与大小写（2026-11-10）

目标：按用户提供的 Codex CLI 截图，将动作关键字与目标内容分开渲染。当前普通工具标题只加粗动作、强调路径，PTC compact 子调用整行弱化，多词工具标签仍用下划线连接（如 `Todo_write`）。

实施方案：

- 在 `tool-label.ts` 集中处理展示名称和关键字配色。动作使用主题已有的蓝色强调，路径、搜索表达式和 MCP 服务/方法保持普通文字；保留树形引导线、展开提示与状态圆点各自的语义颜色。
- 文件操作显示 `Read` / `Write` / `Edit`，`grep` / `glob` / `find` 统一显示 `Search`；多词动作使用句首大写（例如 `Todo write`、`Web search`、`Job output`）。MCP 保持缩写大写，服务名和方法名保留原始大小写。
- 普通工具、write/source 分支、write/update diff 分支、PTC compact 子调用复用相同的关键字格式。PTC 代码执行标题使用 `code` 关键字（按下一节显示 `Running code` / `Ran code`），shell 保留时态摘要前缀并继续突出实际命令。
- 仅改变视图，不改原始工具名、PTC callLines、参数、事件、工具执行、审批或导出。控制序列先转义再添加受控样式，plain 不输出 ANSI。

验证与验收：

- 回归检查动作关键字实际 ANSI、目标不被染色、深浅/plain 主题、MCP 方法与路径大小写、native/PTC、展开/收起、write/create 与 update、多词名称、窄屏和控制序列安全。
- 执行定向测试和 `pnpm check`；真实 Host + 本地 mock 探针检查主屏/全屏、native/PTC 和宽窄终端的实际渲染帧，断言高亮范围、标签、执行结果与行宽。记录实际验证边界。

实施与验证记录：

- 普通工具和 PTC compact 子调用的动作使用同一个配色入口，MCP 仅高亮缩写；PTC 标题使用 `code` 关键字（`Running code` / `Ran code`）。保留自定义工具名的连字符及 MCP 方法大小写，原始记录不变。
- 新增 15 项回归，覆盖深浅/plain 实际 ANSI、原生/source/diff 分支、PTC、展开、控制序列和 1/12/32/80 列宽。定向测试 7 个文件 / 227 项通过；最终 `pnpm check` 通过 108 个文件 / 1575 项测试，类型检查与构建成功。
- `node scripts/fake-tty-tool-keywords.mjs`：8 组 PASS（原生/PTC × 主屏/全屏 × 100 列 dark / 50 列 light），实际帧中 Read/Search 关键字着色、目标不着色；真实 read/grep/glob 结果包含测试文件且无错误、无行宽溢出。
- `node scripts/fake-tty-transcript-presentation.mjs`：6 组 PASS，覆盖原生审批允许/拒绝、write/edit diff、源码展开、PTC compact/detailed 与主屏/全屏。
- 6 个新增或同步的探针脚本语法检查与 `git diff --check` 通过。Host 探针使用本地 mock，回环监听在沙箱内被拒绝后经授权运行；未连接外部模型，物理终端视觉效果仍需实际窗口确认。

## 执行标题随状态切换（2026-11-10）

目标：执行类工具运行中显示 `Running`，结束后显示 `Ran`，由标题承担时态提示，取消执行卡片末尾重复的 `running…`。

实施方案与约束：

- `bash` / `pwsh` 的标题分别显示 `Running command` / `Running PS> command`，结束后改为 `Ran …`。PTC 父卡片使用 `Running code` / `Ran code`，保留代码描述、子调用摘要、展开与高亮。
- `pending` 为状态依据；结束后的成功、失败、中断都使用过去式，圆点颜色和错误/中断正文继续标明实际结果。仅移除执行类卡片的 `running…` 尾行，文件工具保持原有动作名称与状态提示。
- 主屏可见标题立即更新。终端已滚出的行不能原地修改；在 `TranscriptMainScreen` 中仅延迟同一标题 `Running` → `Ran` 的屏外变化，避免清除终端历史，窗口尺寸变化等正常完整重绘后显示最新状态。命令正文、链接目标等实际内容变化仍遵循原有重绘。
- 更新旧有固定标题断言，新增运行/部分结果/成功/失败/中断、主屏/全屏、compact/detailed、展开保持和屏外安全回归。文档记录主屏屏外行的实际边界。
- 本节替换 [工具、审批和对话展示](design-task-optimize-transcript-presentation.md) 中「工具标题文字不随状态改写」与「文本变化不属于延后规则」两条约束；旧文档保留原决策并记录替代原因。

验证：定向测试、`pnpm check`，真实 Host 本地 mock 探针分别捕获 Running 和 Ran 帧，确认执行卡片无重复 running 尾行、审批与结果保留、无行宽溢出及不必要的历史清除。

实施与验证记录：

- 新增 18 项回归，覆盖三类执行工具在深浅/plain、compact/detailed、展开/收起、部分输出与空结果下的时态变化，以及缓存组件复用、失败/中断和窄屏；主屏 32/100 列验证可见标题立即更新、屏外延迟、resize 后更新及保留历史。
- 屏外比较仅允许同一正文的 `Running` → `Ran`；命令内容和链接目标变化的回归仍要求正常重绘。转交 pi-tui 的行保持原始未归一化形式，避免重复行尾 reset 引发整屏重绘。
- `pnpm check` 通过：109 个测试文件 / 1593 项测试，类型检查和构建成功。独立定向检查 3 个文件 / 66 项通过。
- `node scripts/fake-tty-transcript-presentation.mjs`：6 组 PASS，分别捕获黄色 Running 和绿色/红色 Ran 帧，执行卡片无重复 running 尾行；允许/拒绝、PTC compact/detailed、write/edit diff 和源码展开正常，主屏结算未清除终端历史。
- `node scripts/fake-tty-tool-keywords.mjs`：8 组 PASS，覆盖原生/PTC × 主屏/全屏 × 100 列 dark / 50 列 light；关键字高亮、PTC Ran 标题、真实工具结果与列宽正常。
- 复验边界：该探针的 PTC 组需要可用的内层 sandbox；在 DSH 沙箱内复跑时 `run_code` 报 `sandbox-unavailable`（`sandbox-exec: sandbox_apply: Operation not permitted`），standard 4 组仍 PASS，PTC 组需在沙箱外执行。
- 5 个同步探针语法检查及 `git diff --check` 通过。探针使用已授权的本地 mock 与真实 Host；终端滚动历史内的旧标题按上述边界延迟到重绘更新，未做物理终端窗口的人工验收。

## 状态行字段高亮（2026-11-10）

目标：状态行右半段的 `Context`、turns/steps/tok/s/tok、cache 此前统一使用次级文本，与左侧 model、目录、Ready、preset 的语义配色不协调。按 Codex CLI 的做法整段着色，同时保留上下文阈值的警示语义。

实施：

- 参考 Codex CLI `codex-rs/tui/src/bottom_pane/status_line_style.rs`：每个 `StatusLineItem` 按用途归到 Model/Path/Branch/State/Usage/Limit 等 accent，整段文本着色，`STATUS_LINE_SEPARATOR` 保持次级文本。本实现按 usage 子类分配：上下文与 turns/steps 用蓝，`tok/s` 用绿，`tok` 用暖色，`cache` 用紫色。
- `Palette.context` 的健康区间由 `dim` 改为 `accent`，接近/达到自动压缩阈值时整段转 warning/error。
- `Context N% used` 与窄屏 `ctx N%` 整段着色，标签和数值同色；空值 `Context —` 仍为次级文本。
- turns/steps 使用 accent，`tok/s` 使用 success 绿，`tok` 使用 model 暖色，`cache` 使用 preset 紫；全部整段着色，不拆分值与单位。
- 只改变视图，`plain` 主题仍不输出 ANSI；窄屏压缩和裁剪按去除 ANSI 的可见宽度计算。

验证：

- `tests/status-line.spec.ts` 断言上下文与统计字段在健康/告警/阈值三档的实际 ANSI、字段整体着色、分隔符保持 dim，以及深浅主题下四类 accent 的分配；`tests/theme.spec.ts` 更新健康区间断言。`pnpm check` 通过：109 个测试文件 / 1595 项测试，类型检查与构建成功。
- `node scripts/fake-tty-statusline.mjs` 四组 PASS（主屏/全屏 × 160/60 列，深/浅主题），真实帧确认 `Context N% used` 与 turns 使用 accent、`tok/s` 使用 success、`cache` 使用 preset，状态行文本、宽窄布局、权限和失败/取消回执不变。
