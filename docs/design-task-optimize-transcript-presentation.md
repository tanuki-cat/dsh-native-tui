# 优化工具、审批和对话展示

## 目标与范围

参考用户提供的 Codex CLI 截图，将工具调用、审批、diff、edit、write、thinking 和正文统一为轻量的终端信息层次。延续已完成的双行状态栏。仅调整终端展示，不改变工具执行、权限判定、事件顺序或数据持久化。

## 改造前的链路

- `transcript.ts` / `transcript-stream.ts` 按 Host 事件归并数据；`TranscriptRenderer` 保留组件身份、插入本地 notice 并缓存已完成内容。
- `ToolCard`、`write-card.ts`、`edit-card.ts`、`code-execution-card.ts` 展示原生和 PTC 工具；目前主要使用整块背景、重复标签和独立状态尾行。
- `AssistantMessage` 增量渲染 Markdown / reasoning，但总会添加 assistant 标题；详细 reasoning 使用背景块。
- `showApproval` 与 `showPermissionQuestion` 使用通用选择框，完整参数由独立详情页展示。原生审批只提供单次允许；permission question 的长期允许由 Host intent 声明。

## 实现方案

1. 新增共享的轻量工具标题、缩进输出组件。工具首行以 `•` 和操作/命令摘要开头，输出使用 `└` 与后续缩进，取消整块工具背景和输出前的空白行。保留 workdir、timeout、sandbox 等会影响调用含义的选项。
2. shell 默认显示末尾少量输出与明确的折叠提示，通用/MCP 输出同样有界；Ctrl+O 和 fullscreen 单卡点击继续展开。错误、停止和部分执行结果保持可见。
3. edit 使用 Host before/after 数据渲染真实 diff，增加增删统计，行号与 `+` / `-` 对齐，增删行使用柔和背景和文字色。大文件仍受既有计算/预览上限保护，包含两侧样本，展开不承诺突破安全上限。
4. write 使用编号源码预览，不重复显示成功结果；仍按原来的源码预览上限展开，并明确区分请求内容与成功落盘的证据。工具标题文字和尺寸不随 pending/success/error 改写。
5. thinking 使用灰色斜体与缩进，移除整块背景；compact 保留摘要，detailed 保留全部已接收内容，hidden 仍隐藏。正文直接渲染 Markdown，以轻量圆点/缩进区分消息，不再重复显示 `assistant` 标签。保持增量叶子缓存，live 到 durable 不改变相同内容的布局。
6. 审批使用专用、编号的操作选择界面，分层突出实际调用、原因和 cwd，并给所有选项保留空间。详情查看、取消、拒绝和 signal 生命周期保持原语义；不新增 Host 未提供的长期授权。记录真实原生审批结果到当前会话的本地 notice，单次允许明确显示 `this time`。
7. 更新 README 与受展示文案影响的断言/探针。保留现有未提交的状态栏改动、用户设计文件及其他无关文件。

### 工具完成标记补充

按用户最新要求，只使用首行 `•` 的颜色展示生命周期：运行中为黄色，成功完成为绿色，失败为红色，停止/部分执行为灰色；不新增完成提示行，不改变圆点形状或标题文字。原有错误/停止原因继续展示。`plain` 主题仍不输出颜色。

所有原生、MCP、write/edit 和 compact/detailed PTC 工具共用同一标记规则，依据 Host 归并后的 pending/isError/stopped 状态，不因输出为空而遗漏完成标记。

main-screen 无法修改终端原生 scrollback 中的旧行。对仍在屏幕内的标记立即变色；对已滚出视口且只有 SGR 样式改变的标题延后刷新，避免为变色触发清屏和历史重放。终端缩放或其他必要的完整重绘使用最新颜色。fullscreen 的历史由应用管理，直接显示最新颜色。文本、尺寸、链接/终端指令变化不属于此延后规则。

新增验证：各类工具与 compact/detailed/展开状态下的圆点配色、空结果、失败/部分执行不能标绿、标题去除 SGR 后不变、普通终端可见变色和视口外保留 scrollback、fullscreen 保留最新颜色。

提交验收增加从真实事件归并到缓存组件更新的回归：原生 `tool/call` / `tool/result` 与 PTC dispatch 两条路径，分别验证无文本结果的成功、失败和部分停止，确保最终圆点颜色来自 Host 结果且不会停留在运行色。

## 关键约束

- 不因模仿文案而把失败的 write/edit 标成成功；不根据假定的调用耗时或本地文件重读生成统计。
- 终端控制指令在加入 UI 样式前清理；源码中的控制字符保留可见转义。
- 中英文、emoji、窄屏、plain/light/dark 均按显示列宽处理。diff/输出缩进不能造成越界。
- 不在流式渲染链路添加逐字动画、延迟播放或额外隐藏逻辑。
- 保持当前权限默认选项和实际返回值；查看详情不能提交审批。
- 单个源码文件不超过 1000 行。

## 验证与验收

- 针对工具摘要/折叠/错误/部分结果、源码编号、diff 计数/高亮/上限、thinking/正文顺序与增量身份、审批选择/详情/取消/编号交互增加或更新测试。
- 运行相关 Vitest，再运行 `pnpm check`。
- 使用真实 Host 与本机 mock provider 的 fake-TTY 探针覆盖工具执行、write/edit/diff、审批和最终输出；分别验证普通与 fullscreen 模式。保存实际终端输出摘要。
- 保留 main-screen 已有无额外清屏和流式结算回归，并检查 Ctrl+O / 鼠标交互未退化。

## 验证结果（2026-11-09）

- 提交前 `pnpm check` 通过：98 个测试文件 / 1383 项测试，类型检查和构建成功。
- `node scripts/fake-tty-transcript-presentation.mjs` 六组全部 PASS：main-screen/fullscreen × 允许/拒绝四组，以及 main-screen PTC compact、fullscreen PTC detailed 两组。每组使用独立临时 profile、真实 Host 和本机 mock Responses provider。
- 探针实际执行 write/edit 并读取文件确认内容；允许时 shell 生成执行标记，拒绝时标记文件不存在。读取带 ANSI 的实际渲染帧，验证运行黄、完成绿、失败红，以及思考/工具/正文顺序、diff 配色、审批回执和 Ctrl+O/全屏翻页。
- 圆点用例覆盖 bash/pwsh/read/write/edit/MCP/run_code、compact/detailed、折叠/展开和 dark/light。新增 6 项事件归并回归，直接验证原生与 PTC 的空结果成功、失败和部分停止更新同一个缓存组件；不新增完成提示行。
- main-screen 回归确认：可见圆点立即变色，视口外样式变化不产生 `ESC[3J`，缩放后恢复最新颜色；文本或链接目标变化仍执行正常重绘。保留流式结算、饱和窗口、全局展开和 fullscreen 鼠标交互回归。
- 其他展示回归包含空文件/末尾换行计数、折叠前 diff 总量与估算标记、空源码行编号、多行语法颜色、中文/emoji 列宽和纯文本主题，以及审批详情/取消/编号确认。
- 实际输出摘要：`• edit demo.ts`、`└ (+1 -1)`、`1 - const before = 1`、`1 + const after = 2`、`✓ You approved bash printf … this time` / `! You rejected bash printf …`、`• PRESENTATION DONE`。
- 提交范围内 17 个探针脚本语法检查及 `git diff --check` 通过。探针需要沙箱外的本机端口监听权限；未逐一重跑所有旧探针，验证不代替真实 provider/实体终端体验验收。
