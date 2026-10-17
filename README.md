# dsh-native-tui

DeepSeek Harness 的 host-native 终端前端，基于 pi-tui。

> 状态：实施完成（30 轮 + 第三方模型引导，56 个单元测试通过）；已知差距见进度记录。  
> 目标：在 TUI 中提供 Web 模式的核心能力，而不是复制浏览器图形界面。  
> 架构说明与差距清单：[Host-native 方案](docs/design-task-feature-dsh-native-tui-host-native.md)。  
> 实施进度、验证证据与未验收项：[实施进度](docs/progress-dsh-native-tui.md)。

## 特性

- 新建/恢复 Session，owned root Agent。
- 流式文本、Markdown、reasoning、工具卡片（write/edit 结果渲染 ± diff 行）、turn 失败提示。
- 本地命令与宿主命令执行（compact/feedback/goal/permission/plan）。
- 审批与问答 waterfall；question probe 已通过真实 Host 验证。
- 模型选择器（LLM catalog 为空时明确提示）、权限预设、后台任务、子代理列表。
- 第三方模型：`/provider add` 引导配置 pi-ai gateway/catalog route，`/provider list|remove` 管理。
- Agent Presets：standard / ptc / minimal / cordis；/preset 可在首个 turn 前切换当前 Session，已开始的 Session 锁定并用于下一次 /new。
- Workspace 列表/创建/切换/pin/unpin/archive/unarchive；Schedule 列表/创建/删除；Settings 顶层/嵌套对象/数组字段编辑与 JSON 写入；Plugins 列表/官方市场/检查/安装/移除/启停（带确认，实时应用）。
- 可选 `fullscreen`：TuiAltScreen + ScrollView，header/status/editor 固定，鼠标滚轮滚动、文本选择复制。
- `@@<query>` 自动补全其他 Session 的 canonical mention；发送时 Host session-reference 自动注入快照。
- `/export [path]` 导出 Session JSONL；`/export zip [path]` 导出含 manifest、attachments、deliverables 的 ZIP bundle；`/export html [path]` 导出静态 HTML transcript；`/open` 预览文本文件，Markdown 以 pi-tui Markdown 样式分页渲染；`/preview` 渲染 PNG/JPEG/GIF/WebP 图片；`/files` 浏览目录并预览；`/attach` 暂存文件/图片或剪贴板图片并随下一条 prompt 发送（8 MiB 上限），`/attach preview <i>` 可内联预览暂存项，`/attachments` 打开暂存附件管理器（预览/移除）；`/deliverables` 可列出、打开 panel、预览或用系统文件管理器定位 present 交付文件；`/tools` 列出工具调用，`/tool <index>` 分页查看完整参数/结果，`/diff [index]` 查看 write/edit 的独立 diff。
- 问答/审批在 preset Agent 上仍可用（question probe 已通过）。
- `@file` 主机端补全（file-reference-local）与 `/` 本地/宿主命令补全；选中的路径作为普通 prompt 文本，模型需用 read 工具读取。
- 会话列表/按 id 恢复、状态、清屏、安全退出、终端恢复。
- 非 TTY 显式失败；Ctrl+C/Ctrl+D/SIGTERM/SIGHUP 安全退出。

## 安装

~~~sh
pnpm install
pnpm build

# 在全新或已有的 DSH profile 中安装；dsh 会启用 bundle
dsh plugin --profile tui add /absolute/path/to/dsh-native-tui

# 启动
dsh --profile tui
~~~

DSH Host 包由当前 dsh 安装提供；本插件只把 pi-tui 与 schemastery 作为运行时依赖。  
安装路径使用 link: 时，修改源码后重新 pnpm build 即可生效。

## 命令

