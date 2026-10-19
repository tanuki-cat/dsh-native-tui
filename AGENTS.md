# Repository Guidelines

`dsh-native-tui` is a DeepSeek Harness plugin: a host-native terminal front door built on `@earendil-works/pi-tui`. Host services come from `dsh-base`; this package owns the terminal UI and its bundle patch. Requires Node `^22.19 || >=24` and pnpm (`pnpm-lock.yaml`); do not use npm or yarn.

## Project Structure & Module Organization

- `src/index.ts` — Cordis entry, TTY guard, plugin wiring; `src/config.ts` — schemastery config.
- `src/mcp-manager.ts` — MCP server reconcile plugin (`dsh-native-tui/mcp-manager`).
- `src/runtime/` — host-facing helpers: `agent.ts`, `providers.ts`, `settings.ts`, `bundle.ts`, `export.ts`, `session-list.ts`.
- `src/ui/` — terminal UI: `app.ts` (wiring: terminal, session, transcript), `status-line.ts`, `session-events.ts`, `dialogs.ts`, `transcript.ts`, `autocomplete.ts`, `theme.ts`.
- `src/ui/commands/` — one module per command family (`provider.ts`, `settings.ts`, `mcp.ts`, `plugins.ts`, …), all driven through the injected `CommandContext` in `context.ts` by the dispatcher in `router.ts`; Host service shapes live in `services.ts`.
- `tests/` — Vitest specs, one `<module>.spec.ts` per unit.
- `scripts/` — fake-TTY and E2E probes (`fake-tty-*.mjs`, `*-e2e.mjs`); `presets/` + `cordis.patch.yml` — bundle and preset layers.
- `docs/` — `design-task-<type>-<topic>.md` designs and `progress-dsh-native-tui.md`.

## Build, Test, and Development Commands

- `pnpm check` — the gate: typecheck + tests + build.
- `pnpm typecheck` — `tsc -p tsconfig.json --noEmit`; `pnpm test` — Vitest; `pnpm test:watch` while iterating.
- `pnpm build` — `tsc -p tsconfig.build.json` into `dist/` (gitignored).
- Run a real profile: `pnpm pack --pack-destination .tmp`, `dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz`, then `dsh --profile tui`.
- `node scripts/fake-tty-approval.mjs` exercises a real Host; see README for per-probe setup.

## Coding Style & Naming Conventions

TypeScript ESM (NodeNext): relative imports end in `.js`, type-only imports use `type`. Two-space indent, single quotes, no semicolons (legacy exception: `src/ui/app.ts`). `strict` and `noUncheckedIndexedAccess` are enabled. Files are `kebab-case.ts`; types `PascalCase`; functions and variables `camelCase`. No linter or formatter is configured — match the surrounding file and keep diffs minimal.

**A source file must not exceed 1000 lines.** When a file grows past that, split it by responsibility rather than adding another branch to it: the command handlers live in `src/ui/commands/`, the host-facing helpers in `src/runtime/`. A split moves code and injects its collaborators; it does not change behavior.

## Testing Guidelines

Vitest with `environment: 'node'`, specs at `tests/<module>.spec.ts`. Command handlers under `src/ui/commands/` and the dispatcher are testable directly against a stub `CommandContext` (see `tests/commands.spec.ts`, `tests/router.spec.ts`); the terminal wiring in `app.ts` is covered by the fake-TTY probes instead. Add focused unit tests for behavior changes and keep `pnpm check` green (currently 33 files / 275 tests). For Host or TUI integration, add or run a `scripts/fake-tty-*.mjs` probe and report its real output.

## Commit & Pull Request Guidelines

Use Conventional Commits with Chinese subjects, matching history: `feat: 内置 provider 目录对齐 Web 端（catalog 选择器与原生环境认证）`, `fix:`, `docs:`, `chore:`. Keep commits scoped; never commit `dist/`, `*.tgz`, or generated profile files. PRs should state the change, list the commands actually run (`pnpm check`, probe names), and attach terminal evidence for user-visible behavior. Never commit API keys: reference credentials by environment name or the DSH credential store.
