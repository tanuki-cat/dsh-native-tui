# dsh-native-tui 实施进度

> 记录时间：2026-10-17 17:48 CST  
> 工作区：`/Users/wangzy/WorkSpace/WebStormProjects/dsh-native-tui`  
> 状态：**Goal complete**（30/30 轮），插件可构建、可测试、可安装  
> 包版本：`dsh-native-tui@0.1.0`  
> 关联文档：[README](../README.md)、[Host-native 方案](design-task-feature-dsh-native-tui-host-native.md)

## 1. 结论

已完成一个可在最新 DeepSeek Harness 上通过 `dsh --profile tui` 启动的 host-native TUI 插件。实现覆盖会话、流式对话、Markdown、工具卡片、审批/问答、模型/命令、Workspace、Schedule、Agent Presets、Settings、Plugin Manager，以及文件、附件、图片、跨 Session 引用、变更摘要、Deliverables、导出和全屏终端模式。

交付物是可安装的 tarball 与完整源码，不是一次性的演示脚本：

```sh
pnpm check
pnpm pack --pack-destination .tmp
dsh plugin --profile tui add .tmp/dsh-native-tui-0.1.0.tgz
dsh --profile tui
```

## 2. 架构决策

原方案是 **Host + 进程内 Web Client + pi-tui**。Phase 0 验证发现已发布的 Web client 入口是浏览器 module-loader 包装（`window.__ModuleLoader__.load(...)`），在 Node 内无法加载；因此最终采用：

**Host services + pi-tui + Host-native TUI**

- 不引入浏览器数据层，不伪造 Web client。
- 直接使用 Host 的 `ctx.agents`、commands、approvals、questions、LLM、settings、plugins、workspaces、schedule、attachments、file references、session references、workspace changes 等服务。
- 通过 Cordis bundle patch 挂载 Host 行和四个 Agent Preset patch。
- 这是与原目标的**明确偏差**，已记录在 Host-native 方案中，建议 review。

## 3. 已交付能力

| 领域 | 已实现 |
| --- | --- |
| Session | 新建、恢复、列表、状态、清屏、导出、安全退出 |
| 对话 | 流式 assistant/reasoning、Markdown、steer、cancel、失败 turn 展示 |
| 工具 | 工具卡片、write/edit diff 行、`/tools`、`/tool <index>` 分页、`/diff [index]` |
| 审批/问答 | approval waterfall、question 面板、Other 自由文本 |
| 模型/命令 | 模型选择、第三方 provider 引导、权限预设、Host commands、jobs、subagents |
| Preset | 首个 turn 前切换当前 Session；开始后锁定，改用 /new |
| Presets | standard / ptc / minimal / cordis |
| Workspace | list/create/use/pin/unpin/archive/unarchive |
| Schedule | list/add/delete |
| Settings | 顶层字段、嵌套对象下钻、数组项编辑、JSON merge、secret 保护 |
| Plugins | list、官方 market、inspect、install、remove、enable/disable |
| 文件 | `/files` 浏览、`/open` 文本与 Markdown、`/preview` 图片 |
| 附件 | 路径/剪贴板图片、`/attach preview`、`/attachments` 管理器 |
| 引用 | `@file`、`@@session` canonical mention |
| Web 附加 | `/changes`、`/deliverables` panel/preview/reveal、JSONL/ZIP/HTML 导出 |
| 终端 | 可选 `fullscreen`（TuiAltScreen + ScrollView + mouse）、安全终端恢复 |

## 4. 验证证据

### 构建与测试

```text
pnpm check
  tsc -p tsconfig.json --noEmit
  vitest run
  tsc -p tsconfig.build.json

Test Files  17 passed (17)
Tests       63 passed (63)
```

### 安装与启动

最终验证使用全新 DSH_HOME：

```text
DSH_HOME=/tmp/dsh-native-tui-pack30-home
dsh plugin --profile tui add .tmp/dsh-native-tui-0.1.0.tgz
node scripts/fake-tty-smoke.mjs
EXIT 0
```

### 已实际验证的路径

- 四个 Preset 列表与创建路径；`/preset` 展示 standard/ptc/minimal/cordis。
- `/help` 完整本地/宿主命令列表。
- `/changes` 无摘要路径；`/tools`、`/diff` 无调用路径。
- `/export zip` 生成 session.jsonl/manifest.json/README 与附件/交付目录结构。
- `/export html` 生成转义后的静态 HTML。
- `/settings edit` 写入 `agent-loop.maxParallelToolCalls`；`/settings items` 列出模型数组。
- Plugin market 列出官方 claude-code/codex；本地 probe bundle 的 inspect/install/remove 成功。
- 剪贴板 RGB PNG → `/attach paste` → `/attach preview` → `/attachments` → 图片 overlay。
- `@@` 在真实 profile 中列出其他 Session 候选；Tab 插入后的发送未完整验证。
- `fullscreen: true` 启动、`/help`、Ctrl+D 退出；桌面鼠标拖拽未验证。

### 未完成真实验证

