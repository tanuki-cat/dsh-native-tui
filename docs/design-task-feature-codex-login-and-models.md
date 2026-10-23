# TUI 内登录 ChatGPT Codex 并使用其模型

> 任务类型：feature ｜ 目标仓库：`dsh-native-tui` ｜ 状态：P1 已实施，P3 额度查询并入 status（2026-10-23）
> 日期：2026-10-23 ｜ 依赖宿主：DSH 0.2.1-rc.2（`llm-pi-ai` + pi-ai 1.3.0）

## 1. 结论

在 TUI 内实现 `/codex` 命令，复用宿主已有的 `authorization` / `credentials` 服务与 `llm-pi-ai` 的 OAuth flow，不依赖 `dsh-llm-chatgpt`（dsh-codex）插件：

1. `/codex setup` 只确保 `llm-pi-ai.providers.openai-codex` 路由存在（`models: []` 表示 pi-ai 原生目录），不触发登录。已有凭据、只缺路由的 profile 用它即可。
2. `/codex login` 驱动 pi-ai 的 `openai-codex` OAuth（浏览器回调或 device code），凭据由 pi-ai 经 DSH 凭据 seam 写入共享的 `~/.dsh/.credentials.yaml`。
3. 登录成功后调用 `setup` 补建路由；`/model` 随即可选 `openai-codex/*`，推理、上下文窗口、reasoning efforts 由 pi-ai 目录提供，TUI 现有模型选择与持久化逻辑不变。
4. `/codex status|logout|models` 提供状态（含 5 小时与周额度）、登出和模型清单。

修订版重点处理五类风险：空授权码误提交、登出与在途提交的竞态、无登录补路由、`apiKeyEnv` 让 OAuth 静默失效、共享凭据登出影响其它 profile。该方案不安装、也不豁免 `dsh-llm-chatgpt@0.3.15`：后者只声明兼容到 DSH `0.2.1-rc.1`，登录入口在 Web 设置页与 `webServer` 管理路由上。

## 2. 关键事实（已核对）

| 事实 | 依据 |
|---|---|
| TUI profile 没有 `webServer`，也不加载 Web client bundle | `tui` 的 bundles 只有 `@deepseek-ai/dsh-base` + `dsh-native-tui`；`webserver`（`@deepseek-ai/dsh-host-webserver`）由 `dsh-web-app` bundle 挂载 |
| `authorization` / `credentials` 在 TUI 中可用 | `dsh-base/cordis.patch.yml` 挂载 `@deepseek-ai/dsh-authorization` 与 `@deepseek-ai/dsh-credentials-local` |
| 凭据跨 profile 共享 | `dsh-credentials-local` 默认写 `resolveDshHome()/.credentials.yaml` |
| Codex 凭据 key 为 `llm-pi-ai/openai-codex` | `credentialKey('llm-pi-ai', 'openai-codex')`，现有凭据文件中已是该 key |
| `llm-pi-ai` 无条件注册所有已安装 provider 的登录 flow | `registerPiAiFlows`：「Registration is unconditional on configuration」 |
| `openai-codex` OAuth 有两种方式 | pi-ai `openai-codex.js`：`browser`（127.0.0.1:1455 回调）与 `device_code` |
| OAuth flow 先弹 `select` 选登录方式 | 选项 id：`browser`、`device_code` |
| 浏览器流程始终同时等待回调与手动粘贴授权码 | `waitForCallbackOrManualInput`；手动 prompt 有独立 `signal`，回调成功后撤回 |
| 手动回答为空会取消回调并失败 | 手动 prompt 一 resolve 就 `callback?.cancel()`；空串解析后无 code，抛 `Missing authorization code` |
| `showTextInput` 默认拒绝空提交 | 未传 `allowEmpty` 时空 Enter 返回 `undefined`，与 Esc 无法区分 |
| 路由 `models: []` 表示使用原生目录 | `resolveRouteModels`：`configured.length > 0` 才覆盖，空数组等价于缺省；Web profile 当前即 `models: []` |
| pi-ai 1.3.0 原生目录有 9 个 Codex 模型 | `gpt-5.3-codex-spark`、`gpt-5.5`、`gpt-5.6-luna/sol/terra`、`gpt-6-astra/luna/sol`、`gpt-6.1-sol` |
| OAuth 路由不因缺少凭据而无法列模型 | `listModels` 只在 `apiKeyEnv` 存在却取不到值时返回 `[]`；无 `apiKeyEnv` 的 OAuth 路由直接读原生目录 |
| 请求中止时 `authorization.begin` 返回 `cancelled` | seam 的 `attempt()`：`signal.aborted → { status: 'cancelled' }` |
| 登录完成即提交凭据，运行中的适配器可见 | seam 在 attempt 内确认 `credentials/record-updated`；删除同样会通知 |
| `ctx.signal` 不是命令取消信号 | 它来自 `interactionAbort`，只在终端 dispose 时 abort（`src/ui/app.ts:256,730`） |
| 登出与在途提交可能竞态 | `commit` 在通过 abort 检查后仍会入队 `modifyRecord`；后台 refresh 也可能在 `deleteRecord` 之后写回 |
| 设置冲突有稳定错误码 | `SettingsConflictError`，`code === 'SETTINGS_CONFLICT'`；现有 `writeSettingsOps` 已实现只对冲突重试一次 |
| device code 有效期 15 分钟 | pi-ai `DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60` |
| 额度接口为 `GET https://chatgpt.com/backend-api/wham/usage` | 2026-10-23 用真实凭据核对：`rate_limit.primary_window/secondary_window` 带 `used_percent`、`limit_window_seconds`、`reset_after_seconds`、`reset_at`（epoch 秒）；响应另带 `account_id` 与 `plan_type` |
| 额度窗口按时长识别 | 5 小时 = 18000 秒，周 = 604800 秒；不依赖 primary/secondary 顺序 |

