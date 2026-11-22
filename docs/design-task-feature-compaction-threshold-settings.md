# 按模型配置自动压缩检查百分比

> 目标仓库 `dsh-native-tui` · Host 基线 `0.2.2-rc.5` · 2026-11-22 · 状态 **已实现并通过隔离 Host 验证**

## 目标与范围

在 TUI 中为当前 Agent preset 的选中模型配置自动压缩检查百分比。TUI 负责输入、预算校验、配置保存和状态展示。DSH Host 从官方 `modelPolicies` 读取策略，继续负责压力检查、裁剪、选区、摘要及溢出恢复。达到检查线后，Host 仍需选出可替换的历史才会生成摘要。有关 144k 本地模型的会话复现见[自动压缩排障](troubleshooting-context-compaction.md)。

配置以当前 profile、会话实际绑定的 preset、精确的 `{ provider, model }` 为范围。同一 profile 中使用该 preset 和模型的会话共享策略。百分比存放在 Host `thresholdRatio`，依现有 `headroomTokens` 与模型预算推导实际检查线。模型窗口与正常请求输出预留从 Host 读取，属于保存时的只读输入。

Host 在模型切换时也按目标路由的策略检查历史。历史超过目标检查线且无法压到线下时，切换会以 `MODEL_SWITCH_COMPACTION_FAILED` 结束，保留旧请求路由。修改路由上的摘要输出上限，也会改变使用该路由策略的手动 `/compact` 和溢出恢复。 [Host 压缩入口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/src/index.ts#L183-L203) · [摘要上限](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/src/summarizer.ts#L144-L165)

## 用户交互

| 入口 | 行为 |
|---|---|
| `/context` | 保留用量与构成报告，读出当前会话实际挂载策略的检查线。 |
| `/context threshold` | 打开当前选中模型的配置面板，显示作用范围、有效检查线，并接受 `1` 到 `100` 的整数百分比。 |
| `/context threshold 90` | 直接计算 90% 的候选策略。满足预算时预览待保存策略，超出预算时给出最高可选百分比。 |

预览显示 preset 和模型、窗口、请求输出预留、当前及预计检查线、所需的 `headroomTokens` 变化，并说明检查线也用于切入该模型。已保存的策略与当前挂载策略不同时，分别显示两者。摘要输出上限默认沿用编辑基线的有效值，用户可在预览中独立编辑并确认。预览说明保存会将整份 preset 配置写入当前 profile，并提供升级迁移指引。摘要路由查询失败时，在预览中提示原因并保留原方案。保存前取消时保留原配置。Host 禁用自动压缩时，界面明确标记该状态。无法定位可编辑 preset 或受支持压缩器时，说明原因并显示当前会话的只读 `/context` 报告。

手动输入的百分比超出预算时，显示原请求值、超预算原因及最高可选的整数百分比。用户可选择采用建议值、返回重新输入或取消。采用建议值后进入常规策略预览，仍需确认保存才能写入 `modelPolicies`。

## 将百分比换算为官方策略

### 输入和计算

1. 从当前会话读实际绑定的 preset，从模型选择读精确的 provider 和 model。用 `llm.resolveModelInfo` 获取窗口 `W`。仅当最新 `request/header` 与目标路由相同时，才优先使用其 `config.maxTokens`。否则使用目标路由的 `defaultMaxTokens`。已成功解析的路由未声明输出上限时，按 Host 语义使用 `O = 0`。容量未知或路由解析失败时拒绝保存。
2. 从 Host 声明的最新 preset 配置合并顶层字段和精确 provider/model 匹配项，取得编辑基线的余量 `H`、保留策略和摘要输出上限。当前 Agent 的挂载策略用于显示当前值。若已有保存待重载的策略，下次编辑基于这份已保存的配置。`O` 是正常模型请求的输出预留，压缩策略中的 `maxTokens` 是摘要请求的输出上限。
3. 对用户输入 `P`，按下式求值。允许的最大余量为负时，即使余量降至零也无法达到该百分比。此时进入最高可选百分比的计算，原请求值保留在界面作为对照。

   ```text
   ratio = P / 100
   targetTokens = floor(W × ratio)
   headroomLimit = W − O − targetTokens
   nextHeadroom = min(H, headroomLimit)
   effectiveTokens = floor(min(W × ratio, W − O − nextHeadroom))
   ```

4. 将 `thresholdRatio` 更新为 `ratio`。仅在需要收窄余量时写入 `headroomTokens`。用候选策略重新计算保留预算，校验 `retainRatio < thresholdRatio`（比例形式）和 `retainTokens < effectiveTokens`（换算后的 token 数）。要求消息预算和检查线为正，保留已有的 `retainRatio` 或 `retainTokens`。
5. 分别计算余量调整前后的有效摘要 `maxTokens`。路由或顶层已有显式上限时沿用现有继承关系。若原上限随余量推导、调低余量会改变它，则默认把原有效值写成目标路由的显式 `maxTokens`。余量为零时同样需要正的显式上限。用户若选择不同上限，单独确认它对自动摘要、`/compact` 和溢出恢复的影响，再随策略保存。输入为正整数，摘要模型的上下文容量已知时，拒绝超出其窗口的值。提高检查线会压缩可用于摘要的剩余空间，预览同时展示余量和摘要上限，实际摘要请求能否容纳前缀仍取决于 Host 选区和摘要模型容量。

计算和校验以支持版本的 Host 规则为准。保留路由上的摘要模型、重试次数等其他配置字段。百分比和 token 数用同一个计算结果作为预览和展示的来源。 [官方压缩配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/README.md#tuning-when-condensation-starts) · [Host 预算计算](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/src/config.ts#L118-L204)

### 超预算时给出最高可选百分比

1. 确认用户输入合法且模型预算已知。仅当请求检查线超过 `W − O` 时推荐较低百分比。路由解析失败、容量未知或输入格式错误时，直接报告对应原因。
2. 从 `P − 1` 向下检查到 `1`。用同一个候选策略计算和校验函数验证每个整数百分比，包含 Host 的取整、保留预算和摘要上限约束。第一个通过者就是最高可选值。每次计算使用同一份窗口、请求输出预留、保留策略和有效摘要上限，按常规规则收窄压缩余量。保留原摘要上限需要显式写入时，也纳入候选策略。用实际 token 数校验边界，例如 78% 对 101-token 窗口对应 78 tokens，预算恰好为 78 tokens 时可以通过。
3. 建议同时给出百分比、实际检查 token 数和收窄后的 `headroomTokens`。没有候选通过时，说明约束并允许返回编辑。提交前按最新预算重新核对用户已确认的候选。预算或建议变化时重新预览，由用户再次选择。

### 本地 Qwen 案例

本地 `llama-cpp/qwen3.8-27b` 当前窗口为 147,456，正常请求输出预留为 32,768。默认检查线为 49,152 tokens（33.3%）。同一窗口下的预期结果如下。

| 输入 | 正常请求输出预留 | 预期结果 |
|---|---:|---|
| 75%，原余量 65,536 | 32,768 | 余量降至 4,096，检查线 110,592 tokens（75%）。 |
| 77%，原余量 65,536 | 32,768 | 余量降至 1,147，检查线 113,541 tokens。原隐式摘要上限为 65,536 时，默认显式保留该值。 |
| 85%，原余量 65,536 | 32,768 | 目标为 125,337 tokens，理论上限为 114,688 tokens（77.8%）。建议采用 77%。 |
| 90%，原余量 65,536 | 32,768 | 目标为 132,710 tokens，78% 也需要 115,015 tokens。建议采用最高可选的 **77%（113,541 tokens）**，对应压缩余量为 1,147 tokens。 |
| 85%，原余量 4,096 | 18,000 | 余量维持 4,096，检查线 125,337 tokens（约 85%）。 |

85% 对应的 `O + headroomTokens` 最多为 22,119 tokens。若需要为压缩保留 4,096 tokens，正常请求的输出预留须为 18,023 tokens 或以下。由用户在模型配置中单独决定输出上限。已有同路由请求头仍声明旧上限时，以其生效的预算计算，等新请求头生效后即可重新编辑。

## 持久化与生效

1. 用 Host `agentPresets` 查询会话实际绑定的 preset，从 `ConfigEditor.entries()` 定位唯一可编辑的 preset 声明，核对插件模块与 `config.id`。在该声明的插件列表中定位实际挂载的 `@deepseek-ai/dsh-compaction-basic`。TUI 自带 preset 的目标位于 `compaction` 组，宿主层同名条目处于禁用状态。 [TUI preset](../presets/ptc.patch.yml) · [TUI bundle](../cordis.patch.yml)
2. 在 `ConfigEditor.edit` 接收的最新完整 preset 配置中，更新同一 `{ provider, model }` 的策略或新增一条。保留其他模型、现有策略字段、插件列表和 `!!js` 表达式。让 Host 负责 profile patch 的序列化、加锁、原子写入及重新加载。
3. 确认前校验命令所属的会话与模型选择。提交时重新解析模型预算，并在 Host 编辑回调按最新配置复核候选策略。若目标 preset、路由、预算或预览结果已变化，要求重新预览。遇到重名策略、覆盖层冲突或 Host 写入失败时，显示具体原因。
4. 保存前保留本次修改字段的旧值及是否显式存在，并记录提交值。`ConfigEditor.edit` 返回后，先用 `agentPresets.resolve(presetId)` 检查新声明的 `broken` 状态，再用 `readDocument(presetId)` 核对写入策略。新版 preset 健康后，才用 `agentPresets.serviceFor(agent, 'compaction')` 判断当前会话是否已生效。当前 Agent 仍绑定旧版时，提示用户空闲后 `/reload` 以恢复同一 Session。进入保存后，即使界面取消，也要完成写后验证及必要的回退。 [Host preset 状态检查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/preset/agent-preset-registry/src/index.ts#L216-L245) · [TUI 会话恢复](../src/runtime/agent.ts)
5. 新版 preset 验证失败时，用 `ConfigEditor.edit` 重新读取配置。仅当目标字段仍等于本次提交值时恢复其旧值和显式状态。仅由本次写入创建的策略及空列表一并撤销，其他编辑追加的字段与模型策略予以保留。回退后重新校验 preset。遇到并发改动导致无法安全回退时，显示失败原因、profile 文件和目标策略，不提示重载。按需在配置文件中恢复该策略后再校验 preset。

### preset 升级与迁移

rc.5 的 `ConfigEditor` 将整个 preset 的 `config` 写入 profile patch。bundle 更新后，旧覆盖仍会优先，可能遮住新版的工具和默认配置。首次保存和交付后的排障文档应说明此行为及迁移步骤。 [Host 保存实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/config-editor/src/index.ts#L116-L147)

1. 升级前保留旧版 bundle 的原始 preset 声明及已有的 profile 覆盖，便于区分用户自定义与从旧 bundle 复制的字段。
2. 升级后以新版 bundle 的完整 preset 配置为基底，将用户原有的自定义和 `modelPolicies` 迁移进去。同一路由已在新版包含策略时，按字段合并，并逐项确认冲突。若旧覆盖仅用于此次调参，也可移除旧覆盖，在新版 preset 上重新保存百分比。
3. 核对合成后的 preset 同时包含新版插件与默认值、保留的用户自定义和目标 `modelPolicies`。验证新版可挂载后再恢复原会话。迁移由用户按上述步骤确认，功能实现只保存 Host 策略。

## 上下文展示与刷新

`/context` 使用当前会话实际挂载的压缩器和最近已路由模型的预算。首次路由前，模型信息足以计算检查线时直接展示阈值，当前占用仍显示为未知。模型切换待路由时，配置预览可针对新选模型计算，同时标注 `/context` 的旧路由读数。缺少有效策略时显示未知或禁用状态。

状态栏与 `/context` 使用同一个已路由模型窗口计算占用率和检查线，优先采用 Host 模型目录的容量。报告中的 `configured` 仅在显式配置的模型级比例与有效检查线不同时显示。状态栏用该检查线为占用率着色。选中模型有已生效的手动基线时，另显示 `Compaction baseline 77%`，窄窗口缩写为 `base 77%`。基线随模型选择更新，无需等首次请求。指标缓存比较压缩策略状态、路由、有效检查线和配置百分比，策略或预算变化时刷新读数。 [指标缓存](../src/runtime/metrics.ts) · [上下文报告](../src/ui/commands/context-stats.ts)

## 实施位置

| 位置 | 变更 |
|---|---|
| [`src/ui/commands/router.ts`](../src/ui/commands/router.ts) 与 [`catalog.ts`](../src/ui/commands/catalog.ts) | 将 `/context threshold` 路由到配置处理器，补全子命令、帮助和输入提示。复用现有文本输入与确认组件。 |
| [`compaction-policy.ts`](../src/runtime/compaction-policy.ts) 与 [`compaction-settings.ts`](../src/runtime/compaction-settings.ts) | 计算候选策略，通过 Host `configEditor` 合并保存，借助 `agentPresets` 校验并读取生效状态。 |
| [`context-reading.ts`](../src/runtime/context-reading.ts) 与 [`metrics.ts`](../src/runtime/metrics.ts) | 将挂载的路由策略及对应预算接入上下文读数。无请求时使用选中模型，已有请求时按实际路由读取。缺少有效策略时显示未知或禁用状态。 |
| [`src/ui/commands/context-stats.ts`](../src/ui/commands/context-stats.ts) 与 [`status-line.ts`](../src/ui/status-line.ts) | 从同一份上下文读数展示有效检查线并着色。后续模型预算变化而压低检查线时，可区分已配置百分比和当前有效百分比。 |
| [`src/ui/app.ts`](../src/ui/app.ts) | 接线到现有状态刷新和命令生命周期。计算和持久化逻辑留在 runtime 层，遵守单个源文件 1,000 行限制。 |
| [`README.md`](../README.md) 与[排障文档](troubleshooting-context-compaction.md) | 功能完成后补充命令、90% 超预算后建议 77% 的示例、摘要上限与模型切换的影响、生效时机及 preset 升级迁移。 |

## 验收与验证计划

1. **预算与校验**。覆盖默认 33.3%、75% 可达、85% 因当前输出预留超预算、输出预留调整后 85% 可达，以及零余量对显式摘要上限的要求。验证 Qwen 输入 90% 建议 77% 且 78% 仍超预算，覆盖没有可选百分比及取整后恰好用完预算的场景。采用 77% 只调检查线时摘要上限仍为 65,536，另行确认较小上限才变更。覆盖小窗口、未知窗口、摘要上限超过已知摘要模型窗口、保留尾部超预算、非法百分比和跨路由请求头。
2. **配置写入与恢复**。覆盖新增和更新匹配项、多模型、已保存待重载策略、生效层覆盖、并发更新与保存失败。核对其他 preset、工具和 `!!js` 表达式。模拟新版 preset 子插件挂载失败而旧 Agent 仍可读，验证回退成功，以及并发冲突时报告 profile 路径并保留用户的新配置。超预算后给出建议、采用建议进入预览、重新输入和取消时 profile 内容均保持原值。确认保存后才写入，保存过程中取消仍完成写后检查。
3. **升级迁移**。用新版 bundle fixture 修改默认值并新增工具，先确认旧覆盖会遮蔽变更，再按迁移步骤组合配置。验证新版工具和默认值生效、旧有用户自定义正确迁入、目标路由策略仍可读。
4. **TUI 交互**。验证帮助、补全、超预算建议、采用或拒绝建议、保存确认、摘要上限独立确认和 `/reload` 恢复同一 Session。预算变化后应重新预览建议。没有首次 token 用量时仍显示已知检查线。相同事件与用量下更换策略，验证 `/context` 与状态栏更新。覆盖路由切换和自动禁用后的显示。
5. **真实 Host 与非压力路径**。在隔离 rc.5 profile 中从 fake-TTY 配置命令经过 `ConfigEditor` 保存，用 `--dump-config` 核对活动 preset，并在重启后回读策略。使用可压缩的历史验证检查线下方无摘要请求，到达后写入 `compaction/summary`。验证模型切换成功和压缩失败时保留旧路由。通过可控响应检查 `/compact` 和溢出恢复使用保留或显式确认后的摘要上限，并覆盖摘要被截断的失败反馈。分别记录模拟模型触发结果与真实 Qwen 表现。实现后运行定向 Vitest 和 `pnpm check`。

## 实际验证

- `pnpm check` 通过类型检查、Vitest 和构建。回归测试覆盖预算与取整、精确路由匹配、目标策略合并、并发冲突下的回退以及状态栏策略刷新。
- `node scripts/fake-tty-compaction-threshold.mjs` 在隔离的 rc.5 Host、profile 和模拟模型上通过。验证了 90% 建议 77%、取消与确认保存、同一会话重载、切换模型后使用目标模型的检查线、检查线下方无摘要与达到检查线生成摘要。还覆盖了切换失败时保留原路由、溢出恢复沿用摘要上限、手动 `/compact` 的独立上限和截断反馈，以及使用新版 bundle fixture 迁移覆盖项。
- `node scripts/fake-tty-context.mjs` 通过 6 套终端显示组合，确认主屏与全屏的上下文占用和构成图正常。
- 真实 Qwen 模型应用新策略后的摘要长度与效果尚未复测。验收使用临时 profile。
