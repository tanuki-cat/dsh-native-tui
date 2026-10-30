# Codex 模型目录原生刷新（/codex models refresh）

> 任务类型：feature ｜ 目标仓库：`dsh-native-tui` ｜ 状态：**已实施（2026-10-30），待真实账号验收**
> 日期：2026-10-30 ｜ 核对基线：DSH `0.2.2-alpha.2`、`@earendil-works/pi-ai@1.4.0`、`codex-cli 0.165.0`
> 前置文档：[TUI 内登录 ChatGPT Codex 并使用其模型](design-task-feature-codex-login-and-models.md) §3.2 的 P2「从账号目录补全 pi-ai 未收录的新模型」

## 1. 结论

采用**方案 A**：TUI 自带 Codex 目录客户端，用户**显式**执行 `/codex models refresh`，从账号目录拉取全量模型 → 预览缺失项 → 确认 → 写入 `llm-pi-ai.providers.openai-codex.models`。不修改宿主 `dsh-llm-pi-ai`、pi-ai 或推理协议，不改手动编辑配置文件的既有路径（只是不再需要它）。

同时修复审查发现的 P1：`/provider models openai-codex` 目前会把**静态 7 条**写成显式列表并降级推理等级，改成拒绝并指向新命令。

已确认的 4 个决策：

| 决策 | 结论 |
|---|---|
| 入口 | 只做 `/codex models refresh`，不做每次 `/codex models` 隐式联网 |
| 触发 | 显式触发（用户敲命令 → 预览 → 二次确认） |
| `client_version` | 复用 dsh-codex 语义：`DSH_CODEX_CLIENT_VERSION` → `codex --version` 探测 → 内置常量 |
| 恢复原生目录 | 本次不做，列为待办（§10） |

## 2. 关键事实（已核对）

| 事实 | 依据 |
|---|---|
| pi-ai 1.4.0 原生目录只有 7 条，缺 `gpt-6.1-terra` | 直接实例化 `openaiCodexProvider().getModels()`：`gpt-5.6-luna/sol/terra`、`gpt-6-astra`、`gpt-6-luna/sol`、`gpt-6.1-sol` |
| Codex CLI 目录有 10 条，其中 8 条 `visibility=list` | `codex debug models`（0.165.0）；与 `~/.codex/models_cache.json`（`fetched_at` 2026-10-28，`client_version` 0.165.0）一致 |
| 远端独有条目是 `gpt-6.1-terra`（500k 窗口，含 `ultra`） | 同上 diff |
| 宿主 `discoverModels` 对已知 provider **先回放安装目录，不发请求** | `dsh-llm-pi-ai/lib/index.js` `discoverModels` 首个分支：`catalogModels(provider).size > 0` 直接返回 |
| 宿主不列举 `openai-codex-responses` | 同文件 `LISTABLE_PROTOCOLS` 只含 `anthropic-messages`/`openai-completions`/`openai-responses`；命中即抛 `DISCOVERY_UNSUPPORTED`；注释写明 Codex 走 OAuth 故排除 |
| `/provider models <route>` 会把发现的模型写成显式 `models` | `src/ui/commands/provider.ts` `fetchProviderModels` → `src/runtime/providers.ts` `mergeDiscoveredProviderModels` |
| 该合并给新条目的推理等级固定为 `{low, medium, high}` | `src/runtime/providers.ts` `DEFAULT_REASONING_EFFORTS`；新条目走 `current === undefined` 分支 |
| 显式 `models` 整体替换原生目录 | 宿主解析：`configured.length > 0` 才覆盖，空数组等价缺省 |
| 设置写入已有路径寻址 + 冲突重试一次 | `src/runtime/settings-write.ts` `writeSettingsOps`（`SETTINGS_CONFLICT`） |
| 宿主 settings 服务暴露可写标志 | `@deepseek-ai/dsh-settings` `lib/index.js` 的 `get writable()`；TUI 的 `SettingsAccess` 切片尚未声明该字段 |
| 注册确认可复用有界轮询 | `src/codex/route.ts` `waitForProvider`（25 × 200ms） |
| 凭据 seam 只有读/删，不能刷新 | `src/codex/types.ts` `CredentialStoreLike` |
| 凭据跨 profile 共享，settings 按 profile 独立 | `~/.dsh/dsh-auth/credentials.json`；`~/.dsh/profiles/<p>/cordis.patch.yml` |
| 远端目录端点与鉴权 | `GET https://chatgpt.com/backend-api/codex/models?client_version=…`，`Authorization: Bearer` + `chatgpt-account-id`，响应 `{ models: [...] }`（dsh-codex `model-patches.ts` 于 2026-10-07 实测；本次用 `codex debug models` 复核条目形状与 `visibility` 语义） |
| TUI 已有直连 ChatGPT backend 的先例 | `src/codex/usage.ts` `fetchCodexUsage`：`redirect: 'error'`、`AbortSignal.timeout`、体积上限、401/403/429 映射 |

