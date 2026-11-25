# 第二轮全量代码审查与修复计划

> 2026-11-25 审查记录。基于 `main`（`c9c87ab`，DSH `0.2.3-alpha.2` 与第一轮 27 项修复合入后，`src/` 共 27,039 行），按**核心生命周期与模式**、**CodeBuddy / Codex 协议与路由**、**TUI 编排与渲染**、**斜杠命令与运行时 I/O** 四路完成全量只读审查。本清单排除了 [第一轮审查记录](design-task-fix-audit-security-perf-render.md) 已彻底修复的条目，仅记录剩余缺陷、协议/并发竞态及上轮修复引入的回归。
>
> 当前状态：**已修复并验证通过**（46 项全部完成，其中 `L14` 弃用 Host API 迁移已核实无替代接口并保留注释说明；并经第二轮独立只读复审补修 7 项边界问题）。

---

## 一、Critical（1 项）

| 编号 | 状态 | 问题与根因 | 涉及文件 | 建议修复与验收点 |
| --- | --- | --- | --- | --- |
| C1 | 已修复 | **多行输入弹窗按任意非 Esc 键即栈溢出崩溃**：`showOverlay` 将焦点设为 `MultilineInputDialog`；`MultilineInputDialog.handleInput` 转发给 `this.editor.handleInput`，而 `PromptEditor.handleNativeInput` 见 `tui.getFocusedComponent() !== this` 又同步转发回 `focused.handleInput`（即弹窗本身），形成无限互调递归，抛出未捕获 `RangeError: Maximum call stack size exceeded`，终端残留 raw/alt screen（触发：`/schedule create`、`/schedule edit`、`/codebuddy` prompt 编辑）。 | `src/ui/prompt-editor.ts:79-84`、`src/ui/dialogs.ts:391-398`、`src/ui/paste-input.ts:40-47` | 在 `PromptEditor` 中仅在异步粘贴排空（非同步 `handleInput` 调用栈内）且焦点不属于自身宿主容器时转发输入；补充使用真实 `TuiAltScreen` 输入字符的回归测试。 |

---

## 二、High（10 项）

