# 等待时长按需显示时分秒

## 目标与范围

按用户提供的 Codex CLI 截图，waiting 行使用按需进位的单位格式：不足一分钟显示 `5s`，满一分钟显示 `1m 5s`，满一小时显示 `1h 2m 3s`。不显示前导零单位，也不为各单位补零；进入更高单位后保留下级单位，例如 `1m 0s`、`1h 0m 0s`。超过 24 小时继续累计小时。

工作中和自动重试共用格式，例如 `⟳ working · 3m 33s`、`⟳ retry 2/5 after TRANSPORT (automatic) · 1h 2m 3s`。

## 实现与约束

- 在 `src/ui/waiting.ts` 的 `waitingText` 中，根据累计秒数决定是否显示小时与分钟。
- 保留当前秒数四舍五入、负时长归零、turn 计时起点、每秒刷新及结束时清空的行为。
- 保留 `WaitStatusLine` 的固定一行、窄屏截断和相同标签去重。
- 更新 README、布局和 transcript 测试中的时间样例，以及恢复流探针对等待时长的匹配。
- 保留原有 ACP 草稿和 `.DS_Store`，不涉及其他时间戳、工具超时或 provider 重试逻辑。

## 验证

- 测试零值、秒/分/时按需显示、分钟/小时进位、舍入边界、超过 24/100 小时和时钟回拨。
- 对 working/retry 分别验证格式；验证不同长度的时间仍为单行、空闲清空与同值去重。
- 运行相关 Vitest 与 `pnpm check`。
- 运行真实 Host + 本机 mock 的 `scripts/fake-tty-stream-recovery.mjs`，检查等待、自动重试与恢复。

## 验证结果（2026-11-09）

- waiting、main-screen 布局与 transcript 渲染的 80 项定向测试通过，包含截图中的 `3m 33s` 和小时进位。
- `pnpm check` 通过：98 个测试文件 / 1397 项测试，类型检查与构建成功。
- `node scripts/fake-tty-stream-recovery.mjs` 通过：`firstFrameComplete=true`、`workingDuringStall=true`、`retrySeen=true`、`requests=2`、`recovered=true`。探针在真实 Host + 本机 mock 中验证按需显示的工作/重试时长与恢复，使用沙箱外的本机端口权限。
- 脚本语法检查与 `git diff --check` 通过。
