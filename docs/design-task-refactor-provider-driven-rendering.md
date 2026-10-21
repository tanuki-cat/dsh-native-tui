# Provider 驱动的流式展示

## 决策与边界

用户确认采用 Pi 的直接展示方式，取消 TUI 的额外逐字播放。
本方案替代 [流式 transcript 渲染重构](design-task-refactor-stream-rendering.md) 中的 reveal、进度继承和 settle grace 决策；旧文档保留历史验证记录，不作为当前播放行为依据。

不修改 Host/provider 协议、断流检测、超时或重试策略，不增加配置或依赖。保留 detailed/compact/hidden 密度、增量归并、窗口裁剪、工具去重/prune、组件和行缓存。

## 实现

- `AssistantStream` 按 provider index 累积 text/reasoning；每次投影使用已收到的完整内容。只有 block-start 且尚无内容时展示 thinking 占位。
- `block-end` 和 durable settlement 直接采用完整内容；正文、工具和下一步不等待人为播放或 grace，可在同一帧按事件顺序展示。
- `TranscriptRenderer` 只在事件或显示选项变化时更新内容，不保留 reveal progress，也不自行续订动画帧。`grapheme-preview.ts` 仅负责 compact 预览裁剪。
- 固定 chrome 行从 turn/start 开始显示 working，贯穿正文和工具执行；turn/end 和会话切换清除。新 attempt 或恢复收到 chunk 时清除 retry 标签，但不结束 working，计时保持本轮起点。
- `llm/retry` 立即替换为 Host 给定的次数和原因。失败、取消和中断 notice 直接展示，不受正文进度影响。网络卡住时 working 仍存在，但不代表网络健康；是否超时、是否重试由 Host/provider 决定。

## Pi 参考

本机 Pi 1.3.0 的 `AssistantMessageComponent.updateContent()` 直接使用当前 message.content；interactive-mode 的 message_update/message_end 分别更新流式和最终内容。working 和 auto_retry 状态由执行事件驱动，HTTP idle timeout 由网络层处理。这里只对齐展示与状态职责，不复制 Pi 的 Host 协议或超时默认值。

## 验证

- `tests/transcript-stream.spec.ts`：大块内容首帧完整、block-end 无 delta、settlement、不重播、交错 content、错误、重试、会话隔离、Unicode 与增量归并。
- `tests/session-events.spec.ts`：turn/attempt 起点、流内容和 stream/end 不提前清除 working、失败/取消/中断终止状态。
- `tests/wait-status-line.spec.ts`、`tests/main-screen-cards.spec.ts`：working/retry 文案、固定行高和 main-screen 稳定性。
- fake-TTY：完整 reasoning、慢首包与 chrome 几何、reasoning/tool 顺序、大块与连续 chunk、工具参数阶段；`fake-tty-stream-recovery.mjs` 在观察到部分 reasoning 完整展示且 working 继续计时后断开 SSE，验证真实 Host 自动重试与恢复。

## 验证结果

- `pnpm check`：typecheck、52 个文件 / 578 个测试、build 通过。
- `fake-tty-stream-recovery.mjs`：完整 partial 首帧可见，停流期间 working 持续，主动断开后 retry 可见，第二次请求恢复并回到 idle。
- `fake-tty-stream-smooth.mjs`、`fake-tty-stream-chunks.mjs`：完整输出可见，0 个 reveal frame；连续流收到 10 个 text delta。
- `PROBE_REASONING_REPEAT=70 PROBE_SETTLE_MS=0 node scripts/fake-tty-reasoning-stream.mjs`：4390 字 reasoning 首帧完整，与答案同一采样出现且顺序正确。
- `fake-tty-reasoning-tool-order.mjs`：reasoning/tool 同帧按顺序展示，0 次清屏。
- `fake-tty-reasoning-slow-start.mjs`：placeholder 后至正文和 idle，状态栏/输入框保持 21/26 行。
- `fake-tty-wait-tool-phase.mjs`：工具参数期间 working 继续重绘，最终 idle。
- `fake-tty-main-screen-scroll.mjs`：2 轮 / 26 chunks，0 次清屏，完整输出可见。
- `pnpm exec tsx scripts/bench-transcript.ts`：600 轮稳定帧中位 0.5 ms；600 轮 + 10,000 thinking deltas 的新增 delta + set + render 中位 5.7 ms。基准不包含终端差量写入或模拟器开销，不与只展示局部前缀的旧动画数值直接比较。

探针使用真实 Host 与本地 mock provider，不代替真实 provider 或真实终端的验证；Host 的超时策略未改动。
