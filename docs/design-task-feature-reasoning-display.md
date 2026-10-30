# 推理显示：移植 dsh rc.5 的 thinking 文本归一化与折叠摘要

> 任务类型：feature ｜ 目标仓库：`dsh-native-tui` ｜ 状态：**已实施（2026-10-30）**
> 日期：2026-10-30 ｜ 上游：dsh `v0.2.1-rc.5`（PR #7484，commit `534dac8c81`）

## 1. 结论

rc.5 唯一的实质性改动是 Web 端 thinking 块渲染，其中两件事对 TUI 有意义，而 TUI 当前都没有：

1. **推理文本归一化**：模型输出以 `<signature>` 开头时，显示层剥掉到 `</signature>` 的内容与随后的换行；流式期间只收到签名前缀时显示空。
2. **只剩签名时隐藏**：归一化后没有可显示内容，就不渲染 thinking 卡片。

另外把 Web 早就有的折叠摘要规则（流式取**最后一个已完成段落**的首行，结束后取首行，并去掉 `**` 标记）一起移植，因为 TUI 现在的 compact 模式固定取「全文第一个非空行」，长思考时预览会停在开头。第 2 条与这条摘要在 rc.5 里位于同一个渲染入口，合成一次改动比只抄归一化更划算。

**不改事件、不改持久化、不改导出**：归一化只发生在渲染层。

## 2. 上游依据

`packages/client/ui-chat/src/client/reasoning-text.ts`（rc.5 新增）：

~~~ts
export function reasoningText(text: string): string {
  if (text[0] !== '<') return text
  const opening = '<signature>'
  if (opening.startsWith(text)) return ''
  if (!text.startsWith(opening)) return text
  const closing = '</signature>'
  const end = text.indexOf(closing, opening.length)
  if (end === -1) return ''
  let start = end + closing.length
  while (start < text.length) {
    if (text[start] === '\n') start++
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2
    else break
  }
  return text.slice(start)
}
~~~

语义要点：

| 输入 | 输出 | 理由 |
|---|---|---|
| 不以 `<` 开头 | 原样 | 绝大多数推理正文 |
| 以 `<` 开头但不是 `<signature>` | 原样 | `<note>` 之类不是签名 |
| 只是 `<signature>` 的流式前缀（如 `<sig`） | 空 | 避免半截标签闪入正文 |
| 有开标签、没有闭标签 | 空 | 签名仍在流 |
| 完整签名块 | 闭标签之后的文本（吞掉其后的 `\n` / `\r\n`） | 只显示真正内容 |

同一提交里 `ReasoningRow` 的处理：`hidden = text !== rawText && text.trim() === ''`，为真时整行不渲染；`process-activity` 的 live detail 也改用归一化文本。Web 的 Body Slot 另加了 `rawText` 字段——TUI 没有 slot 体系，不移植（见 §5）。

## 3. 本插件现状

| 位置 | 现状 | 与上游的差异 |
|---|---|---|
| `src/ui/transcript.ts:155` `contentReasoning` | 各 `reasoning` 块 `text` 原样 `\n` 拼接 | 无归一化 |
| `src/ui/transcript-stream.ts:79` | 过滤 `part.text !== ''` | 按原始文本判空 |
| `src/ui/assistant-message.ts:37` | 跳过 `part.text.trim() === ''` | 同上；签名块非空，所以会渲染 |
| `src/ui/assistant-message.ts:41` | compact：`thinking · ` + **全文第一个非空行**（裁剪 240 字素） | 上游取**最后一个已完成段落**的首行，并去掉 `**` |
| `src/ui/assistant-message.ts:42` | detailed：原文进 thinking 色带 | 未归一化 |
| `src/runtime/html.ts` / `src/runtime/tool-log.ts` | 只渲染 text 块 | 不受影响，无第二处显示面 |

补充：`src/runtime/agent.ts` 里的 `thinkingSignature` 是**结构化签名字段**（pi-ai 用于重放请求），与这里的内联 `<signature>` 文本是两套编码，互不影响。

## 4. 设计

### 4.1 新模块 `src/ui/reasoning-text.ts`

