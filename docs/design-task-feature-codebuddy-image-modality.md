# 按模型声明 CodeBuddy 输入模态并支持图片输入

> 任务类型：feature ｜ 目标仓库：`dsh-native-tui` ｜ 日期：2026-10-19 ｜ 状态：已实施（含真实账号验收）
>
> 本文件取代 `docs/design-task-feature-codebuddy-builtin-plugin.md` §2 非目标中「不移植图片输入（两条路由声明 text-only）」
> 与 §10「text-only」的结论；该文件其余决策（OAuth、目录、流式、凭据轮换）继续有效，且因其已标记「已实施」而不再修改。

## 1. 目标

`dsh-native-tui/codebuddy` 引入的模型目前一律声明为 text-only。要让输入模态来自模型信息，而不是硬编码：

1. 目录发现时读取网关的 `supportsImages` / `disabledMultimodal`，为每个模型得出 `inputModalities`。
2. `listModels` / `resolveModel` / 未命中兜底都返回真实模态；声明含 `image` 的模型真正发送图片。
3. 声明 text-only 的模型仍由 Host 投影为占位文本，`wire.ts` 保留自己的拒绝兜底。
4. 可选地允许插件配置按模型覆盖（网关字段不准或企业版差异时使用）。

## 2. 非目标

- 不改 `llm-pi-ai` 的 `/provider` 流程与任何其它 provider 路由。
- 不实现图片计费（`imageRequestPricing`）与图片 offload 预算钳制（`IMAGE_OFFLOAD_REQUIRED`），只做尺寸/字节目标投影。
- 不引入新的运行时依赖；`attachments` 仍按结构性接口访问。
- 不做 capability 探测式自动纠错（例如发送失败后自动降级该模型模态）。

## 3. 关键事实（已核对，2026-10-19）

### 3.1 网关目录带模态字段

`GET /v3/config` 的模型条目字段集合（CN，34 个模型）：

```text
canDisableThinking, credits, descriptionEn, descriptionZh, disabledMultimodal,
iconUrl, iconUrl_en, id, maxAllowedSize, maxInputTokens, maxOutputTokens,
name, onlyReasoning, reasoning, relatedModels, summary, supportsImages,
supportsReasoning, supportsToolCall, tags, temperature, top_p, vendor
```

EN（www.workbuddy.ai，27 个模型）字段一致，另有 `contextWindow`。`deepseek-v4.1-flash` 实测条目：

```json
{ "id": "deepseek-v4.1-flash", "supportsImages": true, "supportsToolCall": true,
  "maxInputTokens": 1000000, "maxOutputTokens": 128000, "vendor": "f",
  "reasoning": { "canDisableThinking": true, "defaultEffort": "high",
                 "summary": "auto", "supportedEfforts": ["low", "high", "max"] } }
```

`supportsImages` 在两个部署中都是布尔值；`default`、`glm-5.0`、`hunyuan-chat` 为 `false`，`disabledMultimodal` 只出现在少数条目上（`true` 与 `false` 均有）。

### 3.2 字段可信度：false 不总是假的

用 64×64 上红下绿 PNG 直接请求 `POST /v2/chat/completions`：

| 模型 | `supportsImages` | 实测 |
|---|---|---|
| `deepseek-v4.1-flash` | true | `red/green`（正确） |
| `glm-5.3-flash` | true | `red/green`（正确） |
| `default` | false | `red/green`（**实际能看图**） |
| `glm-5.0` | false | `red/green`（**实际能看图**） |
| `hunyuan-chat` | false | 「I'm unable to view or analyze images」（一致） |

结论：`supportsImages === true` 可信；`false` 表示「网关不承诺」，但上游可能仍然能看图。因此默认策略只能是
「true → 声明 image；其余 → text-only」，并对 false 提供配置覆盖出口。

补充：探测中 `minimax-m2.5` 返回 400 / code 11102（`model ... service info not found`，账号未开通），这类模型无论声明如何都无法调用，不参与能力判断。

### 3.3 图片块可用 `image_url` base64，user 与 tool 角色都接受

同一账号同一张图：