## 3. 范围

### 3.1 本方案包含

- 新模块 `src/codex/catalog.ts`：版本解析、远端拉取、目录解析、合并计划（纯函数）。
- `/codex models refresh`：校验前置条件 → 拉取 → 预览 → 确认 → 写入 → 注册确认。
- `/codex models` 行为不变（只读当前注册目录），未知子命令回落到 usage 文本。
- `/provider models openai-codex` 守卫（P1 修复）。
- 帮助文案（`CODEX_USAGE`、`/help`、`/` 菜单的 `codex` 子命令）与 README 命令表/排障表同步（`README.md` 第 185、376–380 行附近）。
- 单测：`tests/codex-catalog.spec.ts`（新增）、`tests/codex-command.spec.ts`、`tests/commands.spec.ts`（守卫需要命令上下文，纯函数 spec 覆盖不到）；fixtures 扩展。
- fake-TTY 探针新增「无凭据 refresh 不联网、不写入」用例。

### 3.2 非目标（本次不做）

- `/codex models restore`（恢复原生目录）——见 §10。
- 登录成功后自动刷新目录、后台轮询、ETag/条件请求缓存。
- 多账号切换、目录与账号可见性的交叉校验。
- 改动宿主 `discoverModels`、pi-ai 静态目录或推理协议。
- 声明 `ultra` 推理等级（宿主 schema 无法表达）。

## 4. 方案总览

~~~text
/codex models refresh
  └─ src/runtime/codex-command.ts  models(deps, 'refresh')
       ├─ 前置检查
       │    ├─ routeProfile(settings)   → missing: 提示 /codex setup；blocked(apiKeyEnv): 拒绝
       │    ├─ credentials.readRecord   → absent/incomplete/expired: 拒绝并给出下一步
       │    └─ accountId 来自 JWT claims 或 grant.accountId
       ├─ resolveClientVersion()
       │    ├─ DSH_CODEX_CLIENT_VERSION（非法 → 拒绝，不静默回退）
       │    ├─ probe: codex --version（1.5s 上限）
       │    └─ 内置常量
       ├─ fetchCodexCatalog()          → src/codex/catalog.ts
       ├─ planCatalogPatch(existing, native, entries) → 纯函数，产出 added / proposed / limited
       ├─ 预览 + 确认（choose 对话框）
       ├─ writeSettingsOps('llm-pi-ai', [set providers.openai-codex.models])  [冲突重试一次]
       └─ waitForModels(llm, proposed[].id)  有界确认 5s；失败只报告，不回滚
~~~

不新增 Host 插件，不新增依赖；Deps 仍由 `src/ui/commands/codex.ts` 注入。

## 5. 命令规格

| 命令 | 行为 |
|---|---|
| `/codex models` | 只读：列出当前注册的 `openai-codex` 模型（与现状一致） |
| `/codex models refresh` | 拉取账号目录 → 预览 → 确认 → 写入显式列表 → 有界确认注册 |
| `/codex models help`、其它参数 | 打印 `CODEX_USAGE`，不联网、不写入 |

### 5.1 输出示例

~~~text
/codex models refresh
openai-codex: remote catalogue 8 models · client_version 0.165.0 (codex-cli)
  current   7 models (native pi-ai catalogue)
  add       gpt-6.1-terra   500000 ctx · 128000 out · text+image
  omitted   ultra  (gpt-6.1-terra, gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra)
  unlisted  —  (registered models the listing does not carry)
Write the explicit model list (8 entries)?
~~~

~~~text
/codex models refresh
openai-codex: 8 models registered. Added gpt-6.1-terra.
~~~

~~~text
/codex models refresh
Codex: not signed in — run /codex login
~~~