~~~ts
/** 显示层归一化；输入是原始推理文本，输出是可显示文本。 */
export function reasoningText(text: string): string

/** 首行（无换行时为全文）。 */
export function firstLine(text: string): string

/** 最后一个「已完成」段落的首行：段落以空行分隔，段内出现换行才算完成。 */
export function latestCompletedParagraphFirstLine(text: string): string

/** 折叠预览：流式用 lastCompleted，结束后用 firstLine；去 `**`；空则回退首个非空行。 */
export function reasoningPreview(text: string, running: boolean): string
~~~

`reasoningText` 逐行对齐上游实现（含 `\r\n` 处理与「只收到前缀则空」），并保留上游测试覆盖的边界（`<note>` 不误伤）。

`reasoningPreview` 是 TUI 专有的组合，两个决策：

1. **去 `**`**：与 Web 摘要一致（TUI 的 compact 是一行纯文本，不渲染 Markdown）。
2. **空预览回退**：Web 在摘要为空时只是不显示折叠头，行还在；TUI 的 compact 模式只有一行正文，预览为空会渲染出 `thinking · ` 这样的空标签。因此当 `running` 且还没有完成段落时，回退到「第一个非空行」（即当前行为），保证流式首帧可用。

### 4.2 接入 `src/ui/assistant-message.ts`

`update(block)` 内对每个 part 做三件事：

~~~ts
const display = part.type === 'reasoning' ? reasoningText(part.text) : part.text
if (display.trim() === '') continue                       // 原判空改为归一化后判空
const text = part.type === 'text' ? sanitizeTerminalText(display)
  : mode === 'compact'
    ? 'thinking · ' + clipGraphemes(reasoningPreview(display, block.live), 240)
    : sanitizeTerminalText(display)                        // detailed 用归一化文本
visible.push({ type: part.type, text, raw: part.text })     // raw 仍是原文，用于复用判断
~~~

要点：

- `raw` 继续保存**原始**文本，`before.raw === part.text` 的复用判断不变；归一化是纯函数，raw 相同则 display 相同。
- compact 预览的长度裁剪与 `sanitizeTerminalText` 顺序沿用现状（先净化再裁剪），只是在中间插入 `reasoningPreview`。
- detailed 的 `thinking` 色带与 `palette.dim` 不变。
- 「只剩签名」的 part 在归一化后 `trim() === ''`，自然走到 `continue`，等于上游的 `hidden`；无需额外分支。

### 4.3 为什么不改事件与流式投影

- `transcript-stream.ts` / `transcript.ts` 保留原始文本：`block.reasoning` 还会被 metrics（`unreplayedReasoningTokens`）与导出读取，改写会把「请求实际携带的内容」和「界面显示的文本」混为一谈。
- 单一改动点（`AssistantMessage`）同时覆盖 live 流与 durable 重建，因为两者最终都走 `AssistantStream.project()` → `AssistantBlock.content`。
- 归一化幂等：对已归一化文本再调用无副作用（不以 `<` 开头即原样返回）。

## 5. 决策与边界

| 决策 | 结论 |
|---|---|
| Web 的 Body Slot `rawText`/`text` 契约 | **不移植**：TUI 没有 slot 体系 |
| `process-activity` 的 live detail | **不移植**：TUI 状态行不展示推理片段 |
| `<signature>` 之外的标签（`<note>` 等） | 不处理，保持上游语义 |
| 结构化 `thinkingSignature` 字段 | 不动：metrics 已按它统计不可重放的推理 |
| 导出（`/export`、HTML） | 不动：本就不渲染 reasoning |
| 折叠摘要的段落规则 | 采用 Web 语义；**回退策略是 TUI 专有**，需在代码注释里写明原因 |

## 6. 测试计划

新增 `tests/reasoning-text.spec.ts`：