| 编号 | 状态 | 问题与根因 | 涉及文件 | 建议修复与验收点 |
| --- | --- | --- | --- | --- |
| H1 | 已修复 | **S9 回归：`/export zip` 每个小交付物常驻 16 MiB 内存**：`readBoundedFile` 分配 `Buffer.allocUnsafe(maxBytes + 1)` 后返回 `raw.subarray(0, total)`，`subarray` 视图固定整块底层 `ArrayBuffer`。`bundle.ts` 以 16 MiB 上限读取并持有全部文件至打包结束，100 个小文件即可占 ~1.6 GiB，绕过 32 MiB 总预算导致 OOM。 | `src/runtime/files.ts:89-97`、`src/runtime/bundle.ts:310-319` | 按 `Math.min(info.size + 1, maxBytes + 1)` 分配并保留超读检测，或返回 `Buffer.from(raw.subarray(0, total))` 释放多余 backing buffer；单测断言 `buf.buffer.byteLength`。 |
| H2 | 已修复 | **窗口裁剪后并行工具调用退化为无名 `Tool` 卡片并挤掉真实卡片**：`entries.slice(renderer.retainedFrom)` 切掉较早的 `tool/call` 却保留其 `tool/result`；重建时 `callIdBySeq` 已有该 `seq`（`seenSeq === true`）跳过第 757 行守卫，`toolByCall` 无记录则在第 769 行合成 `name: 'tool', args: ''` 卡片，反将真实卡片挤出窗口。 | `src/ui/app.ts:342`、`src/ui/transcript.ts:744-785`、`src/ui/transcript-window.ts:40-50` | 第 769 行在 `index === undefined && settledCalls.has(callId)` 时直接 `break`；`retainedFrom` 取保留行依赖 entry 的最小值；补并行调用+窗口裁剪回归测试。 |
| H3 | 已修复 | **`mcp-recovery` 与 Host 真实错误格式不匹配，断线自愈失效**：`closedConnectionCode` 检查 `'ConnectionClosed'`，但 Host 实际写入 `'MCP_CONNECTION_CLOSED'`（`dsh-mcp-client/src/diagnostic.ts:92`）；`^Connection closed` 与 `^Error POSTing to endpoint` 带 `^`，而真实工具错误带 `MCP tool "…" failed: ` 前缀，且漏掉 `MCP transport closed`。 | `src/runtime/mcp-recovery.ts:38-47,87-89`、`tests/mcp-recovery.spec.ts` | 兼容 `MCP_CONNECTION_CLOSED`，先剥离 `MCP … failed: ` 前缀或移除 `^`，补充 `MCP transport closed`，并用真实 Host 错误样本重写单测。 |
| H4 | 已修复 | **`switchTo` 先退订再 `active.dispose()`，销毁失败后 UI 永久失联；`restartSession` 存在双重 dispose**：`switchTo` 在 `await active.dispose()` 前就 `disposeInteractions()` 与 `clearSubscriptions()`，dispose 失败时 catch 不恢复订阅；`restartHostSession` 已先 `await current.dispose()`，`switchTo` 又再次 dispose 旧 `active`，且 `resume` 失败会留下死句柄。 | `src/ui/app.ts:596-629,688-694`、`src/runtime/agent.ts:180-191,219-223` | `HostSession.dispose` 增加幂等守卫；`switchTo` 支持 opener 已释放旧会话的路径并在旧会话保留时恢复订阅；`restartHostSession` 失败时明确禁输入/提示重载。 |
| H5 | 已修复 | **空字符串配置（`sessionId` / `agentPreset` / `cwd`）导致下次启动直接失败**：`/settings host` 允许写入 `''`，`resolveConfig` 原样返回 `''`；启动仅判断 `=== undefined`，导致 `''` 进入 `resumeHostSession` 或 `presets.resolve('')` 在 TUI 起来前崩溃。 | `src/config.ts:91-96,141-155`、`src/ui/app.ts:196-198`、`src/runtime/agent.ts:200-208` | `resolveConfig` 将空白 `sessionId`/`agentPreset`/`cwd` 归一为 `undefined`，对 `cwd` 做 `resolve()`/绝对路径校验，并补单测。 |
| H6 | 已修复 | **原生 preset（`off`）下执行 Host `/plan` 绕过 plan-mode 工具门禁**：`current()` 对非交互 preset（如 `danger-full-access`）直接早退返回 `'off'`，导致 `reconcilePlan` 与 `planDenial` 全部跳过，模型在 plan 态下仍可无审批执行 `write`/`bash`/`apply_patch`，状态栏仍显示 `off`。 | `src/interaction-modes.ts:202-208,270-290` | `current()` / `planDenial` 优先读取 plan 投影状态并施加只读门禁，或确保 plan 激活时同步收紧沙箱并在结束时恢复原 preset。 |
| H7 | 已修复 | **`/codex logout` 与 `/codebuddy logout` 未取消在途 `/login`，凭据可被复活**：`/codex logout` 在记录尚不存在时提前返回，未取消 `inFlight`；`/codebuddy logout` 仅 `deleteRecord`，未 cancel/等待在途轮询流，完成后 `session.commit` 重新写回凭据。 | `src/runtime/codex-command.ts:396-399`、`src/codex/logout.ts:31-32`、`src/runtime/codebuddy-command.ts:30-45,248-261`、`src/codebuddy/auth.ts:278-281` | 两处 logout 均先 `cancel` 并等待在途授权流结束再删除凭据；`codebuddy/auth.ts` 在 `commit` 前复检 `signal.aborted`。 |
| H8 | 已修复 | **`CodeBuddyAdapter.refreshCatalogue` 绕过 token 刷新且失败无退避，故障时每 turn 卡顿 15 秒**：直接使用 `readGrant` 的 `grant.access` 不触发续期；失败后不记录时间且无退避，每次 `resolveModel`/`prepareCall`/`listModels` 都重新发起 15 秒请求，且不透传调用方 `signal`。 | `src/codebuddy/adapter.ts:390-418` | 改用 `accessToken(store, profile, signal)`，合并调用方 `signal` 与 timeout，并为失败记录短周期负缓存/退避。 |
| H9 | 已修复 | **`CodeBuddy` 登录轮询吞掉非 2xx 错误且单次请求无超时**：`pollToken` 将所有 `!response.ok`（401/403/429/500）返回 `undefined` 当作 pending，白等 5 分钟后误报超时；`POLL_TIMEOUT_MS` 仅在轮询间隙检查，挂起的 `fetch` 不会被 deadline 中止。 | `src/codebuddy/auth.ts:223-233,272-283` | 仅将已知 pending 码（11217）视为待完成，其余非 2xx 抛 `GatewayError`；用 deadline `AbortController` 合并 `session.signal` 传入请求。 |
| H10 | 已修复 | **`CodeBuddy` 图片准备在 20 MiB 预算前全量并发读取+Base64，重试呈 O(N²) 放大**：`prepareImages` 先对所有去重图片 `Promise.all` 读取编码后才校验预算，叠加 `IMAGE_OFFLOAD_COUNT_QUANTUM = 1`，每次重试只剥离 1 张并重读剩余图片。 | `src/codebuddy/wire.ts:85,261-279,486-487` | 读取前用 `attachment.bytes` 与数量预判预算，或限并发累计字节超限即止，必要时调大 offload quantum。 |