- user 消息 content 数组内 `{type:'image_url', image_url:{url:'data:image/png;base64,...'}}` → 200，回答 `Red`。
- `role:'tool'` 的 `content` 用同样的数组（含 text + image_url）→ 200，回答 `Blue`。

即工具截图回传图片在本路由可行（这是 TUI 里 `/attach` 之外图片最主要的来源之一）。

### 3.4 Host 的模态门禁位置

`@deepseek-ai/dsh-llm` 的 `adapterStream`（`lib/index.js` 约 2337 行）：

```js
if (modelInfo.inputModalities !== undefined
    && !modelInfo.inputModalities.includes('image')
    && projectedMessages.some(message => contentHasImage(message.content))) {
  projectedMessages = projectImagesForTextModel(projectedMessages)
}
```

- 只有 `inputModalities === undefined` 或含 `image` 时图片才原样下发。
- 声明 text-only 时图片被替换为 `[image omitted because this model accepts text only; attachment sha256:…]`。
- `normalizeModelInfo` 对 `inputModalities` 只做浅拷贝、不校验取值（`detachedModalities`），适配器返回什么就按什么门禁。
- 因此 **当前 `inputModalities: ['text']` 的真实表现是「图片被静默换成占位文字」，不是报错**。

其它 Host 侧门禁同样读这个字段：`session-controller` 的 `prompt()` 在收到图片且 `!inputModalities.includes('image')` 时抛 `session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`。

### 3.5 参考实现的缺口

被移植的 `dsh-router-codebuddy@0.3.22` 目录解析只读 `id/maxInputTokens/tags`，所以 `supportsImages` 整条链路从未接上；`pi-codebuddy-provider` 也明确在 README 记录「Image input is never declared」。本文件即修正该决定。

### 3.6 现有代码的硬编码点

| 文件:行 | 现状 |
|---|---|
| `src/codebuddy/models.ts:35-42` `RawModel` | 无 `supportsImages` / `disabledMultimodal` |
| `src/codebuddy/models.ts:102-115` `toCatalogueModel` | 不产出模态 |
| `src/codebuddy/models.ts:144-151` `seedCatalogue` | 无模态 |
| `src/codebuddy/adapter.ts:142` `listModels` | `inputModalities: ['text'] as const` |
| `src/codebuddy/adapter.ts:164` 未命中兜底 | `inputModalities: ['text']` |
| `src/codebuddy/adapter.ts:178` `modelInfo` | `inputModalities: ['text']` |
| `src/codebuddy/wire.ts:37-55` | `assertNoImages` 抛 `UNSUPPORTED_CONTENT`；`userContent` 只拼 text |
| `src/codebuddy.ts:80-84` | adapter 没有 attachments 注入点 |

## 4. 方案

### 4.1 目录解析（`src/codebuddy/models.ts`）

```ts
export interface CatalogueModel {
  // …现有字段
  /** Modalities the gateway states for this model; text-only unless it states images. */
  readonly inputModalities: readonly ('text' | 'image')[]
}

/** Media types the chat endpoint accepts; everything else stays text-only. */
const TEXT_ONLY = ['text'] as const
const TEXT_AND_IMAGE = ['text', 'image'] as const

export function inputModalitiesOf(raw: { supportsImages?: unknown; disabledMultimodal?: unknown }): readonly ('text' | 'image')[] {
  if (raw.disabledMultimodal === true) return TEXT_ONLY
  return raw.supportsImages === true ? TEXT_AND_IMAGE : TEXT_ONLY
}
```

- 只有严格 `true` 才声明 image；缺失、`false`、非布尔一律 text-only。
- `disabledMultimodal === true` 优先于 `supportsImages === true`（防止两个字段冲突时误开图片）。
- `seedCatalogue` 产出 `['text']`：seed 列表本来就是「未验证的兜底」，不能承诺图片能力。

### 4.2 适配器映射（`src/codebuddy/adapter.ts`）

- `listModels`：`inputModalities: model.inputModalities`。
- `modelInfo`（目录命中）：`inputModalities: known.inputModalities`。
- `modelInfo`（未命中）：保持 `['text']`，理由写进注释：手填模型 id 没有能力声明，宁可保守。

### 4.3 图片序列化（`src/codebuddy/wire.ts`）

`buildChatPayload` 变为异步并接收附件读取器：

