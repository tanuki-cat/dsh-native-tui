Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdin, 'isRaw', { value: false, writable: true, configurable: true })
process.stdin.setRawMode = () => process.stdin
process.stdout.columns = 100
process.stdout.rows = 30
const { runCli } = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
await runCli()
