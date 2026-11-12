# 修复长会话流式渲染卡顿

## 目标与范围

降低长会话中 thinking 和正文更新占用事件循环的时间，保留 provider 驱动的完整内容展示、显示密度、工具顺序、主屏历史和全屏滚动行为。不修改 Host/provider 协议、用户配置或持久化会话。

审查定位到三处重复工作：transcript 外层 `Box` 在尾部变化时重新测量全部历史行；`MessageBody` 在正文更新时重新装饰已完成的 thinking 行；分帧器使用定时器迟到量代替实际 paint 耗时，可能漏计终端绘制。

## 实施方案

1. 使用仅提供上下留白的 `TranscriptBody` 替代 `Box(0, 1)`。复用 Container 的鼠标坐标分派，保持空 transcript 的高度；子行直接交给 pi-tui，移除外层逐行宽度测量及无背景行尾补空格。可见内容、上下留白和行数保持一致。
2. `MessageBody` 按宽度、行位置和源行内容缓存带前缀的显示行。保存源行快照，兼容 `StreamText` 原地更新数组；替换、缩短、resize 和 invalidate 均更新缓存。缓存仅保留当前消息行，完成的 thinking 不随正文重新装饰。
3. 通过两个小型 pi-tui 子类计量完整 `doRender()`，覆盖布局、差量计算和同步 terminal.write。`StreamPacer` 关联待绘制 rebuild 与实际 paint，合并被同一次 paint 消费的 rebuild，只在实际绘制后更新节拍。首次预热后的 paint 和冷 rebuild 不参与稳态退避；无关状态栏绘制、跳过的空帧不改变节拍。paint 更新预算后，已排队的 transcript 定时器按新间隔重排。保留 33–500 ms 范围、半事件循环预算和逐步恢复。
4. app 只接线，新增组件和计时职责放在独立文件，保持源文件不超过 1000 行。删除已无生产调用的迟到量推算辅助函数，更新其测试。

## 测量卡

| 项目 | 决定 |
| --- | --- |
| 操作 | 历史会话中追加 thinking/text delta，直到完整 pi-tui 帧输出到模拟 terminal |
| 输入 | 固定合成的 400 个 assistant 消息，每条 20 行中英混合内容；长活动 thinking 为 500 行，正文分段追加；不包含用户文本、路径、标识或凭据 |
| 路径 | 构建后的 TranscriptRenderer → 实际 transcript 容器 → ScrollView/VStack → TuiAltScreen；补充主屏生命周期测试与真实 Host 探针 |
| 时钟 | 预热后分别测 rebuild 和 renderNow，报告全部样本与中位数；排除 fixture 构造、模型、网络、终端模拟器及真实 stdout 开销 |
| 资源 | 单进程串行测量，缓存保留当前窗口；不引入全局行缓存、额外依赖或时间阈值 CI 门禁 |
| 负对照 | 同输入恢复旧 Box，比较完整绘制开销；行装饰调用计数和受控时钟测试分别隔离重复装饰与计时遗漏 |
| 行为 | 验证可见行、空窗口高度、鼠标坐标、Unicode/ANSI、替换/缩短、resize、invalidate、thinking→正文，以及主屏历史与全屏滚动 |

## 验证与验收

- 在源码修复前保存合成基准的运行结果，修复后以相同输入及终点复测，保留原始样本。
- 持久回归覆盖已完成行不重复装饰、完整 paint 被计入预算、合并绘制、冷帧、状态栏绘制和会话重置；使用受控时钟，不以机器耗时断言测试成败。
- 执行定向 Vitest，随后运行 `pnpm check`。
- 运行真实 Host 的 transcript presentation 探针，覆盖主屏/全屏及工具、审批、正文顺序。
- 使用先前审查的固定事件边界只读回放用户 session，确认主要热点消除；私有内容不进入持久基准或提交文件。
- 性能结论限定为本地处理成本，不能把 Host 记录的长 chunk 间隔直接归因于 provider，也不宣称已消除网络或真实终端的停顿。

## 验证结果

- 修复前 `node scripts/bench-stream-paint.mjs --legacy-box`：Node v24.22.2 / macOS / 120×40，400 条历史消息为 8,399 行；每阶段预热 5 帧后取 15 个样本。thinking 的 rebuild + paint 中位 99.716 ms，正文中位 99.919 ms。
- 修复后 `node scripts/bench-stream-paint.mjs`：同一输入及完整绘制终点，thinking 中位 0.645 ms，正文中位 0.388 ms。输出行数仍为 8,921 / 8,942；外层无背景行尾空格减少，不改变可见内容。
- 两个行装饰回归测试在临时恢复原 `MessageBody` 后均失败：一次更新装饰 201 行；恢复修复后通过，尾部增量只装饰发生变化的一行。实际 paint 计时通过受控时钟验证布局和 terminal.write 均进入预算，不依赖定时器迟到。
- `pnpm exec vitest run tests/message-body.spec.ts tests/transcript-body.spec.ts tests/paint-timing.spec.ts tests/stream-pacing.spec.ts tests/transcript.spec.ts tests/main-screen-cards.spec.ts`：6 个文件 / 97 项通过。
- `pnpm check`：typecheck、119 个文件 / 1,733 项测试及 build 通过。
- 对审查时的固定事件边界进行只读回放，约 9,300 行历史 + 44,941 字符活动 thinking：完整帧中位 52.98 → 0.64 ms，行装饰中位 8.23 → 0.05 ms。该会话数据只用于本地诊断，不进入持久合成 fixture。
- 真实 Host `node scripts/fake-tty-transcript-presentation.mjs`：6 组配置通过，覆盖 main-screen/fullscreen、允许/拒绝审批、PTC compact/detailed、工具和回执顺序、详情展开、全屏滚动和草稿保留。一次与并行构建重叠的运行在会话重建后失败；构建结束后串行运行全部通过，真实 Host 探针不得与其链接目录的构建并行。