```ts
/** Reads one request-sized image version; absent when the composition mounts no attachment service. */
export interface WireImageReader {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string }>
}

export interface WireImageOptions {
  /** Attachment reads; absent when this composition mounts no attachment service. */
  readonly reader?: WireImageReader
  /** Report one degraded image (placeholder substituted for bytes). */
  readonly onDiagnostic?: (message: string) => void
}

export async function buildChatPayload(
  options: GenerateOptions,
  profile: CodeBuddyProfile,
  resolveFileText?: (ref: unknown) => string,
  images?: WireImageOptions,
): Promise<Record<string, unknown>>
```

调用点（`adapter.ts` 的 `streamWithProfile`）在取到 token 之后：

```ts
const payload = await buildChatPayload(options, profile, this.config.resolveFileText, {
  reader: this.config.resolveAttachments?.(),
  onDiagnostic: message => this.config.onDiagnostic?.(profile.id + ': ' + message),
})
```

规则：

1. `user` 与 `tool` 两个角色允许图片；其它角色保持现有拒绝（system/assistant 带图属于上游请求错误）。
2. 一条消息里没有图片时保持字符串 content 不变（避免无意义的数组化，减小请求体、保住现有断言）。
3. 有图片时 content 变为 parts 数组：text 块 → `{type:'text', text}`；image 块 → `{type:'image_url', image_url:{url:'data:<mediaType>;base64,<bytes>'}}`；file 块 → 现有 handle 文本。
4. 图片字节经 `images.reader.readImageRequest(ref, target, signal)` 取得；`target` 由 `imageTargetOf(ref)` 投影（见 4.4）。
5. 读取失败或 `images.reader === undefined` 时：该图降级为稳定占位文本 `[image unavailable: attachment sha256:…]`，并通过 `images.onDiagnostic` 留痕，**不**让整轮失败（与 `dsh-router-core` 的 issue #8 教训一致）。
6. 保留 `assertNoImages` 对 user/tool 以外角色的检查，错误文案改为指名角色。

### 4.4 图片请求目标（新增 `imageTargetOf`）

```ts
const MAX_REQUEST_PIXELS = 2048 * 2048   // 与 llm-pi-ai 的 DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET 对齐
const MAX_REQUEST_BYTES = 1024 * 1024    // 与 DEFAULT_REQUEST_IMAGE_MAX_BYTES 对齐

export function imageTargetOf(ref: ImageAttachmentRef): ImageRequestTarget {
  // 等比缩到 maxPixels 以内，只缩不放；maxBytes 交给附件服务按质量阶梯处理
}
```

投影算法直接照抄 `@deepseek-ai/dsh-attachment` 的 `requestImageDimensions(width, height, maxPixels)`
（等比、只缩不放、面积严格不超预算）；本插件不 import 该包，按现有惯例在 `wire.ts` 内实现同名纯函数并单测。

为什么对齐 pi-ai 而不是无限大：请求体是 base64 内联，原图像素与字节都会线性放大请求体；
`llm-pi-ai` 的默认预算（2048² 像素 / 1 MiB）是 Host 侧已验证可用的组合，本路由直接沿用。

同时对 adapter 增加 `imageRequestTarget(provider, model, image)` 覆写，返回同一投影：Host 的 token meter 与 cua 等消费方用它计算请求图尺寸，必须与 wire 实际发送的一致。

### 4.5 依赖注入（`src/codebuddy.ts`、`src/codebuddy/adapter.ts`）

`CodeBuddyAdapterOptions` 增两项：

```ts
/** Host attachment capability for request-sized images; absent means the composition cannot send images. */
resolveAttachments?: () => {
  readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment>
} | undefined
/** Observe a degraded image (placeholder text substituted for bytes). */
onDiagnostic?: (message: string) => void   // 已存在，复用
```

插件入口注入 `() => ctx.get('attachments')`。仍是结构性本地接口，不新增包依赖（`@deepseek-ai/dsh-attachment` 只作为 type-only 引用或本地结构声明）。

### 4.6 可选：按模型覆盖

插件 config 增加：

```yaml
- id: codebuddy
  name: dsh-native-tui/codebuddy
  config:
    models:
      default: { input: [text, image] }   # 例：网关说 false 但实测能看图
```