~~~text
/codex models refresh
openai-codex: cannot read the catalogue — the credential expired and pi-ai refreshes it on the next request; send one message or run /codex login, then retry.
~~~

~~~text
/codex models refresh
openai-codex: no models to add; the listing matches the registered catalogue.
~~~

## 6. 模块设计

### 6.1 `src/codex/catalog.ts`（新文件，约 230 行）

常量：

| 常量 | 值 | 理由 |
|---|---|---|
| `CODEX_MODELS_URL` | `https://chatgpt.com/backend-api/codex/models` | 与 dsh-codex 同一来源 |
| `CATALOG_TIMEOUT_MS` | `7000` | 交互命令，留出预览确认时间 |
| `MAX_BODY_BYTES` | `4 * 1024 * 1024` | 目录是单页 JSON；超限视为异常代理 |
| `MAX_MODELS` | `500` | 拒绝异常体量与分页误读 |
| `MIN_LEVELS` / `LEVELS` | `off,minimal,low,medium,high,xhigh,max` | 对齐宿主 `THINKING_LEVELS` |
| `BUILTIN_CLIENT_VERSION` | `0.165.0` | 随包冻结；CLI 探测通常优先 |

类型：

~~~ts
export type CatalogReason =
  | 'cancelled' | 'not-signed-in' | 'credential-expired' | 'permission-denied'
  | 'rate-limited' | 'network-error' | 'timeout' | 'invalid-response' | 'version-invalid'

export interface CatalogEntry {
  readonly id: string
  readonly name?: string
  readonly contextWindow: number
  readonly maxTokens?: number
  readonly input: readonly ('text' | 'image')[]
  /** Level → wire spelling; absent when the model declares none. */
  readonly efforts?: Readonly<Record<string, string | null>>
  /** Levels the listing declared that this host cannot express. */
  readonly omitted: readonly string[]
}

export type CatalogResult =
  | { readonly kind: 'ok'; readonly entries: readonly CatalogEntry[]; readonly limited: readonly { id: string; omitted: readonly string[] }[]; readonly total: number }
  | { readonly kind: 'unavailable'; readonly reason: CatalogReason; readonly status?: number }
~~~

函数：

- `resolveClientVersion(env = process.env.DSH_CODEX_CLIENT_VERSION, probe = defaultProbe)` → `{ value, source: 'environment' | 'codex-cli' | 'builtin' } | { error: 'version-invalid' }`。语义与 dsh-codex `host-catalog.ts` 一致：环境变量存在但非法 → 直接失败，**不**回退；探测超时/失败 → 内置常量。
- `fetchCodexCatalog(options)`：`{ access, accountId, clientVersion, signal, fetcher?, timeoutMs? }`。请求约束与 `fetchCodexUsage` 同构：`redirect: 'error'`、`AbortSignal.any([signal, timeout])`、`content-type` 校验、有界读取（累计字节而不是只看 `content-length`）、401/403/429 分别映射，`signal.aborted` 优先判 `cancelled`。
- `parseRemoteCatalog(value)`：根对象只允许 `models` 一个键（其它键视为另一种载荷）；数组长度 1–500；slug 正则 `/^[a-z0-9][a-z0-9._-]{0,100}$/`；重复 id 直接判无效；`visibility !== 'list'` 跳过；`context_window` 缺失时回退 `max_context_window`；`input_modalities` 缺省为 `['text']`，只接受 `text`/`image`；`supported_reasoning_levels` 必须为数组，未申报等级的模型跳过；全部条目都被跳过 → `invalid-response`。

### 6.2 版本解析

| 顺序 | 来源 | 非法/失败时 |
|---|---|---|
| 1 | `DSH_CODEX_CLIENT_VERSION` | 非语义版本或超 64 字符 → 拒绝并要求修正，**不回退** |
| 2 | `codex --version` 探测（1.5s、4096 字节） | 解析不出 → 进入下一页 |
| 3 | `BUILTIN_CLIENT_VERSION` | —— |

预览会显示 `client_version` 与实际来源，便于排障（与 dsh-codex 的 `clientVersionSource` 一致）。

### 6.3 合并计划（纯函数，便于单测）

