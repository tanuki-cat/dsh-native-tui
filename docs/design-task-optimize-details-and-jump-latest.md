# 统一详情入口与回到最新消息

## 目标与范围

根据参考图统一工具、源码、diff、PTC 与 context 的详情展开入口，采用 Codex CLI 风格的淡色 `Show details` / `Hide details`；全屏使用输入区域上方居中的 `↓ Back to bottom · esc` 紧凑按钮。

## 实施方案

- 新增共享详情行组件，统一缩进、淡色文字和 `· ctrl+o` 快捷键提示；不使用加减号和 `to expand/to collapse`，行数省略提示统一使用 `…` 前缀并去掉内联展开文案（diff 内的 `⋮` 表示 hunk 省略，保留原义）。每张卡片只保留一个详情入口，省略行数、长行裁剪与预览上限独立展示；源码预览只在收起态提示剩余行数。
- ToolCard 统一追加详情行，展开状态仍由当前卡片保存；多文件编辑和 context 使用相同详情组件。全屏标题和详情行均支持左键切换，正文点击不切换；Ctrl+O 继续切换全部保留的工具/context。
- 页脚位置由各卡片的构建分支决定：有正文、结果、diff 或可展开参数时追加详情行，多文件编辑使用自身末行；不再用工具名清单推断。工具无可展示内容时不增加入口；尚无结果或预览的运行中工具保留简短展示。错误、停止原因和所有计算/预览预算保持既有语义。
- Shell 展开后展示完整命令；运行中已展示预览的卡片（shell、write、PTC）在完成后保留同一详情行，避免只因新增入口重绘主屏历史。其余运行中卡片在拿到结果前不增加入口。
- 使用现有 composer 间隔行承载全屏跳转组件，保持一行高度；离开末尾时居中展示 `↓ Back to bottom · esc`，按钮左右各一格留白，复用 accent 前景色和 dialogBand 中性背景，背景仅覆盖按钮。plain 主题保留纯文本，窄屏裁剪不溢出。
- 点击按钮、Esc 或 Ctrl+End 恢复跟随。全屏浏览历史且 editor 聚焦时，Esc 优先返回末尾并保留草稿与运行状态；已经在末尾时沿用清空草稿/取消 turn 的既有逻辑，overlay 保留自身的 Esc 行为。主屏继续使用原生 scrollback。
- 只使用 pi-tui 公开组件及滚动 API，不修改依赖、不读取其私有布局字段。

## 影响范围与约束

- UI：tool-card、tool-output、write-card、code-execution-card、edit-card、edit-group、context-message、scroll-indicator 与 app 装配。
- 更新 README 和相关探针的旧文案断言；Host 事件、原始输出、审批、工具执行和导出不变。
- 保留组件身份、流式更新与主题切换后的展开状态；窄终端不得溢出。避免主屏自动更新清除原生历史。

## 验证与验收

- 定向回归覆盖所有卡片、短/长输出、错误和运行状态、快捷键、详情行鼠标命中、context 空正文、主题和窄宽度。
- 使用实际 TuiAltScreen 验证按钮居中、固定位置、背景局限于按钮、点击恢复跟随、点击空白不跳转、滚动和 resize；keymap 验证 Esc 优先级与 Kitty key release；真实 Host 验证 Esc 返回末尾后草稿仍保留。
- 运行 pnpm check，以及真实 Host 的 transcript-presentation 与相关 fake-TTY 探针；记录实际结果及任何环境限制。
- 所有可展开卡片只有一处 Show details/Hide details；不再出现旧的 to expand/to collapse，超出硬上限仍明确标记 preview limit。

## 验证结果（2026-11-11）

- `pnpm check` 通过：114 个测试文件、1712 个测试，类型检查与构建通过。
- 定向回归覆盖已完成卡片（plain/dark/light × 工具/源码/diff/PTC/context）、运行中卡片、错误与停止状态、详情行鼠标命中与 1/8/24/100 列的窄宽度；运行中/失败状态的页脚用例为 4 个。
- `node scripts/fake-tty-transcript-presentation.mjs`：6 组 PASS（页脚与省略标记修正前记录），覆盖主屏/全屏、允许/拒绝、PTC compact/detailed；验证统一详情文案、展开后收起、居中按钮的前景与背景、坐标点击返回末尾、Esc 返回末尾保留草稿、再次 Esc 清空草稿。源码展开的断言改为只依赖展开后的末行可见，不再依赖展开态的计数提示。
- `node scripts/fake-tty-statusline.mjs`：4 组 PASS（页脚与省略标记修正前记录），覆盖主屏/全屏、160 列 dark / 60 列 light；context 展开/收起、状态与输入布局通过。断言已收紧为 context 标题下一行的详情页脚，避免其他卡片掩盖回归。
- 本机沙箱内真实 Host 探针的内层 bash 工具报 `sandbox mode "workspace-write" ... no sandbox backend is usable`（`sandbox-exec: sandbox_apply: Operation not permitted`），因此上述探针改动未在本机复跑；此前探针经授权在沙箱外运行通过，未使用外部模型服务。
