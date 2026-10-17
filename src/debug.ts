/** Opt-in stderr tracing for boot and Client-tree diagnostics. */
export function debug(message: string): void {
  if (process.env.DSH_NATIVE_TUI_DEBUG === '1') {
    process.stderr.write('[native-tui] ' + message + String.fromCharCode(10))
  }
}
