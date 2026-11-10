Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdin, 'isRaw', { value: false, writable: true, configurable: true })
process.stdin.setRawMode = () => process.stdin
process.stdout.columns = Number(process.env.FAKE_TTY_COLUMNS ?? 100)
process.stdout.rows = Number(process.env.FAKE_TTY_ROWS ?? 30)
const { pathToFileURL } = await import('node:url')
const entry = process.env.DSH_CLI_ENTRY ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const { runCli } = await import(pathToFileURL(entry).href)
await runCli()
