import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const home = '/tmp/dsh-native-tui-input-home'
writeFileSync(home + '/profiles/tui/cordis.patch.yml', `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: http://127.0.0.1:1/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 128000
            maxTokens: 4096
            input:
              - text
            reasoningEfforts:
              low: low
              medium: medium
              high: high
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`)

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy-key', COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
let mark = 0
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g
const fresh = () => out.slice(mark).replace(ansi, '')
const go = (next) => { phase = next; mark = out.length }
const tick = setInterval(() => {
  const text = fresh()
  if (phase === 0 && text.includes('enter send')) { go(1); try { child.stdin.write('/provider input mock/mock-model\r') } catch {} }
  else if (phase === 1 && text.includes('Input types · mock/mock-model')) { go(2); try { child.stdin.write('\x1b[B\r') } catch {} }
  else if (phase === 2 && text.includes('Saved input types for mock/mock-model: text + image')) { go(3); try { child.stdin.write('/provider edit mock\r') } catch {} }
  else if (phase === 3 && text.includes('Provider mock')) { go(4); try { child.stdin.write('\x1b[B\r') } catch {} }
  else if (phase === 4 && text.includes('Model input types · mock')) { go(5); try { child.stdin.write('\r') } catch {} }
  else if (phase === 5 && text.includes('Input types · mock/mock-model')) { go(6); try { child.stdin.write('\r') } catch {} }
  else if (phase === 6 && text.includes('Saved input types for mock/mock-model: text only')) { go(7); try { child.stdin.write('/provider input mock/mock-model\r') } catch {} }
  else if (phase === 7 && text.includes('current: text only')) { go(8); try { child.stdin.write('\x1b[B\x1b[B\r') } catch {} }
  else if (phase === 8 && text.includes('Saved input types for mock/mock-model: not declared (inherits route default)')) {
    go(9)
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 600)
  }
}, 300)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard)
  const clean = out.replace(ansi, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-30000))
  console.log('--- STDERR ---')
  console.log(err.slice(-8000))
  process.exit(0)
})