---

## 三、Medium（19 项）

| 编号 | 状态 | 问题与根因 | 涉及文件 | 建议修复 |
| --- | --- | --- | --- | --- |
| M1 | 已修复 | **Host 命令使用一次性 `AbortController`，Esc 无法取消**：`commands.execute` 收到 `new AbortController().signal`，与 `ctx().signal` 断开。 | `src/ui/commands/router.ts:310` | 改为透传 `ctx().signal`。 |
| M2 | 已修复 | **会话切换期间误吞全部按键（含弹窗 Esc）**：`switching` 守卫位于 `shortcut === undefined` 判断之前，消费普通输入与弹窗按键。 | `src/ui/app.ts:859-860` | 改为 `if (shortcut !== undefined && switching && ...)`。 |
| M3 | 已修复 | **会话切换不关闭旧会话的审批/提问弹窗**：`disposeInteractions()` 只注销监听，不 abort/hide 正在显示的 overlay，答案会回写给已销毁 agent。 | `src/ui/app.ts:263,555-582` | 为每个 session 维护独立 `AbortController`，切换时 abort 并 `tui.hideOverlay()`。 |
| M4 | 已修复 | **`/new`、`/resume` 在 turn 运行中静默取消并丢弃排队 prompt**：缺少 idle 守卫，`HostSession.dispose()` 直接 `cancel` 清空 inbox。 | `src/ui/commands/router.ts:186-198` | 与 `/reload`、`/permissions` 一致，running 时拒绝并提示等待或取消。 |
| M5 | 已修复 | **`dispose()` 并发调用提前 resolve，信号退出可截断清理**：`if (disposed) return` 不等待进行中的 `active.dispose()`，`onSignal` 缺少 `exiting` 守卫。 | `src/ui/app.ts:788-843` | 复用单例 `disposal` promise；`onSignal` 复用 `exiting` 守卫。 |
| M6 | 已修复 | **`ask_user_question` 长 detail 挤掉底部选项，Enter 仍提交不可见项**：调用 `showChoice` 未传 `maxTitleRows`，截断逻辑未生效。 | `src/ui/dialogs.ts:629-631,795-827` | 传入 `maxTitleRows`（如 3–4），完整 detail 仍走详情 pager。 |
| M7 | 已修复 | **Host settings 编辑器 prefill 绕过终端转义清洗**：远端 catalogue 等来源的配置字符串原样写入 `Input`，未剥离 ESC/C1。 | `src/ui/commands/settings-host.ts:221-240`、`src/ui/dialogs.ts:206-220` | 渲染/预填路径清洗或拒绝含控制序列的值。 |
| M8 | 已修复 | **`/provider add` 在确认与落盘前已写入/覆盖 API key**：取消向导或校验失败后旧 key 已被轮换不可恢复。 | `src/ui/commands/provider.ts:459-476,604-626` | 推迟 `credentials.set` 至所有确认与校验完成（或 settings 写后/原子协调），并提前校验 env 名。 |
| M9 | 已修复 | **catalog 路径 “Replace credential” 替换整条 route**：覆盖 `providers[route]` 会静默删除已有 `models` 与 `modelOverrides`。 | `src/ui/commands/provider.ts:492,606-626` | 保留已有 route 字段（仅更新/移除 `apiKeyEnv`），或提供 merge 选项。 |
| M10 | 已修复 | **`/reasoning map` 不兼容 Codex 空 `models: []` 路由**：将空数组当显式列表返回 `model-not-listed`，不回退 `modelOverrides`。 | `src/runtime/reasoning-map.ts:117-121`、`tests/reasoning-map.spec.ts:81` | 仅在 `models.length > 0` 时按显式列表处理，空数组回退 `modelOverrides`。 |
| M11 | 已修复 | **`ensureCodexRoute` 冲突重试时可能覆盖并发写入的 route**：直接重放对象级 `set providers.openai-codex = { models: [] }`。 | `src/codex/route.ts:151-153`、`src/runtime/settings-write.ts:58-66` | 冲突后先复读 route，已存在则返回 `present`。 |
| M12 | 已修复 | **`CodeBuddy` `accessToken` 并发登出后回退旧 token，且取消误报为 `AUTH`**：`grantOf(rotated) ?? initial` 返回已删旧 grant；catch 未判 `signal?.aborted`。 | `src/codebuddy/auth.ts:381-402` | `rotated === undefined` 时复读并缺则抛 `MISSING_CREDENTIAL`；abort 时抛 `ABORTED`。 |
| M13 | 已修复 | **`CodeBuddy` 并发 401 双重刷新且 403 误触发刷新**：`force=true` 绕过锁内已刷新判断，第二次刷新可使首请求新 token 失效。 | `src/codebuddy/stream.ts:249-258`、`src/codebuddy/auth.ts:379-390` | 传入被拒的 `rejectedAccess`，锁内已变更则直接返回；仅 401（及明确过期码）刷新。 |
| M14 | 已修复 | **`CodeBuddy` SSE 拆帧上限、心跳超时与 in-band error 边界缺陷**：① 4 MiB 检查在拆帧前按 UTF-16 长度判定；② `:` 心跳不重置 5 分钟 idle timer；③ 带 `choices: []` 的非零 `code` 被忽略、`error: null` 误判为错误。 | `src/codebuddy/sse.ts:43-55,89-90`、`src/codebuddy/stream.ts:188-194,357` | 先拆帧再按 UTF-8 字节检查残余 buffer；chunk 读取/心跳均重置 idle timer；按 `body.error != null` 及非零 `code` 判错。 |
| M15 | 已修复 | **`CodeBuddy` 插件卸载/热替换未注销登录流**：丢弃 `authorization.registerFlow` 返回的 unregister 回调。 | `src/codebuddy.ts:118-123,160-162` | 在 `authorized.effect` 中统一注销所有已注册 flow。 |
| M16 | 已修复 | **`accept-edits` 遗漏 `apply_patch`**：`FILE_EDITS` 仅含 `write`/`edit`，启用 `apply_patch` 时每次编辑仍触发审批。 | `src/interaction-modes.ts:67` | 将 `'apply_patch'` 加入 `FILE_EDITS` 并补单测。 |
| M17 | 已修复 | **`plan.get()` 未保护 `PLAN_STATE_UNAVAILABLE` 且 `beforePlan` 硬编码 `'accept-edits'`**：preset 切换/卸载窗口抛未捕获异常，无 `accept-edits` 的自定义 preset 表也会报错。 | `src/interaction-modes.ts:205,256-278` | 封装 `try/catch` 读取 plan；`beforePlan` 回退到 `nativePreset` / `defaultPreset` 并校验存在性。 |
| M18 | 已修复 | **`startTerminalApp` 后异常泄漏应用；compaction retention / `/context` composition / 旧 preset 恢复边界缺陷**：① `index.ts:98-113` effect 注册晚于 `syncLiveSettings()`；② `compaction-policy.ts:70-75` 拒绝合法的 `retainRatio`+`retainTokens` 共存；③ `agent.ts:115-158` 全量统计未重放 reasoning 导致 compaction 后 message bucket 归零；④ `agent.ts:236-239` 恢复已删除 preset 的旧会话直接失败。 | `src/index.ts:98-113`、`src/runtime/compaction-policy.ts:70-75`、`src/runtime/agent.ts:115-158,236-239` | ① `startTerminalApp` 后确保异常路径 `dispose()`；② `retainTokens` 优先共存；③ `unreplayedReasoningTokens` 排除被 compaction 阴影的事件；④ 历史 preset 缺失时回退 `defaultId`。 |
| M19 | 已修复 | **退出输出的 `Session` / `Resume` 行未转义与 shell 引用**：外部来源的 `sessionId` 含分号或控制序列时存在命令/OSC 注入风险。 | `src/runtime/launcher.ts:152-155`、`src/ui/app.ts:836`、`src/config.ts:72-84` | 对非安全字符的 `sessionId` / launcher 做 POSIX quoting，退出行经 `sanitizeTerminalText` 清洗。 |

