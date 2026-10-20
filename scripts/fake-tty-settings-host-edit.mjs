import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Real-Host check for the inline namespace editor: nested array item edit, the
// immediate path-addressed write, and no restatement of the surrounding array.
// Uses the same isolated /tmp/dsh-settings-probe profile as the guided probe.

const home = '/tmp/dsh-settings-probe'
const patchPath = home + '/profiles/tui/cordis.patch.yml'
const before = readFileSync(patchPath, 'utf8')
const beforeIds = (before.match(/^\s*- id:/gm) ?? []).length
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    COLUMNS: '150',
    LINES: '52',
    FAKE_TTY_COLUMNS: '150',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DSH_NATIVE_TUI_DEBUG: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const write = text => { try { child.stdin.write(text) } catch {} }
let phase = 0
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    write('/settings host\r')
  }
  else if (phase === 1 && text.includes('Host settings · namespaces')) {
    phase = 2
    write('llm-pi-ai')
  }
  else if (phase === 2 && text.includes('llm-pi-ai')) {
    phase = 3
    write('\r')
  }
  else if (phase === 3 && text.includes('Settings · llm-pi-ai')) {
    phase = 4
    write('models[0].name')
  }
  else if (phase === 4 && text.includes('models[0].name')) {
    phase = 5
    setTimeout(() => write('\r'), 300)
  }
  else if (phase === 5 && text.includes('Host settings · providers.command-code.models[0].name')) {
    phase = 6
    setTimeout(() => write('\r'), 250)
  }
  else if (phase === 6 && text.includes('Set llm-pi-ai.providers.command-code.models[0].name')) {
    phase = 7
    setTimeout(() => write('\x15'), 250)
    setTimeout(() => write('Probe Model'), 500)
    setTimeout(() => write('\r'), 850)
  }
  // A 150-column frame draws the 88-column overlay over the middle of the
  // transcript, so only the notice's left prefix is visible while it is open.
  else if (phase === 7 && text.includes('Updated llm-pi-ai')) {
    phase = 8
    setTimeout(() => write('\x1b'), 500)
    setTimeout(() => write('\x1b'), 1000)
    setTimeout(() => write('\x04'), 1600)
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 70000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = strip(out)
  const after = readFileSync(patchPath, 'utf8')
  const afterIds = (after.match(/^\s*- id:/gm) ?? []).length
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('NAMESPACE_PAGE', clean.includes('Settings · llm-pi-ai'))
  console.log('FIELD_ACTION', clean.includes('Host settings · providers.command-code.models[0].name'))
  console.log('UPDATED_NOTICE', clean.includes('Updated llm-pi-ai'))
  console.log('PATCH_HAS_NAME', /^\s*name: Probe Model$/m.test(after))
  console.log('ARRAY_ID_COUNT', beforeIds, '->', afterIds)
  console.log('--- TAIL ---')
  console.log(clean.slice(-7000))
  console.log('--- STDERR ---')
  console.log(err.slice(-2000))
  process.exit(0)
})
