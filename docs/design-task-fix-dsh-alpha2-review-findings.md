# DSH alpha.2 升级审查问题修复

> 状态：已完成；保留的端到端环境限制见末节
> 日期：2026-10-28
> 前置：[0.2.2-alpha.2 适配记录](design-task-upgrade-dsh-0-2-2-alpha-2.md)（保留原验证记录，不改写已实施结论）

## 目标

修复审查确认的五个边界问题，保持现有权限范围和 Host 所有权。先补能够重现问题的测试，再逐项修复。沿用当前未提交的升级工作区，不提交、不推送，不修改全局 CLI 或真实 profile。

## 问题与验收

### 1. 空白会话恢复缺失模型（高）

- 位置：`src/runtime/agent.ts` 的 `resumeHostSession`。
- 原因：恢复没有 agentOptions fallback；空白 Session 没有 model/selection 或 request/header。
- 证据：真实 Host 新建空白 Session 后 reload，再发送消息，报 `has no provider/model`；证据 home 为 `.tmp/review-blank-9SYnax`。
- 修复：恢复时传入 Host 默认模型作为 fallback；有持久化选择时仍由核心优先使用，不能追加默认选择覆盖历史。
- 验收：空白恢复能够发起请求；历史模型与显式/自动 effort 不被新的部署默认值覆盖。

### 2. 权限弹窗隐藏范围与操作（中）

- 位置：`src/ui/dialogs.ts` 的 approval intent 展示。
- 原因：说明被作为不可滚动标题，1600 字符后截断，长标题挤掉动作，且无完整详情入口。
- 证据：长说明渲染 106 行，拒绝按钮在第 102 行；弹窗 maxHeight 为终端的 80%，末尾 scope 不可见。
- 修复：复用现有审批的摘要限高和完整详情分页；批准/拒绝/可选持久授权保持可见，详情不截断。按职责拆出权限问答组件，不使 dialogs.ts 超过 1000 行。
- 验收：短屏和长范围下固定动作可见；可查看末尾 scope；打开/关闭详情不授权、不写答案；Esc 与 signal 仍取消请求；显示标签不改变原始答案值，默认选中拒绝。

### 3. 模型选择异步竞态（中）

- 位置：`src/ui/commands/model.ts` 和 `src/ui/app.ts` 的命令上下文/持久化。
- 原因：resolveModelInfo 返回后不校验取消、Session 所有权及请求代次；持久化又读取可变 active。
- 证据：中止后仍写入选择并保存；先请求 older、再请求 newer，反向完成后实际选择回到 older，保存顺序为 newer/older。
- 修复：为一个模型选择所有者建立代次/有效性校验；取消、换会话和被较新请求取代的请求不再写入。持久化接收明确的选择快照，命令上下文绑定所属 Session。
- 验收：取消后无选择/状态/保存副作用；最新请求胜出；切换 Session 后旧命令不能污染新会话显示与默认设置；reasoning cycle 保留现有串行与自动档语义。

### 4. 模型发现缺失只读分类（中）

- 位置：`src/interaction-modes.ts` 的 READ_TOOLS。
- 原因：新增 list_subagent_models，但模式分类未同步。
- 证据：plan 直接拒绝，manual 要求审批无副作用查询。
- 修复：将该工具加入既有只读集合，不扩大其他工具权限。
- 验收：plan/manual/accept-edits 的 native 及 PTC 内层查询可用，仍禁止写入、委派及 sandbox escalation。

### 5. 模型目录刷新跨 provider 阻塞（中）

- 位置：`src/ui/model-picker.ts`。
- 原因：忽略 models-updated(provider) 的 provider 参数，全量请求并等待 Promise.all。
- 证据：P 的新目录已返回，Q 的未决请求仍令 P 的新内容不可见；Q 完成后 P 才更新。
- 修复：目录事件按 provider 定向读取并独立提交，拓扑事件重读 provider roster 并独立协调；每个 provider 的代次防止旧结果覆盖，删除/重加同名 route 也不得复活旧结果。
- 验收：P 不受 Q 阻塞；Q 失败保留其旧模型并显示状态；搜索词和选中项保留；关闭后晚到结果无效；加载期间更新不丢失；多 provider 乱序、拓扑删除及重加有覆盖。