## 3. 范围

### 3.1 本方案包含

- `/codex [status]`：登录状态、账号、凭据到期、路由状态、模型数量、进行中的登录。
- `/codex setup`：只确保路由并验证注册；已有凭据时无需重新 OAuth。
- `/codex login [browser|device]`：驱动 OAuth；成功后调用 `setup`。
- `/codex logout`：确认后取消进行中的登录、等待 settle、删除凭据并回读确认。
- `/codex models`：列出 `openai-codex` 可用模型，并说明未登录时的可用性。
- 路由补建（仅缺省时写入，不覆盖已有配置）；`apiKeyEnv` 冲突检测。
- 单元测试、路由分发测试、fake-TTY 探针（覆盖 setup/状态/模型；登录用桩驱动）。

### 3.2 非目标（后续阶段）

- 从账号目录补全 pi-ai 未收录的新模型（P2）。
- 状态行常驻 5 小时/周额度条（另立任务）；额度查询本身已并入 `/codex status`。
- `image_gen` 工具、Web 设置页卡片、多账号切换。
- 修改 pi-ai 或宿主 OAuth 协议实现。

## 4. 方案总览

~~~text
/codex setup
  └─ src/codex/route.ts
       ├─ settings.mutate('llm-pi-ai', providers.openai-codex = { models: [] })   [冲突重试]
       ├─ apiKeyEnv 检查（会绕过 OAuth）
       └─ 验证注册（llm.listProviders / listModels）

/codex login
  ├─ src/codex/login.ts
  │    ├─ authorization.begin({ key: 'llm-pi-ai/openai-codex', method: 'oauth' })
  │    ├─ browser: 授权 URL + 可空授权码 prompt
  │    └─ device:  verification URL + code + 可取消等待框
  └─ 成功后调用 setup

/codex logout
  ├─ 确认（影响所有 profile）
  ├─ authorization.cancel + 等待 inFlight 结束
  ├─ credentials.deleteRecord + 回读确认
  └─ 当前模型指向 codex 时提示 /model
~~~

不新增 Host 插件：TUI 通过 `ctx.host.get(...)` 读取 `authorization`、`credentials`、`settings`、`llm`，与现有 `/codebuddy` 相同的结构。

## 5. 命令规格

| 命令 | 行为 |
|---|---|
| `/codex`、`/codex status` | 输出登录状态、账号、凭据到期、路由状态、模型数量、是否登录中；凭据有效时额外查询 5 小时与周额度（10s 超时，失败只降级额度区） |
| `/codex setup` | 只确保路由并验证注册；`apiKeyEnv` 存在时说明并询问是否移除；不触发 OAuth |
| `/codex login` | 交互选择登录方式并登录；成功后调用 `setup` |
| `/codex login browser` | 直接选择浏览器回调方式 |
| `/codex login device` | 直接选择 device code 方式 |
| `/codex logout` | 确认后取消在途登录、等待 settle、删除凭据并回读；保留路由与模型 |
| `/codex models` | 列出 `openai-codex` 模型；路由缺失时建议 `/codex setup` |
| `/codex help` | 用法文本 |

### 5.1 输出示例

~~~text
/codex status
Codex: signed in as Ziyang Wang (plus) · credential valid until 2026-10-25 15:12:00
  route openai-codex: 9 models
  5-hour limit  [█████████░] 88% left · 12% used · resets 2026-10-25 19:35:00
  weekly limit  [██████░░░░] 58% left · 42% used · resets 2026-10-29 01:50:00

/codex status
Codex: signed in as Ziyang Wang (plus) · credential valid until 2026-10-25 15:12:00
  route openai-codex: 9 models
  usage: unavailable — the request timed out

/codex status
Codex: not signed in — run /codex login
  route openai-codex: 9 models

/codex status
Codex: signed in, but route openai-codex is missing — run /codex setup
  5-hour limit  [█████████░] 88% left · 12% used · resets 2026-10-25 19:35:00
  weekly limit  [██████░░░░] 58% left · 42% used · resets 2026-10-29 01:50:00
~~~

~~~text
/codex setup
Route openai-codex is ready (9 models).
~~~

~~~text
/codex login
Opening https://auth.openai.com/oauth/authorize?... in your browser…
If the browser did not open, visit the URL above.
Paste the authorization code or redirect URL here (Esc cancels), or leave this open for the callback.
…
Codex: signed in as Ziyang Wang (plus)
Route openai-codex is ready (9 models). Select one with /model, for example openai-codex/gpt-6-sol.
~~~

~~~text
/codex login device
Open https://auth.openai.com/codex/device and enter code ABCD-EFGH.
Waiting for authorization… (Enter or Esc cancels)
~~~

~~~text
/codex logout
Sign out ChatGPT Codex for every profile using this DSH home? [Sign out / Cancel]
Codex: signed out.
Warning: the selected model is openai-codex/gpt-6-sol; choose another with /model.
~~~

## 6. 实现细节

### 6.1 凭据 key 与记录

~~~ts
export const CODEX_PROVIDER = 'openai-codex'
/** Must match credentialKey('llm-pi-ai', CODEX_PROVIDER). */
export const CODEX_KEY = 'llm-pi-ai/openai-codex'

