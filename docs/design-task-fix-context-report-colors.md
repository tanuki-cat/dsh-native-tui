# 修复 /context 分类配色丢失

日期：2026-11-10；状态：已实施

## 目标与范围

恢复 `/context` 占比条和图例的系统灰、工具紫、消息蓝。当前命令预生成 ANSI 后通过普通 notice 输出，最终渲染的终端控制序列清理将分类色一起移除。保持占用百分比、分类比例、token 数、40 格长度和未知/空状态的现有计算与文案。

## 实施方案

- `/context` 继续发送普通文本，同时通过 notice 的可选结构化参数传递当前 metrics 与 breakdown 的副本。该数据仅用于本地展示，不进入 Host Session 日志。
- notice 块增加可选 `contextReport` 数据，原有通知位置锚点、保留上限和审批回执链路继续复用。
- 新增专用报告组件，在最终渲染时调用现有纯格式化函数并使用当前 palette 着色。该组件只从结构化数值数据生成内容，不信任 notice.text 中的 ANSI，不增加通用 trusted-text 绕过开关。
- 普通 notice 继续使用既有 `sanitizeTerminalText`。`plain` 无 ANSI；dark/light 使用各自分类颜色，主题刷新重新上色。报告保留命令执行时的数据，不随后续 metrics 变化而改写历史。

## 影响区域

`context-stats.ts`、`CommandContext` 的 notice 参数、`app.ts` 的 notice 接线、Transcript notice 类型和最终组件选择；新增报告渲染组件及对应回归，更新真实 Host `/context` 探针。不新增依赖，源码单文件保持 1000 行以内。

## 验证与验收

- 先验证新增的命令到 TranscriptRenderer 回归在旧实现下失败，再实现修复。
- 覆盖 dark/light/plain、最终占比条与图例色一致、比例和列对齐、窄屏、报告快照、主题刷新、未知/空状态，以及普通通知中的 ANSI/OSC/C1 清理和伪造报告文字。
- 运行 `pnpm check`。
- 将 `scripts/fake-tty-context.mjs` 改为独立临时 profile/workspace、随机回环端口和事件帧等待，不复用旧安装模板或固定临时路径。按 `dsh-ci-test-reliability` 约束等待子进程退出并关闭服务。
- 使用真实 Host 与本地 mock provider，覆盖主屏/全屏 × dark/light/plain，观察实际帧中的占比条、三种图例色、数值一致性和列宽；验证 `plain` 无分类 ANSI。探针不代表外部真实模型或物理终端人工验收。

## 实施与验证记录

- `pnpm test tests/context-render.spec.ts --bail=1` 在修改实现前按预期失败：报告最终渲染中缺少系统分类的灰色 ANSI，证明回归覆盖了命令到通知再到组件的完整链路。
- 新增 15 项最终渲染回归，覆盖三种主题、五种列宽、数值快照、主题刷新、未知/空状态及 ANSI/OSC/C1 安全边界；更新路由测试，断言结构化报告数据被传递。既有比例、token 数和图例列对齐断言保持通过。
- `pnpm check` 通过：113 个测试文件、1673 项测试，类型检查与构建通过；定向验证 4 个文件、71 项测试通过。
- `node scripts/fake-tty-context.mjs` 六种组合全部 PASS：主屏/全屏 × 100 列 dark、50 列 light、80 列 plain，统一使用 42 行视口。实际帧中深色分类色为 245/141/39，浅色为 243/98/25，plain 不输出分类色。
- 每组实际报告占用 19%，40 格中填充 8 格；三种色段的填充合计与占用一致，图例与色段逐类对应。继续验证图例小数比例和列对齐、分类 token 合计、128K 窗口、单一重算总量与说明文本，无行宽溢出。
- 新探针使用全新临时 profile 和工作区、本地 mock Responses 服务；已等待子进程退出并清理临时目录和监听端口。沙箱拒绝回环端口监听，经授权在沙箱外通过；不代表真实外部模型或物理终端人工验收。
- `git diff --check` 与探针语法检查通过。