- 键为模型 id，值为 `{ input?: ('text'|'image')[] }`。
- 覆盖优先于目录字段；目录刷新不丢弃覆盖。
- 同时作用于 `listModels` 与 `resolveModel`，保证两处一致。
- 建议同一提交内提供 `/codebuddy models` 子命令展示「模型 / 声明 / 来源（catalog|override|seed）」，否则用户看不到覆盖是否生效。

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `src/codebuddy/models.ts` | `CatalogueModel.inputModalities`；`inputModalitiesOf`；`toCatalogueModel` / `seedCatalogue` 产出模态 |
| `src/codebuddy/adapter.ts` | 三处模态取值；`imageRequestTarget` 覆写；`resolveAttachments` 注入；覆盖表查询 |
| `src/codebuddy/wire.ts` | `buildChatPayload` 异步化；user/tool 的 `image_url` parts；占位降级；`imageTargetOf` |
| `src/codebuddy.ts` | 注入 `resolveAttachments` 与覆盖配置；`Config` schema 增 `models` |
| `tests/codebuddy-protocol.spec.ts` | `inputModalitiesOf` 真值表；payload 的 image_url 结构；无图时仍为字符串 content |
| `tests/codebuddy-adapter.spec.ts` | `listModels` / `resolveModel` 模态；未命中兜底仍 text-only；`imageRequestTarget` |
| `tests/codebuddy-stream.spec.ts` | 图片路径的端到端 body 断言；占位降级断言 |
| `README.md` | §CodeBuddy 一节的限制说明从「text-only」改为「按目录声明，可配置覆盖」 |
| `docs/progress-dsh-native-tui.md` | 追加一条进度记录 |

### 5.1 需要同步修改的既有测试

`buildChatPayload` 异步化会让现有调用点全部失效，涉及：

| 文件 | 位置 | 改法 |
|---|---|---|
| `tests/codebuddy-protocol.spec.ts` | 2 处 `buildChatPayload(...)`（第 44、53 行） | 加 `await`，所在 `it` 改为 `async` |
| `tests/codebuddy-stream.spec.ts` | 3 处直接调用 + 1 处 `expect(() => …).toThrowError(/text-only/u)`（第 47、75、100、103、104 行） | 前 3 处加 `await`；拒绝断言改为 `await expect(…).rejects.toThrowError(/text-only/u)` |

## 6. 影响范围

- 仅 `codebuddy` / `codebuddy-en` 两条路由的行为变化；其它 provider 不受影响。
- 已登录用户在目录刷新（TTL 5 分钟或 `/codebuddy models refresh`）后即获得新模态，无需迁移配置。
- 声明 image 的模型会让 `session-controller` 的图片预检放行；这是本任务的目的，也意味着「网关声明不准」时错误会延后到上游返回 400。
- 请求体在含图时从字符串 content 变为 parts 数组；不含图的消息形态不变。

## 7. 验证方式

1. 单测：上述三个 spec 文件；重点覆盖
   - `supportsImages` 为 `true`/`false`/缺失/非布尔，`disabledMultimodal` 为 `true` 的组合；
   - 含图消息的 `image_url` 是 data URI 且 base64 字节与附件一致；
   - 读图失败时退化为占位文本且不抛错；
   - 纯文本请求体与改动前逐字节一致。
2. `pnpm check`（typecheck + vitest + build）。
3. 真实 Host 冒烟：`scripts/fake-tty-codebuddy.mjs` 增一条「带图 prompt 通过 mock 网关」用例。
4. 真机验收（需真实账号，本仓库历史未做过）：
   - `/model` 选择 `deepseek-v4.1-flash`，`/attach` 一张上红下绿图，提问颜色，回答正确；
   - 切到 `hunyuan-chat`（声明 false），确认图片被投影为占位文本而不是发往上游；
   - `/codebuddy models` 展示各模型声明与来源。

## 8. 验收标准

1. 目录命中且 `supportsImages === true` 的模型，`resolveModel` 返回的 `inputModalities` 含 `image`，带图 prompt 能到达 wire 并以 `image_url` 发出。
2. `supportsImages === false` 或缺失的模型保持 text-only，Host 仍按占位文本投影。
3. 未登录（seed 列表）与手填未命中模型仍为 text-only。
4. 附件服务缺失或读图失败不中断对话，且有诊断输出。
5. `pnpm check` 通过；`scripts/fake-tty-codebuddy.mjs` 带图用例通过。

