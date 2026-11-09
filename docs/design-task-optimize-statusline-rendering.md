# 优化状态栏渲染

## 目标与范围

参考用户提供的 Codex CLI 截图，将主要状态收拢到输入框下方：第一行显示模型与推理级别、工作目录、运行状态、上下文用量及可用的会话统计；第二行显示交互模式、原生权限和快捷键。用低对比度的 ` · ` 分隔不同字段，保留已有语义配色。

本次仅调整终端展示与布局，不改变 Host 会话、权限、指标采集和自动压缩行为。使用现有真实数据，不添加截图中的账户额度或版本等无对应数据的字段。

## 现状与实现方案

- `src/ui/status-line.ts` 将状态拆到输入框上方一行和下方三行，使用 `Text` 自动换行；header 再单独占三行。
- 新增按终端实际显示宽度渲染的单行组件，支持字段简写、优先级和 ANSI 安全截断。宽屏展示完整信息；窄屏依次缩短字段、隐藏辅助统计和 preset/目录，优先保留模型、Ready/Working、上下文及附件提示。
- 状态行与提示行各固定一行，终端 resize 时直接根据新宽度重排，不依赖下一次 Session 事件。极窄窗口允许最终截断，不产生折行。
- 主状态行采用 `provider/model effort · ~/workspace · Ready · Context 40% used` 风格，推理级别直接跟随模型。上下文未知时显示 `Context —`，不伪造 0%；颜色仍使用真实压缩阈值。
- 模式和原生权限保留在第二行，优先于快捷键展示；Auto 的实验标记和 Full access 的警示色继续保留。
- header 保留产品标题和 Session id，目录移入状态行。main-screen 和 fullscreen 同步调整组件顺序，执行等待/重试行仍留在输入框上方。
- 保留状态去重，避免相同数据触发组件重建和整屏绘制。

## 影响范围与约束

- 状态栏、去重包装、`app.ts` 布局接线、相关测试、README。
- 外部标签在着色之前清理终端指令并压成单行；中英文、emoji 和 ANSI 着色均按显示列宽计算。
- `/context` 保留完整 token 数、压缩阈值和构成明细；主状态栏继续与它共用指标折叠。
- 保留仓库中已有未提交文件，不修改与本任务无关的设计文档。

## 验证策略与验收标准

- 单元测试覆盖空闲/运行、模型与推理配色、上下文未知/阈值、原生权限和模式切换、附件、控制字符清理。
- 在 1、16、32、60、100、160、240 列及 plain/dark/light 主题下验证固定行高、无越界、resize 恢复信息、窄屏保留关键字段、无悬空分隔符。
- 状态去重测试覆盖内容不变和单个字段变化。
- 运行 `pnpm check`。
- 新增独立临时 profile 的 real-Host fake-TTY probe，验证输入框下方状态顺序、Ready/Working 转换、窄屏和 fullscreen/main-screen，记录真实输出。

## 验证结果（2026-11-09）

- 提交前 `pnpm check` 通过：98 个测试文件 / 1383 项测试，类型检查和构建成功。
- `node scripts/fake-tty-statusline.mjs` 四组全部 PASS：main-screen/fullscreen × 160/60 列。探针读取实际渲染帧，确认状态行紧接输入框底边框，第二行保留模式和原生权限；无列宽溢出；Working 到 Ready 与上下文采样正常。
- 160 列实际输出摘要：`mock/status-model · workspace · Ready · Context 19% used · preset minimal`，其后展示会话统计。
- 60 列实际输出：`status-model · workspace · Ready · ctx 19% · preset minimal`；第二行为 `off · workspace-write · enter send · shift+tab think · /help`。
- 状态栏测试覆盖 1/16/32/60/100/160/240 列、plain/dark/light、中文/emoji、窗口放大恢复、空值、权限及取消快捷键优先级；状态行去重包含 compact 和 priority 变化。
- 新增探针使用独立临时 profile、真实 Host 和本机 mock provider；需要沙箱外的本机端口监听权限。相关旧探针已同步展示断言，未逐一重跑。
- 提交范围内 17 个探针脚本语法检查及 `git diff --check` 通过。