- 原样返回：空串、普通中英文正文、以换行/空格开头、`<note>…</note>`
- 前缀流式：`<`、`<sig`、`<signature>` → 空
- 未闭合：`<signature>abc` → 空
- 完整块：`<signature>abc</signature>正文` → `正文`；闭标签后带 `\n` / `\r\n` 被吞掉；带其它字符则保留
- `firstLine` / `latestCompletedParagraphFirstLine`：单段无换行、单段有换行、多段、仅尾部段落未完成、`\r\n` 分隔
- `reasoningPreview`：流式取最后完成段落、结束后取首行、`**` 被去掉、空时回退首个非空行

`tests/transcript-stream.spec.ts`（已有组件级入口，见其 185 行构造方式）追加：

- 纯签名推理（`reasoning: '<signature>x</signature>'`）在 compact 与 detailed 下都不产生 thinking 行
- 签名 + 正文：detailed 只显示正文；compact 预览不含 `<signature>`
- running 状态下的 compact 预览随新段落推进，且 text 部分不受影响
- `thinkingDisplay: 'hidden'` 时行为不变

`tests/terminal-safety.spec.ts:61` 已覆盖 reasoning 卡片的转义，新增用例需保证转义仍先于裁剪。

## 7. 验证

~~~sh
pnpm check          # typecheck + vitest + build
~~~

不新增 fake-TTY 探针：触发条件是「模型输出以 `<signature>` 开头的推理」，mock 服务器可以伪造，但探针只能证明渲染字符串出现，不优于组件级断言。真实环境抽查：`/reasoning detailed` 与 `compact` 各看一轮含推理的回复。

## 8. 非目标

- 不修改 pi-ai、宿主或 Web 端。
- 不改 compact 的单行形态（不引入折叠头/展开）。
- 不做推理的 Markdown 渲染（现状是 dim 纯文本）。
- 不处理翻译/多语言（Web 的翻译链路与 TUI 无关）。

## 9. 风险与回滚

| 风险 | 处理 |
|---|---|
| compact 预览在段边界抖动（流式中段落反复完成） | 只用「已完成」段落，未完成段落不参与；组件级用例锁行为 |
| 归一化误伤正常正文 | 只对 `<` 开头的文本生效，且 `<note>` 类用例锁定 |
| 用户已经习惯「永远显示第一行」 | 视为体验改进写入 README 的 thinking 说明；回滚只需还原 `assistant-message.ts` 一处并删除新模块 |

## 10. 实施顺序与估算

1. 新增 `src/ui/reasoning-text.ts`（约 70 行，含 JSDoc）+ `tests/reasoning-text.spec.ts`
2. 改 `src/ui/assistant-message.ts`（约 10 行）
3. 追加组件级用例到 `tests/transcript-stream.spec.ts`
4. `pnpm check`，README 的 thinking/compact 说明同步一句

工作量：源码约 80 行、测试约 150 行；`assistant-message.ts` 不接近 1000 行上限，无需拆分。
## 11. 实施记录

| 文件 | 变更 |
|---|---|
| `src/ui/reasoning-text.ts` | 新增：`reasoningText` / `firstLine` / `latestCompletedParagraphFirstLine` / `reasoningPreview` |
| `src/ui/assistant-message.ts` | display/raw 分离；归一化后判空；compact 预览改用 `reasoningPreview`；detailed 用归一化文本 |
| `tests/reasoning-text.spec.ts` | 新增 17 例 |
| `tests/transcript-stream.spec.ts` | 追加 6 例（含渲染器级：整条 transcript 不出现 `<signature>`） |
| `README.md` | 「渲染与显示」补充签名剥离与 compact 预览规则 |

实现细节：

- `firstLine` 与段落候选都做 `trim()`：TUI 的 compact 是一行纯文本，与上游 `ReasoningRow` 的 `summary` 处理一致（上游在 `summaryText` 之外还会 trim 候选）。
- `reasoningPreview` 自身再跑一次 `reasoningText`（幂等），因此既接受原文也接受已归一化文本；`AssistantMessage` 传入已归一化的 `display`。
- 段落分隔的正则在函数内新建，避免跨调用的 `lastIndex` 状态。

验证：`pnpm check` 通过，89 个测试文件 / 1220 例，构建成功。真实模型输出未强制构造 `<signature>` 场景（本机会话不含该编码），组件级用例覆盖渲染结果。