## 9. 已知限制

- `supportsImages === false` 并不等于不能看图（实测 `default`、`glm-5.0` 可以），默认仍按 text-only 处理，需要用户用 `config.models` 覆盖。
- 图片计费（visual tokens）未接入 token meter，用量面板会低估图片请求成本。
- 图片只允许出现在 user 与 tool 角色；assistant 回放态带图仍会拒绝（developer 消息整条丢弃，带图不再报错）。
- TUI 的 `/attach` 在贴图时会对 text-only 模型给出提示，但这是提示而非拦截：终端直接把 prompt 交给 agent，不经过 session-controller 的准入检查。

## 10. 实施顺序建议

1. `models.ts` + 单测（纯函数，风险最低）。
2. `adapter.ts` 模态映射 + 单测。
3. `wire.ts` 异步化与 `image_url` + 单测；按 §5.1 调整既有测试调用点。
4. `codebuddy.ts` 注入与 `imageRequestTarget` 覆写。
5. 覆盖配置与 `/codebuddy models`（可拆为后续提交）。
6. 文档与 `pnpm check`。

## 11. 实施结果（实施后追加）

按 §10 顺序一项完成，全部改动集中在 `src/codebuddy/` 与插件入口，未新增依赖。

| 位置 | 实际实现 |
|---|---|
| `src/codebuddy/models.ts` | `InputModality` / `TEXT_ONLY` / `TEXT_AND_IMAGE`；`inputModalitiesOf`；`CatalogueModel.inputModalities`；seed 一律 text-only |
| `src/codebuddy/adapter.ts` | `modalitiesOf`（覆盖优先，无 attachment 服务回退 text-only）；`imageRequestTarget` 覆写；`models(profileId)` 摘要（含 `source` 与 `statedModalities`）；`resolveAttachments` / `models` 选项 |
| `src/codebuddy/wire.ts` | `buildChatPayload` 异步；`contentOf` 在有图时输出 parts；`imagePartOf` 读字节或降级；`assertImageRole` 只放行 user/tool；`imageTargetOf` + `projectedDimensions` |
| `src/codebuddy.ts` | `Config.models` schema；`resolveAttachments: () => ctx.get('attachments')`；`CodeBuddyService.models` |
| `src/runtime/codebuddy-command.ts` | `/codebuddy models [cn|en|all]` 列表子命令 |
| `src/ui/commands/catalog.ts` | 帮助行与补全 hint 同步 |

与 §4 的偏差：

1. `WireImageReader` 的 `signal` 归入 `WireImageOptions.signal`，并在 `buildChatPayload` 内回退到 `options.signal`，调用点少传一个参数。
2. `models()` 与 §4.6 建议的「来源」一致，但把「声明」与「实际」分成 `statedModalities` / `inputModalities` 两个字段，这样「目录说有图、组合里没有 attachment 服务」这一状态在 `/codebuddy models` 里直接可见。
3. 覆盖命中的模型在 `listModels` 与 `resolveModel` 中使用同一 `modalitiesOf`，但未命中目录的手填 id 仍固定 text-only（覆盖对它无效，见 §4.2）。

验证结果：

- `pnpm check`：typecheck、**35 个测试文件 / 355 个测试**、build 全部通过（改动前 352 个）。
- 新增单测覆盖 `inputModalitiesOf` 真值表、payload 的 `image_url` 结构、tool 角色图片、占位降级与诊断、角色拒绝、adapter 的目录/覆盖/无 attachment 三种模态路径、`/codebuddy models` 输出。
- 新增 `scripts/codebuddy-image-e2e.mjs`（真实账号）：目录模态、`resolveModel` 一致性、未命中兜底、user 图（`red/green`）、tool 图（`red/green`）、占位降级、诊断、角色拒绝 9 项全 PASS；无凭据环境自动 SKIP 3 项联网检查。
- 真机结论已回写 §3.2：`supportsImages: false` 的 `default`、`glm-5.0` 实际可读图，因此默认保守并保留覆盖表。

