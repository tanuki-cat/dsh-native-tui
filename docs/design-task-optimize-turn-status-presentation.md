# 统一等待和完成状态的展示

日期：2026-11-10；状态：已实施

## 目标与现状

用户截图中的等待行是 `⟳ working · 2m 22s`，图标偏亮，turn 结束后直接消失。本轮延续 Codex CLI 风格，将等待、自动重试、正常完成与异常结束统一为轻量的状态行。

参考 [Codex CLI 状态行](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/status_indicator_widget.rs) 的 `Working (elapsed · esc to interrupt)` 层次，以及用户此前截图的 `Worked for … · HH:mm`。时间单位继续遵守[既有规则](design-task-format-waiting-duration.md)：按需显示小时/分钟，秒数四舍五入、不补零、回拨归零。

## 实施方案

- 等待采用中性圆点、`Working` 标题、累计时长与 Esc 中断提示；重试明确显示次数、失败码与 automatic，时间不重新计起。不增加高频动画和额外的全屏刷新。
- turn/end 后停止计时刷新，在原固定状态行显示 `Worked for 2m 22s · 10:49`。取消、失败、blocked、token limit 分别使用准确的结束词，不把异常显示为成功。原有错误正文继续留在 transcript。
- 新增小型本地状态对象保存本轮起点、重试与结束回执。回执保持到下一轮开始或切换/关闭会话；不写入 Host 日志，也不为历史会话补造用时。
- `session-events.ts` 把真实 turn/end reason 交给等待状态；只在 turn/end 收尾，收到文本、工具调用、stream/end 不视为完成。异常前没有本地等待起点时不伪造回执。
- 状态行始终占一行，窄屏截断；使用当前终端 Palette，颜色晚到或主题更新时重新着色。保留已有草稿、工具审批、流式顺序和未提交改动，源码文件不超过 1000 行。

## 验证与验收

- 测试秒/分/时与回拨边界、重试累计、完成/取消/失败分支、完成回执稳定性、会话重置、主题变化和窄屏宽度。
- 验证真正的 turn/end 才生成完成回执，错误正文不被覆盖；等待到完成过程中输入框和双行状态位置不变。
- 运行 `pnpm check`，以及真实 Host + 本地 mock 的等待/重试恢复、工具阶段等待和主屏/全屏状态栏探针。同步受标签变化影响的已有探针匹配，并报告实际验证边界。

## 实施与验证记录

- `TurnStatus` 保存本轮起点、自动重试和静态结束回执；`SessionEventsHost.endWait` 接收 Host 的真实 `TurnEndReason`。原应用计时器在结束后停止，切换会话仍清空状态。
- `WaitStatusLine` 在绘制时使用当前 Palette 着色，同值保留组件；等待为中性圆点与标题，重试标题用警示色，完成回执为次级文本。控制序列和换行被清理，始终保持一行。
- `pnpm check` 通过：105 个测试文件 / 1539 项测试，类型检查与构建成功。定向 107 项测试通过，覆盖时间进位、重试累计、完成/异常词、回执稳定、重置、原因原样传递、主题更新及输入区位置。
- `node scripts/fake-tty-statusline.mjs` 四组 PASS：主屏/全屏 × 160 列深色 / 60 列浅色，验证正常 `Worked for`、失败 `Failed after` 和取消 `Cancelled after`，错误正文保留，输入和双行状态位置不变，无列宽溢出。
- `node scripts/fake-tty-stream-recovery.mjs` PASS：`firstFrameComplete=true`、`workingDuringStall=true`、`retrySeen=true`、`requests=2`、`recovered=true`，恢复后有带时长和本地时钟的完成回执。
- `node scripts/fake-tty-wait-tool-phase.mjs` 改为自行创建、清理隔离临时 profile，移除对预先安装 profile 的依赖。实测 `requestAt=2090`、`toolPhaseAt=4742`、`finalAt=7391` ms，等待跨越请求和参数流式阶段，`settled=true`、`completed=true`、`receipt=true`，RESULT PASS。
- 以上六组使用真实 Host 和本地 mock，端口监听经授权在沙箱外运行；未调用外部模型。状态栏、恢复与工具等待脚本语法检查和 `git diff --check` 通过。
