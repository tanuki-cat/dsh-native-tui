/**
 * Guided reasoning-map editor against a real Host and a real TUI.
 *
 * Build first, then copy the disposable profile used by
 * `scripts/fake-tty-reasoning.mjs` (or install the packed tgz):
 *
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-reasoning-map-home
 *   DSH_HOME=/tmp/dsh-native-tui-reasoning-map-home node scripts/fake-tty-reasoning-map.mjs
 *
 * The probe rewrites the profile patch to a known mock model, changes
 * `high` to wire `xhigh` through the wizard, and asserts the persisted YAML.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-reasoning-map-home'
if (!home.startsWith('/tmp/dsh-native-tui-')) {
  console.error('Refusing to rewrite a profile outside a disposable /tmp/dsh-native-tui-* home: ' + home)
  process.exit(2)
}
const patchPath = home + '/profiles/tui/cordis.patch.yml'
if (!existsSync(home + '/profiles/tui')) {
  console.error('Missing installed TUI profile at ' + home + '/profiles/tui')
  console.error('  cp -a /tmp/dsh-native-tui-reasoning-home ' + home)
  process.exit(2)
}

const baseline = `- id: llm-pi-ai
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
            reasoningEfforts:
              low: low
              medium: medium
              high: high
`
writeFileSync(patchPath, baseline)

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })

const down = '\x1b[B'
let phase = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 1 && text.includes('Model selected: mock/mock-model')) {
    phase = 2
    try { child.stdin.write('/reasoning map\r') } catch {}
  }
  else if (phase === 2 && text.includes('Reasoning map') && text.includes('Add or update a level')) {
    phase = 3
    try { child.stdin.write('\r') } catch {}
  }
  else if (phase === 3 && text.includes('Level ·')) {
    phase = 4
    try { child.stdin.write(down + down + down + down + '\r') } catch {}
  }
  else if (phase === 4 && text.includes('Wire value')) {
    phase = 5
    try { child.stdin.write('\x7f\x7f\x7f\x7fxhigh\r') } catch {}
    setTimeout(() => {
      try { child.stdin.write(down + down + down + '\r') } catch {}
    }, 700)
  }
  else if (phase === 5 && text.includes('Saved reasoning map for mock/mock-model')) {
    phase = 6
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 700)
  }
}, 350)

const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const persisted = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const saved = clean.includes('Saved reasoning map for mock/mock-model')
    && persisted.includes('high: xhigh')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-20000))
  console.log('--- STDERR ---')
  console.log(err.slice(-5000))
  console.log('--- PERSISTED PATCH ---')
  console.log(persisted)
  console.log('RESULT', saved ? 'PASS' : 'FAIL')
  process.exit(saved ? 0 : 1)
})
