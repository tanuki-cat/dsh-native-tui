# /reload 概率性新建 Session 的修复

> 任务类型：fix ｜ 目标仓库：`dsh-native-tui` ｜ 状态：已实施（2026-10-30）
> 现象：TUI 内执行 `/reload` 后，偶发进入一个空白 Session，原会话停在上一条记录

## 1. 结论

`/reload` 只在 **argv** 上携带要恢复的会话（`--resume <id>`）。这个 flag 只要在两次进程镜像之间丢失一次，新进程就会因为 `sessionId === undefined` **静默新建会话**。修复把会话 id 改成 argv + 环境变量**双载体**，并加一条启动不变量：Host 打开的会话与请求不一致时拒绝启动，而不是让人以为会话是新的。

## 2. 证据

会话库 `~/.dsh/sessions/--Users-wangzy-WorkSpace-WebStormProjects-dsh-native-tui--/` 里存在零轮次会话，例如：

| 会话 | 创建时间 | 事件数 | 大小 |
|---|---|---|---|
| `native-tui-4daba521-…` | 2026-10-30 10:50:33 | 5 | 425 B |
| `native-tui-7dfcd255-…` | 2026-10-29 08:49:06 | 4 | 345 B |
| `native-tui-1b57e145-…` / `9495bef2-…` | 2026-10-23 12:25:51 / 12:26:32 | 4 / 4 | 0 KB |

它们与相邻长会话并存，形态是「reload 之后另起一个空会话」。

宿主侧的对照实验：`--resume <不存在的 id>` 不会静默回退，而是抛 `SessionPersistenceNotFoundError` 并让插件条目不激活。因此「出现新会话」只能来自 `createHostSession`，也就是**恢复请求没有到达应用**。

## 3. 复现

用包装入口在启动前丢弃 `--resume`（模拟 launcher 改写或合并参数的场景）：

```
reload 前会话：native-tui-dfa898d6-…
reload 后会话：native-tui-ad2d30e4-…      ← 新建，原会话不再写入
```

同一入口保留 `--resume` 时，reload 正常恢复同一会话。`fullscreen: true`（真实 profile 的配置）下结论相同。

## 4. 修复

| 文件 | 变更 |
|---|---|
| `src/runtime/reload.ts` | 新增 `RESUME_ENV`(`DSH_NATIVE_TUI_RESUME`)、`resumeIdFromEnv`（按 id 形状校验，不可信值忽略）、`assertResumed` |
| `src/ui/app.ts` | `replaceProcess(args, sessionId)` 在 execve/spawn 的 env 中写入会话 id；启动后校验 Host 打开的会话与请求一致，不一致先 dispose 再报错 |
| `src/index.ts` | 恢复 id 取 `--resume` → 环境变量；读到环境变量后立即从 `process.env` 删除，避免被会话内启动的 dsh/shell 继承；`DSH_NATIVE_TUI_DEBUG=1` 输出 `resume: <id> (flag|env)` |
| `tests/reload.spec.ts` | `resumeIdFromEnv` 的接受/拒绝用例、`assertResumed` 用例 |
| `scripts/fake-tty-reload.mjs` | 旧断言的状态行正则匹配不到（探针长期 `pass false`），改为校验 reload 之后那一帧的模型与 `Session:` 行；现在 `pass true` |

为什么修在这里：reload 的两个载体由同一处代码写入（`replaceProcess` 的 `env` 对象），所以 flag 丢失不再致命；而只要有任何一条恢复请求到达，`assertResumed` 就会把「恢复到了别的会话」变成可见错误。

## 5. 验证

| 命令/探针 | 结果 |
|---|---|
| `pnpm check` | 88 个测试文件 / 1197 例通过，构建成功 |
| `node scripts/fake-tty-reload.mjs` | `pass true`，`Session:` 与 reload 前一致 |
| 丢弃 flag 的包装探针（修复前） | 新建会话，复现现象 |
| 丢弃 flag 的包装探针（修复后） | 同一会话，`created` 只有一个 |
| fullscreen 配置下的 reload | 同一会话 |

## 6. 未确认与边界

- **真实环境里 flag 在哪一步丢失尚未定位**：宿主 `bin.js`、`dsh-cmdline` 都没有改写 `process.argv`，探针 profile 也未复现。双载体使这一点不再影响结果，但根因本身仍是开放问题。复现时开 `DSH_NATIVE_TUI_DEBUG=1`，看 `resume:` 行是 `(flag)` 还是 `(env)` 即可定位。
- 若将来宿主同时丢弃 argv 与环境变量（或清洗 env），仍会新建会话；此时没有请求，`assertResumed` 也无从判断。
- 环境变量名 `DSH_NATIVE_TUI_RESUME` 不属于用户接口：手动设置时只在形状合法时生效，且读取后即删除。