~~~ts
export interface CatalogPlan {
  readonly added: readonly CatalogEntry[]
  readonly preserved: readonly string[]      // 已有显式条目 id，原样保留
  readonly proposed: readonly unknown[]      // 写入 settings 的完整数组
  readonly unlisted: readonly string[]       // 已注册但远端未列出的 id
  readonly limited: readonly { id: string; omitted: readonly string[] }[]
  readonly unsupported: number
}

export function planCatalogPatch(
  existing: unknown,                 // 当前 providers.openai-codex.models
  native: readonly { id: string }[],  // llm.listModels 当前结果
  listing: CatalogListing,            // 可读的远端目录
): CatalogPlan | { readonly error: 'config-unmergeable' }
~~~

规则：

1. 已有条目必须是含字符串 `id` 的对象，否则整单拒绝（不猜测、不修补）。
2. `proposed` = 已有条目（原顺序、原字段，含用户自定义 `contextWindow`/`reasoningEfforts`）+ 缺失的 `native` id + 缺失的远端条目。
3. 按 id 去重；已有条目**永不改写**（用户显式声明的容量即使与远端不同也保留，只在预览里提示差异）。
4. 远端条目转本地条目：`id` 原样；`name` 取 `display_name`（≤150 字符，缺失回退 id）；`contextWindow` 必填；`maxTokens` 取 `max_output_tokens`，缺失时用 `DEFAULT_CODEX_MAX_OUTPUT_TOKENS = 128000` 并在预览标注「声明值」；`input` 排序去重；`reasoningEfforts` 只声明远端申报且宿主可表达的等级（`ultra` 进 `omitted`），额外按 pi-ai 惯例补 `minimal: 'low'`（仅当远端申报 `low`）；远端没有任何可表达等级时该条目跳过并计入 `unsupported`。
5. `added` 为空时不写入，只报告 `omitted`/`unlisted`。

### 6.4 写入与注册确认

- 写入：`writeSettingsOps(settings, 'llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: plan.proposed }], revision)`，沿用「冲突重试一次」，其它错误直接上报。
- 只读判定：`SettingsAccess` 增加可选 `readonly writable?: boolean`（宿主 `settings` 服务已提供该 getter）。为 `false` 时在联网前就拒绝；字段缺失（旧宿主）按未知处理，交由 `mutate` 失败兜底，不重试。
- 确认：新增 `waitForModels(llm, ids, options)`（放 `src/codex/route.ts`，与 `waitForProvider` 同风格，25 × 200ms）。等待对象是 `newlyAvailable`（写入前未注册的 id），而不是全部 `proposed`——用户保留的旧条目可能本来就没注册，用全集会让一次正确的写入被报成未确认。`expected ⊆ listModels()` 即成功；超时只报告「已保存但注册未确认」，**不回滚**。成功文案用写入后的 `listModels` 实测条数，不拿 `proposed.length` 冒充注册数。

### 6.5 `/provider models openai-codex` 守卫（P1）

`src/ui/commands/provider.ts` `fetchProviderModels` 开头：

~~~ts
if (route === CODEX_PROVIDER) {
  ctx.notice('warning', 'openai-codex 的模型目录只能由 /codex models refresh 读取：宿主的 discovery 只回放已安装目录，写入会固定静态列表并丢失 xhigh/max 等推理等级。')
  return
}
~~~

放在 `discoverModels` 调用与任何写入之前，保证既不联网也不落盘。

### 6.6 Deps 扩展

`CodexCommandDeps` 新增两个可选 seam，保持现有测试构造方式：

| 字段 | 用途 |
|---|---|
| `clientVersion?: () => Promise<ClientVersionResult>` | 测试注入版本，避免依赖本机 CLI |
| `catalogTimeoutMs?: number` | 目录请求预算，默认 7000 |

`fetcher` / `signal` / `now` / `wait` 复用现有字段。

## 7. 远端字段 → 本地条目

| 远端字段 | 本地字段 | 缺失时 |
|---|---|---|
| `slug` | `id` | 条目无效（整个响应判无效） |
| `display_name` | `name` | 回退 `id` |
| `visibility` | —— | 只接受 `list`，其余跳过 |
| `context_window` → `max_context_window` | `contextWindow` | 两者都缺失 → 跳过该条目并计入 `unsupported` |
| `max_output_tokens` | `maxTokens` | `128000`（声明值） |
| `input_modalities` | `input` | `['text']` |
| `supported_reasoning_levels[].effort` | `reasoningEfforts` 键 | 空数组 → `efforts: false`；含无法表达的等级 → `omitted` |

