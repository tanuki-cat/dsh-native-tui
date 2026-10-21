# 流式 transcript 渲染重构

## 目标与边界

thinking、正文、工具与后续步骤按接收顺序展示；积压不因超阈值或掉帧整块跳出；长会话不在每帧重新归并历史事件。不修改 Host/provider 协议、持久化数据、配置或依赖版本。

## 已确认的问题

- `transcript.ts` 每帧重放保留窗口，重复拼接同一步的所有 delta。
- 正文与 thinking 独立推进，正文可以越过尚未展示完成的 thinking。
- `reasoning-reveal.ts` 的 completed thinking 按墙钟追赶，文本积压超过 600 UTF-16 units 时直接全部显示。
- live assistant 每帧重建整块组件，已完成 thinking 的格式化也被重复执行。

## 方案

1. `createTranscriptReducer()` 分离事件归并与展示投影。追加事件只处理新增后缀；日志替换、窗口裁剪和密度切换时重建归并状态。输入事件视为不可变；同一数组允许尾部追加，内容替换使用新数组。
2. `AssistantStream` 按 provider index 保存 text/reasoning parts；每帧只推进一个尚未展示完的 part。显式 block-start 占据其顺序位置，block-end 之前不能让后续内容越过它。用户输入与错误提示不受等待限制。
3. interactive 的 thinking/text 每帧推进至多 24 UTF-16 units（完整 grapheme 可超过此值），不按耗时补跳，不因积压规模直接显示全部。durable settlement 继承可见 offset；历史载入不重播。`track()` 在事件接收时记录进度入口及失败尝试清理，避免下一帧前 settlement/retry 替换 live 条目后丢失动画状态。
4. `AssistantMessage` 复用 Text/Markdown 子组件；保留稳定行的 width memo。pending 只驱动下一次投影，可见内容未变时不请求终端重绘。
5. 后续行的 grace 从内容实际展示时间计算，工具等待时其后的步骤也等待。历史保留、工具去重/prune、用户输入与错误提示的既有行为不变；重试和会话切换隔离旧进度。
6. 不跟踪进度的纯函数 reducer 保留按事件时间投影 completed reasoning 的行为；交互 UI 不使用这一路径。

## Pi 参考

本机 Pi `dist/modes/interactive/interactive-mode.js` 的 message_start/update/end 维护当前 streaming component；`components/assistant-message.js` 按 message.content 顺序渲染。借鉴状态与顺序，不复制其 Host 事件协议，也不引入新依赖。

## 验证

- 单元测试：thinking→text→下一步、多个 content parts、>600 字积压、慢帧、settlement、重试、历史替换、裁剪、密度切换、Unicode 与组件复用。
- 增量验证：用事件访问计数证明已有 delta 不在后续帧重放；基准对比短/长会话与大量 live chunks。
- `pnpm check`；fake-TTY 的 reasoning-stream、reasoning-tool-order、stream-smooth、stream-chunks 与 main-screen-scroll。

## 验证结果

- `pnpm check`：typecheck、52 个测试文件 / 625 个测试、build 全部通过。
- `git diff --check`：通过；所有修改的 source 文件均少于 1000 行。
- `node scripts/fake-tty-stream-smooth.mjs`：9 个 reveal frames，最大 advance 24，完整输出可见，exit 0。
- `node scripts/fake-tty-stream-chunks.mjs`：10 个 provider chunks、60 个 reveal frames，最大 advance 17，完整输出可见，exit 0。
- `node scripts/fake-tty-main-screen-scroll.mjs`：2 轮、26 个 chunks、0 次清屏，全部输出可见，exit 0。
- 在独立临时 profile 中运行 `PROBE_SETTLE_MS=0 PROBE_REASONING_DELAY_MS=1200 node scripts/fake-tty-reasoning-stream.mjs`：waiting 可见；thinking 结束 6075 ms，answer 6228 ms，PASS。
- 在独立临时 profile 中运行 `node scripts/fake-tty-reasoning-tool-order.mjs`：thinking 结束 4953 ms，tool 5157 ms，final answer 5309 ms，PASS。
- 两个关键回归断言在原始源码副本上按预期失败：正文越过 thinking、>600 字积压整块显示。新增 token-sized surrogate 与 fast retry 回归也先观察到失败，再验证修复。
- `pnpm exec tsx scripts/bench-transcript.ts`：同一合成场景 F（600 轮、10,000 thinking delta、preview 已展示完，追加 + set + render）原始源码中位 24.5 ms，重构后 0.4 ms。场景 A 的 600 轮稳定帧约 2.5 → 0.6 ms。测试以事件 getter 计数验证已有 10,000 个 delta 不被后续帧重读。
- 后续修复一：`detailed` 模式不再按 3000 grapheme 截断 thinking；`PROBE_REASONING_REPEAT=70` 的 4390 字思考流探针 PASS，答案仍在其后。
- 后续修复二：步骤结算不再回卷重播。进度增加 `paintedAt`，已展示内容的显示时间随 live→durable 替换保留；`tests/transcript-stream.spec.ts` 覆盖 reasoning/text × detailed/compact/hidden 四种组合，`tests/main-screen-cards.spec.ts` 断言替换后 0 次全屏重绘。
- 后续修复三：模型等待行从 transcript 移到输入框上方的固定单行 `WaitStatusLine`，空闲时仍占一行。`scripts/fake-tty-reasoning-slow-start.mjs` 通过 `scripts/fake-tty-chrome-trace.mjs` 记录真实渲染中的状态栏/输入框行号：修复前 21/26 → 20/25（上移一行后回弹），修复后从等待行出现到正文结束恒为 21/26；同一 log 上的负向对照证明该规则能捕获修复前的跳动。

## 风险与未验证范围

有限每帧推进会使整块返回的大输出在 UI 中晚于模型完成；这是避免突然填充的取舍。thinking 仍遵守已有 3000-grapheme preview 上限，未改写持久化内容。上述探针使用真实 Host 和 mock SSE，不等同于真实 provider、真实终端或端到端性能测量；基准不包含 pi-tui 的最终差量写入、终端模拟器开销和模型速度。未改动 provider 协议、依赖或用户 profile。
