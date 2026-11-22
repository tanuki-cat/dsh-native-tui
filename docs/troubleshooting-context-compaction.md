# 本地模型自动压缩过早与短片段摘要失败

本地模型的上下文窗口配置可以正常生效，同时出现 `summary is not smaller than the shadowed content`。会话空闲后可先运行 `/compact`。Host 的 `modelPolicies` 支持按模型调整自动压缩时机和保留范围。

## 已复现的现象

| 环境 | 请求窗口 | 自动压缩时的估算占用 | 会话事件 |
|---|---:|---:|---|
| TUI `ptc`，本地 `llama-cpp/qwen3.8-27b` | 147,456 | 首次 58%，后续达到 60% | 七次摘要都选中 10 tokens 的旧片段，完整摘要约 278～435 tokens，均被拒绝。随后手动 `/compact` 成功，占用从 60% 降至 47%。 |
| Web `ptc`，同一本地模型 | 131,072 | 约 53% | 两次自动摘要尝试选中 14 tokens 的片段，生成约 364 和 489 tokens，均被拒绝。 |

数据来自本地持久会话事件的回放。占用率是下一次请求的估算用量除以路由窗口。`compaction/end` 错误里的两个数字分别是**带固定包装的摘要**和**待替换的旧片段**的估算长度。

## 为什么会发生

TUI 和 Web 的 Agent preset 都挂载 Host 的 `@deepseek-ai/dsh-compaction-basic`。Host 在模型步骤前用 `floor(min(窗口 × thresholdRatio, 窗口 − 请求输出预留 − headroomTokens))` 检查压力。以 TUI 复现为例，147,456 窗口、32,768 输出预留和默认 65,536 余量得到 **49,152 tokens（33.3%）** 的检查线。此时减去预留后的预算更小，单独提高 `thresholdRatio` 对这条线没有影响。 [TUI preset](../presets/ptc.patch.yml) · [Host 阈值计算](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/src/config.ts#L169-L197)

Host 超过检查线后还要选出可替换的旧历史。它保留开头的系统提示和最近的对话，并保持工具调用与结果配对。TUI 复现里，系统提示约占 67,961 tokens，最近对话要保留 18,350 tokens。更早的步骤已超过检查线，但选不出片段。首次选出的只有一条 10-token 短消息。固定摘要包装本身约占 98 tokens，已经大于原片段。Host 在生成后拒绝替换，原历史保留。后续步骤仍可能选中同一片段并重新调用模型。 [选区与长度校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/src/region.ts#L117) · [摘要格式](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/compaction/compaction-basic/src/summarizer.ts#L32)

## 官方支持的处理方式

### 恢复当前会话

等当前轮结束，在 `Ready` 状态执行 `/compact`。手动路径以 `retainTokens = 0` 选区，可以使用比自动压缩更长的旧历史，并仍执行最终的摘要长度校验。 [官方手动压缩说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md#on-demand-condensation-with-compact)

### 为本地模型单独调整自动压缩

在 TUI 选中模型后执行 `/context threshold`，或直接输入 `/context threshold 90`。对上述 Qwen 路由，90% 需要 132,710 tokens，扣除请求输出后的预算为 114,688 tokens。面板会给出最高可选的 **77%（113,541 tokens）**。选择建议值后可检查余量和摘要上限，再确认保存。其他路由按自己的 `modelPolicies` 或 preset 默认值计算。`/context` 展示当前会话实际挂载的检查线，保存后若提示待重载，在空闲时执行 `/reload`。

压缩检查线也用于切入该模型的历史检查。摘要输出上限可在预览中单独设置，并影响使用该路由摘要策略的 `/compact` 和溢出恢复。

### 手动维护 profile 配置

1. 确认目标会话的 Agent preset。已经开始的会话恢复时沿用其原有 preset。下例以 TUI 的 `ptc` 为例。
2. 打开当前 profile 的 `cordis.patch.yml`，默认位置为 `~/.dsh/profiles/tui/cordis.patch.yml`。如有自定义 `DSH_HOME` 或 profile，使用对应目录。已有 `preset-ptc` 覆盖时，在其完整 `config.plugins` 中修改。首次覆盖时，从与安装版本对应的 `presets/ptc.patch.yml` 复制 `insert` 下完整的 `preset-ptc` 条目，作为文件顶层的 `- id: preset-ptc` 条目。保留该 preset 的完整 `config`，因为 profile patch 会整体覆盖该字段。宿主层的同名 `compaction-basic` 已禁用。 [ptc patch](../presets/ptc.patch.yml) · [TUI bundle](../cordis.patch.yml)
3. 找到 `preset-ptc.config.plugins` 里的 `compaction` 组，在组的 `config` 列表中编辑已有的 `compaction-basic` 条目。将下面的 `modelPolicies` 合入该条目的 `config`。`provider` 和 `model` 须与会话路由完全一致，已有匹配项时更新该项。

   ```yaml
   - id: compaction-basic
     name: '@deepseek-ai/dsh-compaction-basic'
     config:
       modelPolicies:
         - provider: llama-cpp
           model: qwen3.8-27b
           headroomTokens: 4096
           maxTokens: 4096
           retainTokens: 2048
   ```

   `headroomTokens` 调整检查线，`retainTokens` 控制最近有多少历史原样保留，`maxTokens` 是摘要请求自己的输出上限。这组数值采用官方文档的小窗口示例预算，并沿用默认 `thresholdRatio: 0.8`。对上述 TUI 路由，Host 检查线从 49,152 提升至 **110,592 tokens（75%）**。数值是配置示例，摘要输出上限还要适配所用模型的输出和推理量。 [官方按模型配置示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md#smallest-working-composition)

4. 用 `dsh --profile tui --dump-config` 确认策略出现在所用 preset 的 `compaction` 组里。完成当前轮后执行 `/reload`，或重启并恢复会话。用 `/context` 核对生效的路由和检查线。 [TUI 的上下文读数](../src/runtime/context-reading.ts)

该示例已在隔离的 DSH `v0.2.2-rc.5` profile 中验证配置合成和阈值计算，真实模型表现以应用策略后的会话事件为准。

保存策略会在 profile patch 中保留整份 preset 配置。升级 bundle 时，以新版 preset 为基础重新合入用户配置与 `modelPolicies`，然后用 `--dump-config` 核对新版工具和模型策略。仅为调整检查线创建的覆盖，也可在升级后移除，再通过 `/context threshold` 重新保存。 [迁移步骤](design-task-feature-compaction-threshold-settings.md#preset-升级与迁移)

## 上游状态

截至 2026-11-22，官方 `v0.2.2-rc.5` 和 `master` 仍在模型生成后检查摘要是否更短。社区建议在调用模型前跳过小于固定包装开销的片段，并在同一片段失败后等选区变化再尝试。尚未查到针对这个短片段问题的官方合并修复。 [Web 本地 Qwen 复现与提案 #11314](https://github.com/deepseek-ai/deepseek-harness/discussions/11314) · [短片段检查建议 #4454](https://github.com/deepseek-ai/deepseek-harness/discussions/4454) · [重复摘要 #12071](https://github.com/deepseek-ai/deepseek-harness/discussions/12071) · [当前上游代码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/region.ts#L371-L397)