## 8. 错误与文案

| 情况 | 用户可见 | 是否写入 |
|---|---|---|
| 未登录 / 凭据不完整 | `Codex: not signed in — run /codex login` | 否 |
| 凭据已过期且可刷新 | 说明 pi-ai 会在下一次请求刷新，请先发一条消息或重新登录 | 否 |
| 路由缺失 | `Route openai-codex is missing — run /codex setup.` | 否 |
| 路由带 `apiKeyEnv` | 说明 OAuth 不生效，拒绝刷新 | 否 |
| 401 / 403 / 429 | 分别给出重新登录 / 无权限 / 稍后再试 | 否 |
| 网络失败、超时、非 JSON、超体积 | `openai-codex: cannot read the catalogue — <原因>` | 否 |
| `DSH_CODEX_CLIENT_VERSION` 非法 | 指名该环境变量并要求修正 | 否 |
| 写入冲突 | 自动重试一次；再失败报告 | 可能已写 |
| 注册未确认 | 说明已保存但未注册，提示 `/reload` 与目录检查 | 是（不回滚） |

所有错误文本经 `redact` 处理，不输出 token、请求头或响应正文。

## 9. 测试计划

### 9.1 单测

`tests/codex-catalog.spec.ts`（新增）：

- 解析：只保留 `list`；重复 id / 非法 slug / 非数组 `models` / 额外顶层键 → `invalid-response`；`context_window` 缺失回退 `max_context_window`；`input_modalities` 缺省为 text；`ultra` 进 `omitted` 且条目仍可用；全部不可用 → `invalid-response`。
- 拉取：401/403/429 映射；非 JSON content-type；超体积；`signal.aborted` → `cancelled`；超时 → `timeout`；请求头含 `chatgpt-account-id`、不含 body 回显。
- 版本：环境变量合法/非法；探测输出解析（`codex-cli 0.165.0`、`codex 0.165.0`）；探测失败回退内置；来源字段正确。
- 合并：保留已有条目字段、追加缺失、去重、`unlisted`、`config-unmergeable`、`added` 为空。

`tests/codex-command.spec.ts`（追加）：

- 未登录不发起 fetch（fetcher 断言调用 0 次）。
- 确认取消 → 无写入、无通知「已写入」。
- 确认写入 → `mutate` 收到完整 `proposed` 与 revision；注册轮询成功 → 成功文案。
- 冲突重试一次；注册超时 → 未确认文案且配置保留。
- `/codex models help` 不联网。

`tests/providers.spec.ts`（追加）：`/provider models openai-codex` 不调用 `discoverModels`、不写 settings，并给出指向 `/codex models refresh` 的提示。

`tests/codex-fixtures.ts`（扩展）：`catalogFetcher(body, status)`、`versionOf(value, source)`、`catalogBody({ visible, hidden })`。

### 9.2 运行

~~~sh
pnpm typecheck
pnpm test
pnpm build          # 等同 pnpm check
node scripts/fake-tty-codex.mjs
~~~

探针新增一步：在无凭据的 scratch profile 里执行 `/codex models refresh`，断言输出为未登录提示，且 `cordis.patch.yml` 未被写入（该探针目前明确不联网、不登录，本用例不破坏这一性质）。

### 9.3 真实环境验收（人工）

在 `web` 与 `tui` 各执行一次：`/codex models refresh` → 确认 → `/codex models` 显示 8 条 → `/model openai-codex/gpt-6.1-terra` 选中并完成一次真实推理。

## 10. 待办（本次不做，按优先级）

1. `/codex models restore`：把 `models` 置回 `[]` 并复核回到原生目录数量；需要在预览里列出将被清除的显式条目与自定义容量。
2. 登录成功后顺带提示（不自动写入）目录里已存在缺失模型。
3. 目录缓存与条件请求（ETag / `fetched_at`），避免每次 refresh 全量拉取。
4. 显式容量与远端窗口不一致时的修正建议（understated/overstated 提示）。
5. 若未来宿主把 `openai-codex-responses` 纳入 `discoverModels`（需 OAuth 注入契约），改为复用宿主能力并删除本地客户端。

## 11. 验收标准