---

## 四、Low & Nit（16 项）

| 编号 | 状态 | 级别 | 问题摘要 | 涉及文件 |
| --- | --- | --- | --- | --- |
| L1 | 已修复 | Low | P4 回归：compact 思考模式缓存键漏 `block.live`（settle 后仍停留在流式预览）；16 字符回看不足以拦截长 OSC 8 序列体。 | `src/ui/assistant-message.ts:25-29,55-63` |
| L2 | 已修复 | Low | R9 遗漏：`toolLabel` 仍按 UTF-16 `.slice()` 截断，可能产生孤立代理对。 | `src/ui/tool-output.ts:13-16` |
| L3 | 已修复 | Low | 极窄宽度（`inner < 4`）下 `MultilineInputDialog` 调用 `editor.render(inner)` 触发 pi-tui `wordWrapLine` 递归。 | `src/ui/dialogs.ts:381-385` |
| L4 | 已修复 | Low | `Math.max(...shadowedSeqs)` 在十万级 compaction 阴影事件下有 `RangeError` 风险。 | `src/runtime/metrics.ts:486` |
| L5 | 已修复 | Low | `open`/`reveal` 吞掉 `spawn` 异步 `ENOENT` 并返回 `true`，误报成功并隐藏手动打开提示。 | `src/runtime/open.ts:58-66` |
| L6 | 已修复 | Low | `/mcp list` 状态着色随后被 notice `sanitizeTerminalText` 剥离（死代码）；`/mcp auth` 轮询无总超时；`/mcp add|remove` 与 `/provider add` 长向导未在写入前刷新 revision。 | `src/ui/commands/mcp.ts:24,46,175-184,410-423`、`src/ui/commands/provider.ts:178,626` |
| L7 | 已修复 | Low | `listDirectory` 全量物化排序后再截断；Windows 下 `O_NONBLOCK` 无效，命名管道仍可能阻塞 `readBoundedFile`/`readTextPreview`。 | `src/runtime/files.ts:20-33,58,82` |
| L8 | 已修复 | Low | `/attach <path>` 仅按后缀名判图片，缺少字节嗅探（与粘贴路径不一致）。 | `src/runtime/attachments.ts:76-89` |
| L9 | 已修复 | Low | 导出文件默认权限 `0644`（应为 `0o600`）；JSONL/HTML 导出未接入 `AbortSignal`；默认文件名未清洗 `active.id`；ZIP 附件 entry 名未去重。 | `src/runtime/export.ts:37`、`src/runtime/html.ts:90`、`src/runtime/bundle.ts:268,285,356`、`src/ui/commands/workspace-files.ts:94-140` |
| L10 | 已修复 | Low | `writeSettingsOps` 冲突重试会重放含数组下标的路径 op；`provider.ts` 写回 `redactSecrets` 视图可能擦除 schema secret 字段；`settingsParseInput` 无法选中 `(unset)` / `undefined` union 分支。 | `src/runtime/settings-write.ts:52-67`、`src/ui/commands/provider.ts:78,267-307`、`src/runtime/settings.ts:129,345-349` |
| L11 | 已修复 | Low | `CodeBuddy` 细节：`PROFILE_ALIASES` 未防原型键；`service.refresh` 未透传 `deps.signal`；`redact` 漏 snake_case `access_token`/`refresh_token`；`supportedEfforts` 未去重；`finish_reason: 'content_filter'` 被映射为正常 `stop`；`finish_reason` 提前 return 丢弃尾帧 usage。 | `src/runtime/codebuddy-command.ts:130,279`、`src/codebuddy/errors.ts:104`、`src/codebuddy/models.ts:111-113`、`src/codebuddy/stream.ts:290-294,414-423` |
| L12 | 已修复 | Low | `providers.ts` 自定义 `baseURL` 接受 query/fragment/userinfo；`codex-command.ts:597-609` 忽略 `writeSettingsOps` 返回 `undefined`；`codex/login.ts:109-114` 重复 URL 仍提示手动打开。 | `src/runtime/providers.ts:80-88`、`src/runtime/codex-command.ts:597-609`、`src/codex/login.ts:109-114` |
| L13 | 已修复 | Low | `ensureLauncher` 对任意 `readFile` 错误都当作不存在并可能覆盖外来文件，且内容相同时不修复执行位。 | `src/runtime/launcher.ts:176-198` |
| L14 | 已修复 | Low | `git-branch` detached HEAD 仅认 40 位 SHA-1（不支持 64 位 SHA-256）；`/provider list` 在 `listModels` 抛错时仍显示 `0 model(s)`；`SessionEventCursor` 与 `interaction-modes` 依赖已弃用 API（长期迁移项）。 | `src/runtime/git-branch.ts:84`、`src/ui/commands/provider.ts:214-251`、`src/runtime/context-reading.ts:10-28` |
| N1 | 已修复 | Nit | `src/ui/app.ts` 已达 973 行，距 1,000 行上限仅剩 27 行余量；`handleGlobalInput` 末尾 `requestExit(0)` 缺少穷尽 `switch`。 | `src/ui/app.ts:906` |
| N2 | 已修复 | Nit | `package.json:52` 的 `spike:carrier` 指向不存在的 `src/spike/carrier.ts`。 | `package.json:52` |