## 验证计划

- 每项先跑新增回归观察预期失败，再修复并运行直接受影响测试。异步测试用 deferred/barrier，不用 sleep 代表状态成立。
- 最后执行 `pnpm check`、`git diff --check`，核对源文件不超过 1000 行。
- 使用全局 `dsh 0.2.2-alpha.2` 和隔离 profile 验证空白恢复、四套预设、实际模型路由、reload 及原生审批。
- PTC 审批详情此前遇到 `sandbox-exec: sandbox_apply: Operation not permitted`。复验时不通过关闭沙箱或扩大默认权限规避；若环境仍不支持，明确保留未验收项。
- 不使用真实凭据；生成 profile、构建产物、tgz 和本地证据不提交。

## 实施记录

- [x] 已记录问题、证据和验收项。
- [x] 空白恢复 fallback：新增空白/已有选择两项回归；修复前空白用例失败，修复后 agent 22 项及 typecheck 通过。
- [x] 权限长说明和固定动作：两项新增测试修复前失败；抽出 question-approval.ts 并复用审批详情分页后，相关 32 项及 typecheck 通过。
- [x] 模型选择取消、乱序及 Session 所有权：五项新增回归修复前失败；修复后模型/目录/reasoning 相关 52 项及 typecheck 通过。持久化传明确快照，并抑制旧 Session 的迟到显示更新。
- [x] 模型发现只读分类：三个模式的 native/PTC 回归修复前失败；加入只读集合后 interaction-modes 59 项通过，写入/委派/escalation 负向断言保留。
- [x] provider 独立刷新：定向读取、慢路由隔离两项测试修复前失败；修复后目录/弹窗 37 项及 typecheck 通过。另补初始空目录期间更新的失败回归并修复，目录共 21 项通过；包含拓扑删除重加与失败保留覆盖。
- [x] 最终验证与限制回填。

## 最终验证

- `pnpm check`：82 个测试文件、1099 个测试全部通过；typecheck 与 build 通过。本轮新增 16 个测试，五项主问题均观察到预期失败后修复。
- `pnpm peers check`：无 peer dependency 问题。`git diff --check` 与 `node --check scripts/upgrade-core-e2e.mjs` 通过。
- 修改的主要源文件行数：app.ts 958、dialogs.ts 877、model-picker.ts 113、question-approval.ts 50、commands/model.ts 183，均未超过 1000 行。
- `DSH_CLI_ENTRY=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js node scripts/upgrade-core-e2e.mjs`：全局 CLI 确认为 0.2.2-alpha.2；standard/ptc/minimal/cordis 共 12 个场景通过，包括新增的四个空白 Session reload 后直接使用默认 model-a 发起请求的场景，以及原有新建、恢复、实际 model-b 路由和 reload。证据：`.tmp/upgrade-core-3Gpc9c`。
- 隔离 profile 执行 `node scripts/fake-tty-approval.mjs`，指定同一全局 DSH_CLI_ENTRY：allow、reject、cancel-row、cancel-esc 四种原生审批结果通过，输出 `OK approval waterfall verified`。
- 使用现有短屏组件测试验证完整权限范围可分页查看，查看/退出详情不授权；取消及原始答案值语义保持。模型和目录竞态以 deferred 受控结果验证，不依赖真实网络或凭据。

## 保留限制与交付状态

- PTC accept-edits 审批详情/文件效果探针此前在同一会话环境被系统拒绝创建 sandbox，返回 `sandbox-unavailable` / `sandbox-exec: sandbox_apply: Operation not permitted`。本轮未改变该环境，也未通过关闭沙箱或反复执行制造通过结果；该端到端场景仍需在允许创建 sandbox 的宿主终端复验。PTC 普通 read 往返和权限详情组件测试已通过，不能用它们替代此项验收。
- 没有新增权限预设、开放委派/写入或放宽 sandbox escalation。没有修改核心仓库、全局 CLI、真实用户 profile，也没有提交或推送代码。
- 原升级文档保留原始实施与验证记录，本修复记录承接其后续问题。