- `/codex models refresh` 在已登录、路由正常的 profile 上补齐 `gpt-6.1-terra`，`/codex models` 显示 8 条，`/model` 可选中。
- 选择该模型后完成一次真实推理（目录可见 ≠ 可调用，这是唯一硬验收）。
- 未登录、凭据过期、网络失败、响应异常、版本非法：不写入、不猜测、不留半成品。
- `/provider models openai-codex` 不再改写配置。
- `ultra` 在预览与结果中都被明确标注为「宿主无法表达」，不静默丢弃。
- `pnpm check` 全绿；新增用例覆盖 §9.1 列出的分支。

## 12. 风险与边界

- **端点无版本**：目录接口未公开文档化，字段随时可能变；解析层采取「可疑即整单拒绝」，宁可失败也不写入错误能力。
- **可见 ≠ 可调用**：目录只说明账号能看到，账号权限、套餐与配额仍可能在推理时拒绝；文案不得把「已加入目录」写成「已可用」。
- **显式列表仍是整体替换**：一次 refresh 之后，pi-ai 后续新增的模型不会自动出现，直到再次 refresh 或执行待办 1 的恢复。这是该设计的已知代价，必须在命令输出中保留提示。
- **能力投影不完整**：宿主 schema 无 `ultra`，输出上限依赖声明值；不要用这些数字反推厂商事实。
- **凭据刷新依赖宿主**：TUI 不能在拉目录前主动刷新 token，临期凭据会走「请先发一条消息或重新登录」的降级路径。
- **写入面**：只写 `providers.openai-codex.models`，不触碰 `apiKeyEnv`、其它 provider 或其它命名空间。
## 13. 实施记录（2026-10-30）

### 13.1 变更文件

| 文件 | 变更 |
|---|---|
| `src/codex/catalog.ts` | 新增（414 行）：版本解析、目录拉取、目录解析、合并计划 |
| `src/codex/route.ts` | 新增 `waitForModels` |
| `src/runtime/settings-write.ts` | `SettingsAccess` 增加可选 `writable` |
| `src/runtime/codex-command.ts` | 新增 `models refresh` 流程、预览、确认、写入与确认；`CODEX_USAGE` 更新 |
| `src/ui/commands/provider.ts` | `/provider models openai-codex` 守卫（P1） |
| `src/ui/commands/catalog.ts` | `/help` 与 `/` 菜单的 `codex models [refresh]` |
| `README.md` | 命令表、Codex 小节与显式列表代价说明 |
| `tests/codex-catalog.spec.ts` | 新增（23 例） |
| `tests/codex-command.spec.ts` | 追加 13 例（刷新全流程） |
| `tests/commands.spec.ts` | 追加 1 例（守卫无副作用） |
| `tests/codex-fixtures.ts` | `catalogModel` / `catalogBody` / `catalogFetcher` / `versionOf`；`settingsOf` 支持 `writable` |
| `scripts/fake-tty-codex.mjs` | 新增「无凭据 refresh 拒绝且不联网」步骤与两项断言 |

### 13.2 与方案的偏差（均已落回本节）

1. `planCatalogPatch` 接收整份 `CatalogListing`（需要 `limited`/`unsupported`），并对 `CatalogPlan` 增加 `entries`（用于预览容量）与 `newlyAvailable`（用于确认与文案）。
2. 注册确认只等 `newlyAvailable`，成功文案用写入后的实测条数，见 §6.4。
3. `fetchCodexCatalog` 在信号已中止时不发请求，直接返回 `cancelled`（命令被取消不应产生一次网络请求）。
4. 守卫的端到端断言放在 `tests/commands.spec.ts`：它需要 `CommandContext`，`tests/providers.spec.ts` 只覆盖纯函数。
5. `refresh` 的拒绝文案带 `openai-codex:` 前缀，便于在 transcript 里与 `/codex status` 区分。

### 13.3 实际验证

| 命令 | 结果 |
|---|---|
| `pnpm check` | 通过；88 个测试文件 / 1194 例，构建成功 |
| `node scripts/fake-tty-codex.mjs` | 8/8 PASS，含 `refresh refuses while signed out` 与 `refresh made no catalogue request` |

未覆盖：真实账号的目录拉取与 `gpt-6.1-terra` 真实推理（本次未使用真实 OAuth 凭据发起网络请求），按 §9.3 由人工验收。