---

## 五、分批实施与验证计划

### 实施批次（按依赖解耦、可并行推进）

1. **核心生命周期与模式（A 组）**：`H3`、`H5`、`H6`、`M16`、`M17`、`M18`、`M19`、`L4`、`L13`、`N2`。
2. **CodeBuddy / Codex 协议与路由（B 组）**：`H7`、`H8`、`H9`、`H10`、`M10`、`M11`、`M12`、`M13`、`M14`、`M15`、`L11`、`L12`。
3. **TUI 编排、弹窗与渲染（C 组）**：`C1`、`H2`、`H4`、`M2`、`M3`、`M5`、`M6`、`L1`、`L2`、`L3`、`N1`（顺手从 `src/ui/app.ts` 拆出独立进程/退出辅助模块，确保远低于 1,000 行上限）。
4. **斜杠命令与运行时 I/O（D 组）**：`H1`、`M1`、`M4`、`M7`、`M8`、`M9`、`L5`、`L6`、`L7`、`L8`、`L9`、`L10`、`L14`。

### 验收结果（2026-11-25）

- **全量门禁**：`pnpm check` 通过（`tsc -p tsconfig.json --noEmit` + `vitest run` **139 个测试文件 / 2,051 项测试全绿** + `tsc -p tsconfig.build.json` 构建通过，较修复前新增 7 个测试文件、149 项回归测试）。
- **源码行数门禁**：`find src -name "*.ts" -exec wc -l {} + | awk '$2 != "total" && $1 > 1000'` 输出为空（`src/ui/app.ts` 已拆出 `src/ui/app-lifecycle.ts` 与 `src/ui/app-session.ts` 降至 794 行；全仓最大文件 `src/runtime/metrics.ts` 931 行）。
- **独立复审补修**：全量只读复审后额外修复 7 项边界问题（`stream.ts` finish 后心跳保活改用 post-finish grace deadline、`compaction-policy.ts` `retainTokens` 不被高 `retainRatio` 否决、`assistant-message.ts` 增量 `hasControl` 消除 O(n²) 扫描、`app-session.ts`/`agent.ts` 仅在实际 dispose 后标记 `previousClosed`、`provider.ts` 新建 route 在 `credentials.set` 失败时回滚、`adapter.ts` `accessToken` 失败后新登录立即绕过冷却、`auth.ts` 仅 200/400 允许 `11217` pending）。
- **遗留说明**：`L14` 中 `SessionEventCursor`（`src/runtime/context-reading.ts`）与 `interaction-modes` 依赖的同步 Host API 经核实当前 `@deepseek-ai/dsh-session` 尚无替代接口，已补充注释说明并留作上游升级跟踪项。