export interface CodexGrant {
  readonly type?: 'oauth'
  readonly access?: string
  readonly refresh?: string
  readonly expires?: number
  readonly accountId?: string
}

export type CredentialState =
  | { kind: 'absent' }
  | { kind: 'incomplete' }
  | { kind: 'expired-refreshable'; grant: CodexGrant }
  | { kind: 'expired'; grant: CodexGrant }
  | { kind: 'valid'; grant: CodexGrant }
~~~

分类规则：

- 无记录 → `absent`。
- `access` 或 `expires` 缺失/非法 → `incomplete`（提示重新登录）。
- `expires <= now` 且有 `refresh` → `expired-refreshable`（适配器在下一次 openai-codex 请求时刷新）。
- `expires <= now` 且无 `refresh` → `expired`（需要重新登录）。
- 其余 → `valid`。

`accountId` 与 `refresh` 都按可选处理：旧记录或不同 pi-ai 版本可能不写，不能因此把有效登录判成损坏；P3 的额度查询再要求 `accountId`。账号展示从 `payload.access` 的 JWT claims 解析（不验签）：

- `https://api.openai.com/profile` → `name`、`email`
- `https://api.openai.com/auth` → `chatgpt_plan_type`、`chatgpt_account_id`（作为 `accountId` 的回退）

解析失败时只显示「账号信息不可用」，不影响登录状态。

### 6.2 登录驱动

~~~ts
interface LoginDeps {
  readonly authorization: AuthorizationLike
  readonly openUrl?: (url: string) => boolean
  readonly notice: (level: 'info' | 'warning' | 'error', text: string) => void
  readonly choose: (title: string, items: Choice[], hint: string, signal: AbortSignal) => Promise<string | undefined>
  /** '' means an empty submit; undefined means the dialog was cancelled. */
  readonly ask: (message: string, placeholder: string | undefined, secret: boolean, signal: AbortSignal) => Promise<string | undefined>
  /** Terminal lifecycle signal, aborted on dispose. Not a per-command cancel. */
  readonly signal: AbortSignal
  readonly method?: 'browser' | 'device'
  /** Default 15 minutes, matching pi-ai's device-code validity. */
  readonly timeoutMs?: number
}

export async function loginCodex(deps: LoginDeps): Promise<LoginOutcome>
~~~

流程：

1. 命令层在调用驱动前检查 `credentialState`；为 `valid` 时先确认是否重新登录（覆盖现有凭据），取消则直接返回。驱动本身不读凭据。
2. `authorization.describe(CODEX_KEY)`：
   - 不存在 → 警告「当前 profile 没有注册 openai-codex 登录 flow（需要 llm-pi-ai）」；
   - `inFlight` → 警告「已有登录在进行」并返回。
   - 若方法列表里没有 `oauth`，用第一项并在 notice 中说明。
3. 建立 attempt 控制器：`AbortSignal.any([deps.signal, 超时])`；超时 15 分钟（device code 的有效期），用标志位区分超时。
4. `authorization.begin({ key: CODEX_KEY, method, interaction, signal })`；捕获 `ALREADY_IN_FLIGHT` 并给出与步骤 2 相同的提示。
5. `interaction.notify`：
   - 只对授权域名（`auth.openai.com`、`chatgpt.com`）的 URL 自动打开一次浏览器；其它链接只显示；
   - 所有 URL 都写入 notice，无法打开时可手工访问；
   - `code` 原样显示；
   - `deps.signal.aborted` 后不再写 notice（避免 dispose 后写 transcript）。
6. `interaction.prompt`：
   - `select`：有 `browser|device` 参数时按选项 id 直接返回 `browser` / `device_code`；找不到则退回交互选择。Esc → 中止 attempt（`cancelled`）。
   - `text` / `secret`：调用 `ask`，信号为 `AbortSignal.any([attemptSignal, prompt.signal])`。
     - 返回 `undefined` 且 `prompt.signal.aborted` → 抛 `Error('prompt withdrawn')`，让回调赢得竞争；
     - 返回 `undefined` 且非 prompt 撤回 → 中止 attempt（用户取消）；
     - 返回 `''`（空提交）→ **重新打开输入框继续等待**，绝不把空串交给 pi-ai；
     - 非空 → 返回。

   - 接线要求：注入的 `ask` 必须调用 `showTextInput(..., allowEmpty: true)`，否则空 Enter 会返回 `undefined`，与 Esc 不可区分。此点由单测覆盖。

7. device code：收到带 `code` 的 notice 后显示一个「Waiting for authorization…（Enter/Esc 取消）」选择框，绑定 attempt 信号；`begin` 结束后主动关闭。实现上用 `Promise.race` 监听首个 device notice，再并发等待 `begin`；等待框标题里重复 code，避免被遮挡后看不到。
8. `begin` 返回：
   - `authorized` → 调用 `setup`；读取账号；输出成功 notice（模型数量用实际查询结果，拿不到则只说「route configured」）；
   - `cancelled` → 超时则提示超时，否则提示已取消。
9. 失败 → 复用现有 `redact` 逻辑输出（从 `src/codebuddy/errors.ts` 抽取到 `src/runtime/redact.ts` 或直接复用），不输出内部堆栈。

取消语义：