- **没有模型凭据**，真实模型流式回合、真实工具调用、真实审批/问答 waterfall 未端到端跑通；只验证了事件管线、失败 turn、UI 路径和 Host 服务。
- 沙箱无法创建真实 PTY，使用 fake-TTY 包装验证。
- 真实 `present` 工具事件未触发，deliverables panel/reveal 只有格式化和空缺路径验证。
- 真实终端鼠标拖拽/选择复制未验证。

## 5. 主要产物

```text
package.json                 dsh-native-tui@0.1.0
cordis.patch.yml             Host 行、preset registry、native-tui 行
presets/standard|ptc|minimal|cordis.patch.yml
src/index.ts                 Cordis 入口、TTY 守卫
src/config.ts                schemastery 配置、fullscreen
src/runtime/                 agent/session、attachments、bundle、html、images、open、providers、settings、tool-log
src/ui/                      app、autocomplete、dialogs、transcript、diff、theme
tests/                       19 个测试文件，63 个测试
scripts/fake-tty-*.mjs       fake-TTY 验证脚本
README.md
docs/design-task-feature-dsh-native-tui-host-native.md
.tmp/dsh-native-tui-0.1.0.tgz
```

依赖：`@earendil-works/pi-tui@1.3.0`、`@deepseek-ai/schemastery@3.18.5`、`fflate@^0.8.3`。

已初始化本地 git 仓库（main）；首次提交 `50ced8d`，第三方模型引导见后续提交。

## 6. 已知差距

- 官方目录之外的市场搜索未实现；官方 catalog 浏览和任意 spec 安装已实现。
- PDF/Office 富文档预览未实现；Markdown/文本/图片已支持。
- 远端连接未实现；当前是本地/SSH 终端使用。
- 会话级附件管理器未实现；当前 `/attachments` 管理 staged 附件。
- 真实审批/工具/模型流式回合缺少凭据验收。
- Deliverables panel 的真实 present 事件路径未验收。
- `/provider add` 支持 DSH credential store（粘贴一次 key，写入 0600 credential 文件）或 UPPERCASE env 引用；API key 在输入时可见。自动发现依赖 endpoint 的 `/models` 列表，失败时回退手动输入；模型能力显式写入 `input`，已有 profile 需重配或手动补。
- 旧版本可能已把误填的 key 写入 `apiKeyEnv`：需 `/provider remove <route>` 并轮换 key。
- 第三方模型引导已用 dummy key 验证配置、写入和 `/model` 选择，未发起真实推理请求。
- 使用本地 HTTP `/v1/models` 验证自动发现：列出 auto-model/auto-small，选中后写入 64000/8192 容量并直接选中模型。
- fake TTY 验证新 chrome：两行 Header、分隔线、`● idle  preset ptc` 状态条、`i Local commands` notice。
- 本地 mock SSE endpoint 验证 Esc：流式输出中按 Esc 后请求关闭、状态回 idle、显示 `! Turn cancelled`。
- 工具 call 的 `[tool-call]` 内容不再进入正文；参数 JSON 按字段展开 code/description/timeoutMs。
- `/provider add` 已验证 Input modalities=Text + image 会显式写入 `input: [text, image]`。
- 已验证 Store API key 模式：粘贴 key → credential store（0600）→ 自动发现 stored-model → 保存并选中，`/provider list` 显示 `(stored)`。
- 已验证裸 `quit` 退出 TUI，退出码 0。
- 已验证把 `sk-proj-...` 填入 env 字段会被拒绝且不写 profile；缺 env 时同样不保存。
- 默认 Agent Preset 已设为 ptc：全新 profile 启动后 `/status` 显示 `Preset: ptc`；既有 Session 仍按其记录恢复。
- 已验证空白 Session 的 `/preset minimal` 直接切换当前 Session，`/status` 显示 minimal。
- 已验证首个 turn 失败后 `/preset ptc` 返回 `This session has already started`，并提示 next /new 使用 ptc。

## 7. 建议验收步骤

1. 配置 `DEEPSEEK_API_KEY`，启动真实会话，验收流式文本、工具卡片、审批/问答。
2. 让模型执行 write/edit 与 present，验收 `/diff`、`/deliverables panel`、ZIP/HTML 导出。
3. 在真实 PTY 终端验证 `fullscreen: true` 的滚动、鼠标选择复制、Ctrl+D 恢复。
4. Review Host-native 架构偏差与已知差距，决定是否继续补 PDF/Office、远端连接。
5. 如需发布，补 git 初始化、commit、版本策略与 CI。

## 8. 轮次摘要

| 阶段 | 主要内容 |
| --- | --- |
| 1–4 | Host-native 架构、bundle patch、四个 Preset、Session、基础 TUI |
| 5–8 | 附件暂存、文件浏览、Settings 字段、Plugin 启停 |
| 9–13 | 工具 diff、workspace changes、deliverables、Settings 下钻、Plugin install |
| 14–20 | Plugin remove/market、剪贴板图片、图片预览、alt-screen、`@@session` |
| 21–25 | 附件预览、ZIP/HTML 导出、Deliverables reveal、工具结果 pager、Markdown |
| 26–30 | 独立 Diff、附件管理器、Settings 数组、Deliverables panel、收尾验证 |
| 后续 | 第三方模型 `/provider add|list|remove` 引导与自动模型发现，19 个测试文件 / 63 个测试 |
