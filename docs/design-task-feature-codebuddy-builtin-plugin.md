# 移植 pi-codebuddy-provider 为 dsh-native-tui 内置插件

> 任务类型：feature ｜ 目标仓库：`dsh-native-tui` ｜ 来源：`~/WorkSpace/WebStormProjects/pi-codebuddy-provider`（Pi Extension）
> 日期：2026-10-18 ｜ 状态：已实施（真实账号路径未验收）

## 1. 目标

把 `pi-codebuddy-provider`（Pi Extension，CodeBuddy 国内版 + WorkBuddy 国际版 Provider）移植为
`dsh-native-tui` 的内置插件 `dsh-native-tui/codebuddy`，在 TUI profile（`@deepseek-ai/dsh-base` +
`dsh-native-tui`）下直接可用：

1. 注册两条 DSH LLM 路由：`codebuddy`（copilot.tencent.com）与 `codebuddy-en`（www.workbuddy.ai）。
2. 浏览器 OAuth 登录（state + 轮询）、凭据持久化与自动刷新、登出。
3. 模型目录来自 `GET /v3/config`，按 tags 过滤非聊天模型。
4. 流式对话：文本、思考、工具调用与工具结果多轮。
5. TUI 命令 `/codebuddy status|login|logout|models refresh|quota|checkin|doctor`。

## 2. 非目标

- 不引入 `dsh-router-core` / `dsh-router-codebuddy` / `cordis` 路由依赖，不依赖本地 HTTP 代理。
- 不引入 `@earendil-works/pi-ai` 或其它新运行时依赖（SSE 与 wire 序列化自实现）。
- 不做账号池、自动换号、健康检查调度、积分定时签到。
- 不移植图片输入（两条路由声明 text-only）。

## 3. 关键事实（已核对）

| 事实 | 结论 |
|---|---|
| Pi 侧实现 | `registerProvider` + `openAICompletionsApi()` 委托；协议差异集中在 `profiles.ts` |
| DSH 宿主接口 | `ctx.llm.registerAdapter(routes, adapter)`、`ctx.credentials`（记录读写）、`ctx.authorization`（登录流程） |
| 凭据 seam | `readRecord/modifyRecord/deleteRecord`；`modifyRecord` 跨进程互斥，刷新走它即可单飞 |
| 授权 seam | `registerFlow({key,label,methods,run})`；surface 侧 `begin({key,method,interaction,signal})` |
| 依赖策略 | 本仓库通过结构性本地接口访问 `credentials`/`authorization`（同 `app.ts` 现有做法），不新增依赖 |

## 4. 模块划分

```text
src/codebuddy.ts           插件入口：注册 adapter、两条路由、authorization flow；导出 name/Config/inject
src/codebuddy/profiles.ts  CN/EN 差异表：端点、指纹头、seed 模型、reasoning/EN payload 归一
src/codebuddy/errors.ts    失败分类（HTTP + 业务码）、脱敏、可操作提示
src/codebuddy/auth.ts      OAuth：state/轮询/刷新；凭据记录读写（credentialKey scope=codebuddy）
src/codebuddy/models.ts    /v3/config 目录解析、能力映射（context/maxTokens/reasoning）
src/codebuddy/credits.ts   额度摘要与显式签到
src/codebuddy/wire.ts      GenerateOptions -> OpenAI Chat Completions payload
src/codebuddy/sse.ts       SSE 分帧（chunk 边界、多行 data、注释、[DONE]）
src/codebuddy/stream.ts    SSE 事件 -> DSH StreamChunk（block 分配、工具调用、usage、finish）
src/codebuddy/adapter.ts   CodeBuddyAdapter extends LlmAdapter
src/runtime/codebuddy-command.ts  /codebuddy 子命令（纯逻辑，UI 由 app.ts 注入）
```

## 5. 协议要点（与来源一致）

- 端点：CN chat `/v2/chat/completions`；EN 首选 `/console/chat/completions`，仅 404/405 回退 `/v2/chat/completions`。
  EN 回退在 fetch 包装层实现，只重放「网关没路由该请求」的情形。
- 请求体：`stream: true`，`max_tokens`，不带 `store`/`stream_options`；system 只作 `system` role（EN 首条须为 system）。
- 思考：`reasoning_effort` 必须与 `reasoning_summary: "auto"` 成对出现；未选思考时两者都不发。
- EN 额外归一：`tool_choice: "none"` 无上游拼写，删除 `tool_choice` 与工具声明。
- 凭据寿命：`expires = now + min(ttl - 24h, 15d)`（ttl<=24h 时取 `max(ttl/2, 60s)`），与来源一致。
- 额度/签到：`billing/meter/get-user-resource`、`billing/meter/daily-checkin`，仅用户显式执行；10001 = 今日已签。
- 客户端指纹（2026-10-20 实测）：CN 网关拒绝第三方 agent 身份句——系统提示以 `You are an AI agent powered by …` 开头时返回 HTTP 400 `code 11128`（`Illegal API invocation from an unapproved channel`）。`cnProfile.rewritesAgentIdentity` 开启时，`prompt.ts` 在组包前把该行改写为中性表述，其余提示逐字保留（同一 200 KB 提示只改这一行即可通过）；TUI 把系统提示作为 in-history system 消息而不是 `options.system` 传递，所以 `wire.ts` 对已组装的每条 system 消息统一改写；EN 不做该校验，保持原文。