## 12. 审查后修复（2026-10-19）

实施后做了一次独立审查，逐条复现并修复：

| # | 问题 | 复现 | 修复 |
|---|---|---|---|
| 1 | `offloaded` 标记被忽略，已卸载的图仍重发字节 | 读图调用 1 次、输出含 `image_url` | `imagePartOf` 对 `offloaded === true` 输出 `offloadedImageText`，`requestImageRefs` 直接跳过 |
| 2 | 空覆盖 `input: []` 被当成「什么模态都不声明」 | `Config({models:{x:{}}})` → `input: []` → `inputModalities: []` | 新增 `overrideOf`：空数组视为无覆盖，目录/seed 生效；`source` 同步回落 |
| 3 | attachment 解析抛错会炸掉 `listModels`/`resolveModel` | 三处均抛 `host service resolution failed` | `attachmentService()` 捕获并降级为「无服务」，同时写诊断 |
| 4 | developer 带图从「整条丢弃」变成抛错 | `developer+image` 触发 `UNSUPPORTED_CONTENT` | 角色检查跳过 developer（它本就不发往该端点） |
| 5 | 同一附件重复读取 | 2 次出现 → 2 次 `readImageRequest` | 先按 `attachmentId` 去重再读 |
| 6 | 图片读取完全串行 | 4 张 30 ms 的图耗时 124 ms，峰值并发 1 | `prepareImages` 用 `Promise.all` 并发，消息拼装转为同步 |
| 7 | 每个模型都查一次 attachment 服务 | 8 个模型 16 次调用 | 每次 listing / 每次 `modelInfo` 只查一次 |
| 8 | 长会话图片无上限（`IMAGE_OFFLOAD_REQUIRED` 未实现，Host 的 `compaction-image-offload` 无法生效） | — | 新增 20 MiB 内联预算 + `requiredImageOffload`，超限抛 `IMAGE_OFFLOAD_REQUIRED` 并携带 `offloadImages`（已实测经 `failure` 快照透传） |
| 9 | TUI 贴图给 text-only 模型无任何提示 | — | `/attach`（文件与剪贴板两条路径）在暂存图片后查询 `resolveModelInfo`，无 `image` 时给 warning |

复测：`pnpm check` 35 files / 363 tests 通过；`scripts/codebuddy-image-e2e.mjs` 9 项全 PASS；`fake-tty-codebuddy.mjs` 6 项、`fake-tty-codebuddy-models.mjs` 5 项 PASS。

### 12.1 预算作用域修正（同日二次审查）

首版 `assertImagesFit` 把 `options.messages` 全部计入预算，包含两类根本不会发送的消息：

| 场景 | 修正前 | 修正后 |
|---|---|---|
| developer 消息带图（本路由此消息整条丢弃） | 12 MiB 的图也被计入，仅一张有效图片的请求被判超预算 | 只按 `carriesImages` 过滤后的 user/tool 消息计价 |
| assistant 消息带图（本路由拒绝该角色） | 先报 `IMAGE_OFFLOAD_REQUIRED`，掩盖了真正可操作的 `UNSUPPORTED_CONTENT` | 角色检查提前到任何图片工作之前 |

实现：新增 `sendingMessages()`（`messages.filter(carriesImages)`），`buildChatPayload` 先逐条 `assertImageRole`，再对过滤后的消息做预取与预算；`wireMessage` 内的重复角色检查随之移除。

新增两个回归测试（stream 23 → 25）：developer 图片不占预算、assistant 图片先报角色错误。独立验证脚本确认四项：developer 图不占预算、角色错误先于预算、真实超预算仍报 `IMAGE_OFFLOAD_REQUIRED/1`、被丢弃的 developer 图完全不被读取。`pnpm check` 35 files / **365 tests** 通过。

仍保留的限制：

- 手填未命中目录的模型 id 固定 text-only（覆盖对它无效）。
- `IMAGE_OFFLOAD_REQUIRED` 的实际降级依赖组合里挂载 `dsh-compaction-image-offload`；TUI profile 的 base bundle 已包含该行。
- `/attach` 的模态提示对所有 provider 生效，不限 CodeBuddy；这是刻意保留的通用行为。