| 命令 | 作用 |
|---|---|
| /help | 本地命令、宿主命令、按键提示 |
| /new | 创建新 Session 并切换 |
| /sessions | 列出已持久化 Session |
| /resume <id> | 恢复指定 Session |
| /status | Session、cwd、模型、状态、事件数 |
| /clear | 仅清空终端视图 |
| /cancel | 取消当前 turn |
| /model [provider/model] | 列出或切换模型；目录为空时明确提示 |
| /provider [add|list|remove <route>] | 引导配置/查看/删除第三方模型 provider |
| /permissions [preset] | 列出或切换权限预设 |
| /jobs [kill <id>] | 列出或终止后台任务 |
| /agents | 列出直接子代理 |
| /preset [id] | 首个 turn 前切换当前 Session；已开始则用于下一次 /new |
| /workspaces [new <path>|use <id|path>|pin|unpin|archive|unarchive] | 列出/创建/切换/固定/归档 workspace 会话 |
| /schedule [add <seconds> <title>|delete <id>] | 列出/创建/删除一次性提醒 |
| /plugins [list|market [query]|inspect <spec>|install <spec>|remove <bundle>|enable <entryId>|disable <entryId>] | 列出、浏览官方市场、检查/安装/移除 bundle，或启停插件项 |
| /settings [edit <ns>|items <ns> <field>|set <ns> <json>] | 字段编辑、数组项编辑，或 JSON 合并写入 |
| /export [path|zip [path]|html [path]] | 导出 JSONL、ZIP bundle，或静态 HTML transcript（不覆盖已有文件） |
| /open <path> | 预览文本（16 KiB 上限）；Markdown 渲染为样式化分页 |
| /files [path] | 目录浏览：Enter 进入目录/预览文件，Esc 退出，含 ../ |
| /preview <image> | 用 pi-tui Image 渲染 PNG/JPEG/GIF/WebP；不支持时显示文本占位 |
| /changes [diff <index>] | 查看最近一轮 workspace 变更文件/单文件 diff |
| /deliverables [panel|open|reveal <index>] | 列出、打开 panel、预览或用系统应用定位 present 交付文件 |
| /tools · /tool <index> | 列出工具调用，或分页查看完整参数与结果 |
| /diff [index] | 分页查看最近/指定工具调用的 write/edit diff |
| /attach <path>|paste|preview <i>|list|clear | 暂存或预览文件/图片/剪贴板图片，随下一条 prompt 发送 |
| /attachments | 暂存附件管理器：预览或移除 |
| /exit, /quit | 退出并恢复终端 |

Enter 发送；运行中 Enter 作为 steer；Ctrl+C 取消/退出；Ctrl+D 退出。

## 配置

~~~yaml
- id: native-tui
  name: dsh-native-tui
  config:
    sessionId: native-tui-fixed   # 可选：恢复固定 Session
    cwd: /path/to/workspace
    showReasoning: true
    maxTranscriptEntries: 2000
    fullscreen: false              # true 使用 alt-screen + 鼠标/应用滚动
    theme: auto                    # auto | dark | light | plain
    agentPreset: ptc               # 默认 ptc | standard | minimal | cordis
    title: DeepSeek Harness
~~~

默认模型来自 Host 的 ctx.agentDefaultModel（Base 默认 deepseek-official/deepseek-flash）。没有凭据时首个请求会显示 MISSING_CREDENTIAL。

## 第三方模型

`/provider add` 提供引导流程：

1. 选择 Custom OpenAI-compatible / OpenAI Responses / Anthropic-compatible gateway，或 Built-in pi-ai catalog route。
2. 输入 route、baseURL、`apiKeyEnv`、model id；context window 与 max tokens 有默认值。
3. 保存后立即刷新 `/model` 并选择模型。

`apiKeyEnv` 只保存环境变量名，密钥本身不写入配置或终端历史。启动前导出：

```sh
export MY_GATEWAY_API_KEY=...
dsh --profile tui
```

`/provider list` 显示已配置 route 与当前可见模型数；`/provider remove <route>` 删除。若保存后 `/model` 仍为空，通常是 `apiKeyEnv` 未设置；llm-pi-ai 在凭据缺失时会故意返回空模型列表。手工 JSON 配置仍可通过 `/settings set llm-pi-ai ...` 或 Web Models page 完成。

## 开发与验证

~~~sh
pnpm check          # typecheck + 56 unit tests + build
pnpm test
pnpm build
~~~

当前沙箱无法创建 PTY，使用 fake TTY 包装器验证真实 Host 启动：

~~~sh
# 使用已有的测试 profile（外部目录，不污染仓库）
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-smoke.mjs

# 命令、失败路径、问答题探针
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-interaction.mjs
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-question.mjs
DSH_HOME=/tmp/dsh-native-tui-install-home node scripts/fake-tty-preset.mjs
~~~

普通终端环境可运行真实 PTY 冒烟：

~~~sh
python3 scripts/pty-smoke.py
~~~

## 已知差距

Plugin Manager 官方目录之外的市场搜索（官方目录浏览已实现）、PDF/Office 富文档预览（Markdown 已支持）、会话级附件管理器（当前覆盖 staged 附件）、远端连接尚未实现。详见架构文档第 6 节。

## 兼容性

- 已在全局 dsh 0.2.1-rc.1 上安装并启动；源码开发类型基于 0.2.1-rc.2。
- Preset patch 从 `@deepseek-ai/dsh-web-app` 的 standard/ptc/minimal/cordis 复制而来；standard/ptc/minimal 需要 `subagent-model-selection-settings` Host 行，cordis 需要 cordis host-runner 与 tool-cordis/host。`@file` 补全依赖 `@deepseek-ai/dsh-file-reference-local`。
- pi-tui 1.3.0；Node 22.23.3。

## License

[MIT](LICENSE)
- package 仍为 private；许可证为 MIT。