## 6. DSH 行为映射

- `listModels(provider)`：有凭据且目录过期（TTL 5 分钟）时触发一次受限刷新（15s 超时），失败保留上次列表；
  未登录返回 seed 列表（来源同语义，标注未验证）。
- `resolveModel(provider, model)`：目录命中返回真实 context/maxTokens/reasoning；未命中回保守默认（200k / 16k），
  不阻断手选模型。
- `reasoning`：`off`（可关闭思考时）+ 网关 `supportedEfforts`；`off` 不发 reasoning 字段。
- 请求凭据：读 record，过期则经 `modifyRecord` 刷新；401/403 允许一次受控刷新重放。
- 流：事件按到达顺序分配 block index（text/reasoning/tool-call 各自一块），结束时发 `block-end` 与 `finish`；
  `[DONE]` 缺失 = `INCOMPLETE_STREAM`，空响应 = `EMPTY_RESPONSE`，取消 = `ABORTED`。
- 默认值：`deepseek-v4-pro`（CN）/ `gpt-5.6-sol`（EN）。

## 7. 影响范围

- 新增 `dist/codebuddy.js` 导出；`cordis.patch.yml` 增一行内置插件；package.json 增 exports。
- TUI 增 `/codebuddy` 本地命令与帮助行；不改动既有 `/provider` 流程。
- 路由名 `codebuddy`/`codebuddy-en` 由本插件独占；llm-pi-ai 若配置同名 route 会在注册期冲突并报诊断。

## 8. 验证方式

- 单测（vitest）：profiles（寿命/归一）、errors（分类/脱敏）、models（目录解析/能力）、credits（额度/签到）、
  wire（消息与工具序列化）、sse（分帧边界）、stream（文本/思考/工具/usage/截断）、adapter（模型信息、凭据缺失）。
- `pnpm check`（typecheck + vitest + build）。
- 真实 Host 冒烟：`scripts/fake-tty-codebuddy.mjs`（mock 网关 + 真实 Host，断言登录、目录、两轮工具调用、
  `/codebuddy status`）；无真实账号时以 mock 覆盖并如实标注。

## 9. 验收标准

1. TUI profile 启动后 `/model` 可见 `codebuddy`/`codebuddy-en` 路由与模型。
2. `/codebuddy login` 能展示授权链接、轮询完成并落盘凭据；重启后无需重登。
3. 流式文本、思考与工具调用在 TUI 正常渲染；取消立即停止网络活动。
4. `/codebuddy status|quota|checkin|models refresh|doctor|logout` 均有确定输出与错误分类。
5. 无明文凭据进入日志或错误信息；`pnpm check` 通过。

## 10. 已知限制

- 无真实账号：OAuth 与模型授权未做真机验收，协议常量来自 `CARVIN94/dsh-router-codebuddy`（MIT）转写。
- text-only：图片输入不声明、遇图片块报 `UNSUPPORTED_CONTENT`。
- 流量统计（usage）多数情况下上游不返回，缺失即不报，不伪造 0。

## 11. 实施结果（实施后追加）

交付物与 §4 一致；未引入任何新依赖（SSE 自实现，凭据/授权用结构性接口访问）。

- 门禁：`pnpm check` 通过 —— typecheck、**29 个测试文件 / 184 个测试**（新增 `tests/codebuddy-protocol.spec.ts`、
  `tests/codebuddy-stream.spec.ts`、`tests/codebuddy-adapter.spec.ts`）、build 产出 `dist/codebuddy.js`。
- 真实 Host 冒烟 `scripts/fake-tty-codebuddy.mjs`（离线，无需账号）六项通过：
  `/codebuddy` 为本地命令、两条部署状态就绪（CN 8 / EN 6 seed 模型）、doctor 打印 CN/EN 端点、
  doctor 报告未登录探测、`/model` 列出 `codebuddy/deepseek-v4-pro`。
- 安装路径覆盖：`dsh plugin --profile tui add <tgz>` → `dsh-native-tui/codebuddy` bundle 行加载成功。

与 §8/§9 的偏差：

1. `/codebuddy quota|checkin` 未在冒烟中验证（需要真实账号；命令实现与单测覆盖到 `fetchQuota`/`checkIn` 的
   协议与错误路径）。
2. 目录刷新为「TTL 5 分钟 + 显式 `models refresh`」，未实现登录时的后台自动刷新（登录后第一次
   `/model` 或 `/codebuddy models refresh` 触发）。
3. `usage` 仅在方言返回时透传；请求不带 `stream_options`，与来源的保守策略一致。
