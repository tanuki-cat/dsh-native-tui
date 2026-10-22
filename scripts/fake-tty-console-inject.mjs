/**
 * Console-line injector for `fake-tty-console-lines.mjs`.
 *
 * Loaded into the spawned TUI through `NODE_OPTIONS=--import`, it emits the
 * kind of line a Host plugin writes at runtime (`dsh-llm-deepseek-account`
 * announces every model listing with `console.info`). The probe then asserts
 * the line never reaches the terminal raw, which is what used to overwrite the
 * prompt row.
 */
const delay = Number(process.env.FAKE_TTY_CONSOLE_AT ?? '3000')
setTimeout(() => {
  console.info('[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)')
  console.warn('[llm-deepseek-account] probe warning line')
}, delay).unref()