- 浏览器方式：pi-ai 始终会挂起「粘贴授权码」文本 prompt，Esc 即取消；回调先到时该 prompt 的 `signal` 被撤回，界面自动关闭。
- device code 方式：pi-ai 不弹 prompt，用等待框提供取消。
- 除上述 overlay 外，TUI 没有独立的命令取消入口（`ctx.signal` 只在 dispose 时 abort）；文档与提示文案不得声称按 Esc 可取消整个登录之外的所有阶段。

### 6.3 `/codex setup` 与路由确保

~~~ts
export type RouteState =
  | { kind: 'present'; apiKeyEnv?: string }
  | { kind: 'added' }
  | { kind: 'blocked'; apiKeyEnv: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unverified'; added: boolean; reason: string }

export async function ensureCodexRoute(
  settings: SettingsAccess | undefined,
  llm: ModelCatalog | undefined,
): Promise<RouteState>
~~~

`SettingsService` 与 `LLM` 都是 UI 层的结构类型；在 `src/codex/types.ts` 定义最小接口 `SettingsAccess`（`describe` / `mutate`）与 `ModelCatalog`（`listProviders` / `listModels`），UI 类型结构上满足它们，避免 runtime → ui 的反向依赖。

实现：

1. `settings.describe({ redactSecrets: true }).find(r => r.ns === 'llm-pi-ai')`；无 settings/命名空间 → `unavailable`。
2. 路由已存在：
   - 有 `apiKeyEnv` → `blocked`，附带该引用；命令层询问是否移除（写 `unset providers.openai-codex.apiKeyEnv`，保留其它字段），并明确「移除前 OAuth 不会生效」；移除后重新执行一次 ensure 并验证注册；
   - 无 `apiKeyEnv` → `present`。
3. 路由不存在：用项目已有的 `writeSettingsOps`（从 `src/ui/commands/settings-common.ts` 迁移到 `src/runtime/settings-write.ts`）写入 `{ models: [] }`；它只对 `SETTINGS_CONFLICT` 重试一次，其它错误立即失败。
4. 写入后验证：每 200ms 检查 `llm.listProviders()` 是否包含 `openai-codex`，最多 5s。
   - 注册成功 → `present` / `added`；模型条数由命令层随后调用 `llm.listModels` 取得；
   - 注册失败 → `unverified`，提示「配置已写入但未确认注册，可 /reload 后重试」；
   - 若本次是新增且始终未验证，命令层提供「撤销该路由」选项（`unset providers.openai-codex`）。
5. 只补缺省路由，不覆盖用户已配置的 `models`、`reasoning` 或其它字段。路由写入是 profile 级配置；凭据是全局共享。

`/codex models` 在路由缺失时不隐式写配置，只提示 `/codex setup`。

### 6.4 `/codex logout`

命令层先确认，文案必须说明「会删除共享凭据，影响所有使用同一 DSH home 的 profile（包括 Web）」。确认后调用驱动：

~~~ts
export async function logoutCodex(deps: {
  readonly authorization: AuthorizationLike
  readonly credentials: CredentialStoreLike
  readonly signal: AbortSignal
  readonly wait?: (ms: number) => Promise<void>
}): Promise<'signed-out' | 'not-signed-in' | 'busy' | 'still-present'>
~~~

1. 读取记录；不存在 → `not-signed-in`。
2. `authorization.cancel(CODEX_KEY)`。
3. 等待 `describe(CODEX_KEY)?.inFlight !== true`（50ms × 40，最多 2s）；仍在途 → `busy`，不删除，提示稍后重试。
4. `credentials.deleteRecord(CODEX_KEY)`。
5. 回读 `readRecord`：仍存在 → `still-present`，提示后台刷新可能写回，建议空闲时重试。
6. 返回 `signed-out`。

命令层收尾：

- 若 `ctx.modelSelection.current?.provider === 'openai-codex'`，提示当前模型需要切换（`/model`）。
- 路由与模型清单保留；未登录时仍可在 `/model` 看到 Codex 模型，但调用会失败，状态里写明。
- 说明跨进程边界：如果 Web 进程正在登录或刷新，TUI 的 cancel 管不到它；文件锁只保证最后一次写入生效。

### 6.5 状态分类

| 记录/路由状态 | 显示 |
|---|---|
| 无记录 | `not signed in — run /codex login` |
| 登录中 | `sign-in in progress (started by this process)` |
| `incomplete` | `credential incomplete — sign in again` |
| `expired-refreshable` | `credential expired; pi-ai refreshes it on the next openai-codex request` |
| `expired` | `credential expired — sign in again` |
| 有效 | 账号名/plan + 到期时间 |
| 有效、额度查询成功 | 两条额度行：剩余/已用百分比、10 格剩余额度条、重置时间 |
| 额度请求失败 | `usage: unavailable — <原因>`（401/403/429/超时/网络/响应畸形/账号变化） |
| 凭据过期可刷新 | `usage: unavailable — the credential expired; pi-ai refreshes it on the next openai-codex request` |
| 缺 `accountId` | `usage: unavailable — sign in again so the account id is recorded` |
| 未登录、凭据不完整、已过期不可刷新 | 不输出额度行 |
| 路由缺失、凭据有效 | `route openai-codex is missing — run /codex setup` |
| 路由存在、无 `apiKeyEnv` | `route openai-codex: N models` |
| 路由存在、有 `apiKeyEnv` | `route names credential reference X; OAuth is not used` |
| 路由有 `apiKeyEnv` 但引用未设置 | `0 models (credential reference X is unset)` |
| `llm.listModels` 抛错 | `catalogue unavailable: <reason>` |

状态命令不写配置、不打开浏览器、不刷新 token（刷新归 pi-ai 适配器：凭据剩余不足 5 分钟或已过期时，在下一次 openai-codex 请求前刷新并写回）。凭据有效时向 `https://chatgpt.com/backend-api/wham/usage` 发一次 GET（10s 超时）；失败只影响额度区，登录/路由/模型行照常输出。

### 6.6 额度查询（并入 status）

`src/codex/usage.ts` 负责请求与校验，`src/runtime/codex-command.ts` 负责渲染：

~~~ts
const result = await fetchCodexUsage({ access, accountId, signal, fetcher?, now?, timeoutMs? })
// { kind: 'ok', usage: { fiveHour?, weekly?, ... } } | { kind: 'unavailable', reason }
~~~

1. 只在 `credentialState === 'valid'` 且拿得到 `accountId`（记录字段或 JWT `chatgpt_account_id`）时请求；`expired-refreshable` 只提示「pi-ai 在下一次 openai-codex 请求时刷新」，不发请求。pi-ai 的刷新窗口是剩余不足 5 分钟或已过期，发生在下一次实际请求前，并写回共享凭据；status/models 都不触发。
2. 请求带 `authorization: Bearer <access>` 与 `ChatGPT-Account-Id`，`redirect: 'error'`，10s 超时，256 KiB 响应上限；与路由计数并发执行。
3. 窗口按时长识别（18000 / 604800 秒），并兼容 `window_minutes` 拼写；`reset_at`/`resets_at` 按 epoch 秒解析，缺失时用 `reset_after_seconds`。已过重置时间的窗口标记为 expired。
4. 单窗口失败（缺字段、百分比越界、同长度重复、已重置）只降级该窗口；`account_id` 与凭据不符或整体畸形只降级额度区。
5. 渲染为两条对齐行：`[10 格剩余额度条] 剩余% left · 已用% used · resets <本地时间>`；`allowed === false` 时追加账号受限提示。
6. HTTP 401/403/429、超时、网络错误、非 JSON、账号变化分别映射为固定短句；不输出上游原始错误、token、accountId 或邮箱。
7. 不缓存、不轮询、不刷新 token：每次 `/codex status` 都是一次显式查询；失败不影响登录、路由与模型行。

### 6.7 模型清单

~~~ts
const models = await llm.listModels('openai-codex')
~~~

- 路由缺失 → 提示 `/codex setup`。
- 返回空数组：区分「路由带 `apiKeyEnv` 且引用未设置」与「目录本身为空」，不要统一说成 0 个模型。
- 输出每行 `id` 与 `name`；可选对当前选中模型调用 `resolveModelInfo` 展示上下文与 reasoning，避免 N 次查询。
- 未登录时仍可列模型（OAuth 路由不要求凭据）；输出末尾注明「calls require sign-in」。

### 6.8 命令接入

- `src/ui/commands/catalog.ts`：`HELP_LINES` 增加一行；`LOCAL_COMMANDS` 增加 `codex`，含子命令 `status/setup/login/logout/models/help`。
- `src/ui/commands/router.ts`：`case 'codex'` 调用 `codexCommand(ctx(), args)`。
- `src/ui/commands/codex.ts`：从 `ctx.host` 取服务，注入 `showChoice`、`showTextInput(..., allowEmpty: true)`、`openUrlInBrowser` 与写设置函数；把 `ctx.signal` 作为终端生命周期信号。
- 不需要新增配置字段、Host 服务或 bundle patch。

## 7. 文件清单

| 文件 | 变更 |
|---|---|
| `src/codex/types.ts` | 新增：`AuthorizationLike`、`CredentialStoreLike`、`SettingsAccess`、`ModelCatalog`、`CodexGrant` 等结构类型 |
| `src/codex/account.ts` | 新增：JWT 解析、凭据状态分类、展示格式化 |
| `src/codex/login.ts` | 新增：OAuth 驱动、超时/取消/notice/prompt 适配 |
| `src/codex/route.ts` | 新增：路由确保、`apiKeyEnv` 检查、注册验证 |
| `src/runtime/codex-command.ts` | 新增：命令语义（可注入依赖，便于单测） |
| `src/runtime/settings-write.ts` | 新增（从 `ui/commands/settings-common.ts` 迁移）：`isSettingsConflict`、`writeSettingsOps` |
| `src/ui/commands/codex.ts` | 新增：终端接线、确认框、模型选择提示 |
| `src/ui/commands/settings-common.ts` | 修改：改为从 `runtime/settings-write.ts` 导入并保留原有导出 |
| `src/ui/commands/router.ts` | 修改：分派 `/codex` |
| `src/ui/commands/catalog.ts` | 修改：help 与补全 |
| `tests/codex-account.spec.ts` | 新增 |
| `tests/codex-login.spec.ts` | 新增 |
| `tests/codex-route.spec.ts` | 新增 |
| `tests/codex-command.spec.ts` | 新增 |
| `tests/codex-fixtures.ts` | 新增：设置/目录/凭据测试夹具 |
| `tests/router.spec.ts` | 修改：`/codex` 分发 |
| `scripts/fake-tty-codex.mjs` | 新增：fake-TTY 探针（setup/状态/模型） |
| `README.md` | 修改：命令表与使用说明 |

## 8. 安全与隐私

- 不在 notice、错误文本、日志、测试快照中输出 `access` / `refresh` token、完整凭据记录或授权码 URL 中的 `code`/`state`。
- 授权页面 URL 需要显示给用户；不写入 debug 日志。device code 可以显示（本来就是给用户输入的）。
- 账号信息只显示名字与 plan；email 默认不显示，避免终端录屏泄漏。
- 错误信息经 `redact` 截断；OAuth 内部异常不直接展示。
- 路由写入只新增/修改 `openai-codex`，不改其它 provider 或凭据；移除 `apiKeyEnv` 必须单独确认。
- 登出必须确认，并明确影响所有 profile；删除后回读确认。
- 自动打开浏览器只限授权域名，避免 notice 中的普通链接被误开。

## 9. 性能影响

结论：**可忽略，不需要额外优化**。

- 登录超时用 `AbortSignal.timeout`，实测是 unref 的（进程立即退出），不会拖住事件循环。
- `/codex status` 的 `settings.describe` + `listModels` 是用户触发的一次性操作；即使 `llm-pi-ai` 配置里有上百个模型，也只是毫秒级，不在渲染/流式路径上。
- 已登录时 status 多一次 10s 上限的额度请求，与路由计数并发；成功路径通常 100–300ms，离线时最长等 10s。该请求只在显式命令里发生，不进入状态行或每帧渲染。
- 登录期间只占一个本地端口和一个模态 overlay，无轮询、无 CPU 占用；device code 轮询由 pi-ai 负责，且不产生 progress notice。
- 一次性的 provider 重新注册与 `/provider add` 相同，可能造成模型列表短暂重建，可接受。
- 路由验证的 200ms × 25 轮只在 setup/login 时发生。
- **不要**把 status 逻辑接到状态行或每帧渲染；`settings.describe` 的大对象遍历会成为热路径。

## 10. 对现有 TUI 功能的影响

- 新增本地命令 `codex` 会遮蔽同名 Host 命令；当前没有同名命令，风险低，但需检查 `tests/autocomplete.spec.ts` 与 `/help` 文本。
- 写 `llm-pi-ai` 是 profile 级副作用，会影响所有会话的模型列表；验证与回滚必须做（6.3）。
- 登出影响其他 profile（共享凭据）是最大的用户可见副作用，必须确认并说明。
- 登出后若当前模型仍指向 Codex，下一条消息会认证失败；命令层提示切换。
- 不触碰流式渲染、turn、审批、问答路径，回归面很小。
- 新增模块需遵守 1000 行/文件、kebab-case、`.js` 后缀等项目约定。

## 11. 测试与验收

### 11.1 单元测试

`tests/codex-account.spec.ts`

- JWT 解析：合法、非三段、非 JSON、缺 claims → 降级不抛。
- 状态分类：absent / incomplete / expired-refreshable / expired / valid（含缺 `accountId`、缺 `refresh`）。
- 到期时间格式化使用注入的 `now` 与本地时区。

`tests/codex-login.spec.ts`（桩 authorization）

- 成功：`begin` 收到 `key='llm-pi-ai/openai-codex'`、`method='oauth'`；URL 只打开一次；成功 notice 含账号；调用 setup。
- **空提交**：`ask` 返回 `''` 时重新询问，不结束 attempt；随后非空回答成功。
- 用户 Esc：`ask` 返回 `undefined` 且 prompt 未撤回 → 中止 attempt，返回 `cancelled`，不写路由。
- prompt 撤回：`prompt.signal` abort → 抛 withdrawn，`begin` 仍返回 `authorized`，不产生失败 notice。
- device：`select` 自动回答 `device_code`；`code` 出现在 notice；等待框在结束后关闭。
- 超时（注入 5ms）：提示超时且 signal 已 abort。
- `inFlight` 与 `ALREADY_IN_FLIGHT` 两条路径都不重复调用 `begin`。
- 已登录时重新登录：确认框取消不发起 `begin`。
- `begin` 抛错：notice 经过 redact，无 token/授权码。
- dispose（`deps.signal` abort）后不再写 notice。

`tests/codex-route.spec.ts`

- 缺省 → 以当前 revision 写入 `{ models: [] }`。
- 已存在 → 不写，保留自定义字段。
- 冲突 → 只对 `SETTINGS_CONFLICT` 重试一次并成功；校验错误立即失败，不重试。
- 无 settings → `unavailable`。
- 存在 `apiKeyEnv` → `blocked`，不覆盖；移除后 OAuth 生效。
- 写入成功但 5s 内未注册 → `unverified`；新增路由可撤销。

`tests/codex-command.spec.ts`

- 参数解析、用法文本、未知子命令。
- `status` 在四种凭据状态、三种路由状态下的输出。
- `logout`：确认取消不发删除；确认后调用 cancel → 等 `inFlight` → delete；`busy` 与 `still-present` 路径。
- 登出后当前模型为 codex 的提示。
- `models` 路由缺失/存在/`apiKeyEnv` 未设置三条路径。

`tests/router.spec.ts`

- `/codex status` 走本地 `codex` 处理，不落到 Host command。

### 11.2 fake-TTY 探针

`scripts/fake-tty-codex.mjs`（真实 Host，scratch `DSH_HOME`）：

1. 启动 TUI，输入 `/codex status` → 断言出现 `not signed in`。
2. 输入 `/codex setup` → 断言真实 `settings.mutate` 成功、路由出现、模型数非空（不硬编码 9）。
3. 输入 `/codex models` → 断言至少一个已知 id（如 `gpt-6-sol`，若目录变化则只断言非空）。
4. 输入 `/codex logout`（无凭据）→ 断言直接提示 not signed in、不出现确认框、不崩溃。
5. 断言 transcript 中不出现 `access`/`refresh` 字段名或长 token。

登录的 browser/device 交互由 11.1 的桩覆盖；真实 OAuth 需要人工验收，探针不发起外网授权。无凭据路径不会请求额度接口；额度渲染由 11.1 的桩和真实凭据手工验收覆盖。

### 11.3 手工验收

1. `dsh --profile tui` → `/codex login browser`：浏览器授权后 TUI 显示账号；`/codex status` 正确。
2. `/codex setup` 在已有凭据时只补路由，不触发浏览器。
3. `/model` → 搜索 `openai-codex/`，选择 `openai-codex/gpt-6-sol`。
4. 发送一条消息，确认流式输出、工具调用与 token 统计正常。
5. `/reasoning` 能列出该模型的 efforts 并切换。
6. 退出重启，确认模型选择与凭据仍在。
7. `/codex login device`：验证 device code 显示、取消、成功三条路径。
8. `/codex logout` → `/codex status` 变回未登录；模型调用返回认证错误（预期）；确认 Web profile 也被登出（共享凭据）。
9. 在 `apiKeyEnv` 路由上执行 `setup`：确认阻止/移除流程生效。

### 11.4 门禁

- `pnpm check`（typecheck + vitest + build）。
- 探针命令实际输出附在 PR 描述中。

## 12. 分阶段

### P1（本方案）

setup、登录、状态、登出、路由补建、模型清单，以及 11 的测试。

### P2：账号模型目录刷新（可选）

- `GET https://chatgpt.com/backend-api/codex/models?client_version=<version>`，携带 OAuth access 与 `ChatGPT-Account-Id`；
- `client_version` 解析顺序：`DSH_CODEX_CLIENT_VERSION` → `codex --version`（1.5s 超时）→ 内置默认（如 `0.162.1`）；
- 映射 `slug` / `display_name` / `context_window` / `max_output_tokens` / `input_modalities` / `supported_reasoning_levels`；
- 以「预览 → 确认」方式写入 `llm-pi-ai.providers.openai-codex.models`，保留已有自定义字段；冲突时重读 revision；
- 新增 `/codex models refresh`。

### P3：额度查询（已并入 status）

- `GET https://chatgpt.com/backend-api/wham/usage` 读取 5 小时与周窗口；已按 6.6 实施。
- 输出并入 `/codex status`：文本进度条、剩余/已用百分比与重置时间；不单独提供 `/codex usage`。
- 仍不在 TUI 状态行常驻额度条（另立任务）。

## 13. 风险与待决

| 风险 | 处理 |
|---|---|
| 浏览器回调固定端口 1455，可能被 Codex CLI 占用 | pi-ai 自动降级为手动粘贴授权码；TUI 文本输入可粘贴 |
| 手动粘贴框的空 Enter 取消登录 | 6.2 的 `allowEmpty` + 空串重问；已列入单测 |
| 登出与在途 commit / 后台 refresh 竞态 | 6.4 等待 `inFlight`、删除后回读；跨进程刷新只能提示 |
| device code 有效期 15 分钟 | 超时统一 15 分钟，与 pi-ai 对齐 |
| `ctx.signal` 不是命令取消 | 只把 `ctx.signal` 当 dispose 信号；取消入口限定在 overlay 内 |
| 登录期间模态 15 分钟 | 浏览器方式由授权码 prompt 提供 Esc；device 由等待框提供取消；文档写明 |
| pi-ai 升级改变 prompt/notice 形状 | 按 kind 泛化，未知 prompt 用文本输入兜底；升级后重跑单测与手工验收 |
| 路由 `models: []` 依赖原生目录非空 | 已核对 1.3.0 有 9 个；目录为空时提示改用 P2 或手动配置 |
| 路由已有 `apiKeyEnv` 时 OAuth 不生效 | setup 检测并阻止；移除需单独确认 |
| 共享凭据登出影响 Web/其它 profile | 确认框与文案；删除后回读 |
| 跨进程并发登录 | 文件锁 last-wins；文档标注，不承诺跨进程互斥 |
| 供应商 notice 带普通链接 | 只自动打开授权域名，其余仅展示 |
| 登录成功但路由写失败 | 凭据已保存；提示运行 `/codex setup` |
| 模型可选但账号无权限 | 调用时由 provider 返回错误；状态不承诺账号权限 |

## 14. 备选方案与不采用原因

**安装 `dsh-llm-chatgpt@0.3.15` 到 tui profile（`allow-version` 豁免）**

- 版本门禁：manifest 只声明到 `0.2.1-rc.1`，rc.2 需显式风险豁免；
- 登录、模型补丁、额度条都在 Web 设置页与 `webServer` 管理路由上，TUI 没有 `webServer`，也没有 Web client；
- 即使安装，TUI 仍需要一个本地命令来触发 `authorization.begin`，与本方案重复；
- 结论：不作为 P1 依赖。若后续版本声明 rc.2 并提供 headless/TUI 入口，可重新评估，用它的 `/usage` 与模型目录刷新替代 P2/P3。

**给 TUI 内置一个 Host 插件**

- 登录只需要 `authorization` 与 `credentials`，命令式实现已经足够；新增 Host 插件会增加 bundle 与生命周期成本，且没有跨前端复用需求。

## 15. 验收标准

- [ ] `/codex setup` 在已有凭据、无路由的 profile 上只补路由，不触发 OAuth；模型可用。
- [ ] `/codex login browser` 在真实终端完成授权，凭据写入共享库，无需 Web profile。
- [ ] 手动粘贴框空 Enter 不会结束登录；Esc 才会取消。
- [ ] `apiKeyEnv` 路由被 setup 识别并阻止，确认移除后 OAuth 生效。
- [ ] 登录成功后路由存在（`models: []`），且不覆盖已有配置；注册失败时提示可撤销。
- [ ] `/model` 能列出并选择 `openai-codex/*`，状态行显示 provider/model 与上下文窗口。
- [ ] 选择 `openai-codex/gpt-6-sol` 能完成一次真实对话（文本 + 工具调用）。
- [ ] `/codex status` 在未登录、有效、过期、凭据不完整、登录中、路由缺失/`apiKeyEnv` 各状态下输出正确。
- [ ] `/codex status` 在已登录时渲染 5 小时与周额度；额度请求失败或超时只降级额度区，其余状态照常输出。
- [ ] `/codex logout` 确认后等待 `inFlight` 结束再删除，回读确认；共享凭据影响面有提示；当前 Codex 选择有切换提示。
- [ ] 登录取消、15 分钟超时、`ALREADY_IN_FLIGHT` 三条异常路径有明确提示且不写路由。
- [ ] 所有 notice 与错误信息不含 access/refresh token、授权码或 `state`。
- [ ] 自动打开浏览器仅限授权域名。
- [ ] `pnpm check` 通过；新增测试覆盖 11.1 列出的分支。
- [ ] `scripts/fake-tty-codex.mjs` 在 scratch home 通过，输出附在 PR。

## 16. 参考资料

- 宿主 `@deepseek-ai/dsh-authorization`：`AuthorizationService.begin/describe/cancel`、`AuthorizationNotice/Prompt`。
- 宿主 `@deepseek-ai/dsh-llm-pi-ai`：`registerPiAiFlows`、`loginMethods`、`relay`、`restate`、`listModels`。
- pi-ai 1.3.0：`dist/auth/oauth/openai-codex.js`、`callback-server.js`、`device-code.js`、`models.generated.js`。
- 参考实现：`https://github.com/tanuki-cat/dsh-codex`（0.3.15，Web-only；模型目录与 usage 逻辑可借鉴）。
- 本仓库：`src/runtime/codebuddy-command.ts`（OAuth 命令与 notice 模式）、`src/ui/commands/provider.ts`（settings 写入）、`src/ui/commands/model.ts`（模型选择）、`src/ui/commands/settings-common.ts`（冲突重试）。

## 17. 实施顺序

1. `/codex setup` + `runtime/settings-write.ts` 迁移 + 探针真实写入。
2. 登录驱动（空输入、prompt 撤回、notice 域名策略、post-dispose 守卫）。
3. 登出（确认、等待 `inFlight`、回读、模型选择提示）。
4. `apiKeyEnv` 检测与移除确认。
5. 状态/模型清单语义与测试补齐。
6. 文档、README 与 `pnpm check`。

## 18. 实施记录（2026-10-23）

P1 已按本方案落地：

- 新增 `src/codex/{types,account,route,login,logout}.ts`、`src/runtime/codex-command.ts`、`src/ui/commands/codex.ts`、`src/runtime/settings-write.ts`。
- `settings-common.ts` 改为委托 runtime 写入；`router.ts`、`catalog.ts`、`README.md` 已接入 `/codex`。
- `pnpm check`：typecheck、**61 个测试文件 / 681 个测试**、build 全部通过。
- `node scripts/fake-tty-codex.mjs`：6 项 PASS——进程正常退出、status 显示未登录、setup 写入真实 settings 并报告 `Route openai-codex is ready (9 models)`、models 列出原生 Codex 目录、logout 在无凭据时提示 not signed in、无凭据材料输出。
- 未在本次执行：真实 OAuth 登录、真实 Codex 推理、device code 的真实等待流程；这些需要账号授权，登录交互目前由 `tests/codex-login.spec.ts` 的桩覆盖。

运行探针：

~~~sh
node scripts/fake-tty-codex.mjs
# PASS status reports signed out
# PASS setup reports the route ready
# PASS models lists openai-codex
# PASS logout reports the signed-out state
~~~

### 2026-10-23 补充：status 合并额度

- 新增 `src/codex/usage.ts`：校验 `wham/usage` 响应，5 小时/周窗口独立降级；10s 超时、256 KiB 上限、禁止重定向。
- `src/runtime/codex-command.ts`：凭据有效时与路由计数并发查询额度，渲染两条额度行；未登录、凭据过期、缺 `accountId`、请求失败都只影响额度区。
- 新增 `tests/codex-usage.spec.ts`（19 个用例）；`tests/codex-command.spec.ts` 增加额度渲染与降级路径（共 22 个用例）。
- `pnpm check`：typecheck、**62 个测试文件 / 704 个测试**、build 全部通过。
- `node scripts/fake-tty-codex.mjs`：6 项 PASS（无凭据路径，确认本次改动未影响 setup/models/logout）。
- 真实凭据手工核对（直接调用 `runCodexCommand('status')`）：输出
  `5-hour limit  [██████████] 100% left · 0% used · resets 2026-10-23 14:21:03` 与对应的周额度行，时间按本地时区。
- 未执行：安装新构建后在真实终端里输入 `/codex status`；真实 OAuth 与真实 TUI 渲染仍由用户手工验收。
- 文案精确化：凭据过期提示改为「pi-ai 在下一次 openai-codex 请求时刷新」；核对 pi-ai 1.3.0 的实际行为为剩余不足 5 分钟或已过期时刷新，锁内二次检查并写回，status/models 不触发。
