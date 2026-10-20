import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Real-Host regression for the guided settings page and the inline Host editor.
// The profile is an isolated copy under /tmp so this probe never writes the
// developer's own DSH_HOME. Prepare it once from an installed tui profile:
//   cp -R ~/.dsh/profiles/tui /tmp/dsh-settings-probe/profiles/tui
//   cp -R dist cordis.patch.yml presets package.json \
//     /tmp/dsh-settings-probe/profiles/tui/node_modules/dsh-native-tui/

const home = '/tmp/dsh-settings-probe'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    COLUMNS: '140',
    LINES: '48',
    FAKE_TTY_COLUMNS: '140',
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
let ticks = 0
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    write('/settings\r')
  }
  else if (phase === 1 && text.includes('TUI settings')) {
    phase = 2
    write('\r')
  }
  else if (phase === 2 && text.includes('Thinking display') && text.includes('Use default')) {
    phase = 3
    // Escape sequences must arrive as separate input events; a concatenated
    // chunk is read as one unknown key by the terminal layer.
    setTimeout(() => write('\x1b[A'), 250)
    setTimeout(() => write('\r'), 550)
  }
  else if (phase === 3 && text.includes('1 pending change')) {
    phase = 4
    write('save')
  }
  else if (phase === 4 && text.includes('Save and apply') && text.includes('1 pending change')) {
    phase = 5
    write('\r')
  }
  else if (phase === 5 && text.includes('Save TUI settings')) {
    phase = 6
    write('\r')
  }
  else if (phase === 6 && text.includes('Saved TUI settings')) {
    phase = 8
    write('/settings host\r')
  }
  else if (phase === 8 && text.includes('Host settings · namespaces')) {
    phase = 9
    write('native-tui')
  }
  else if (phase === 9) {
    ticks += 1
    if (ticks === 2) write('\r')
    if (text.includes('Settings · native-tui')) {
      phase = 10
      write('\x1b')
    }
  }
  else if (phase === 10 && text.includes('Host settings · namespaces')) {
    phase = 11
    write('\x1b')
  }
  else if (phase === 11) {
    setTimeout(() => write('\x04'), 800)
    phase = 12
  }
}, 350)

const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 70000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = strip(out)
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('GUIDED_PAGE', clean.includes('TUI settings'))
  console.log('HOST_PAGE', clean.includes('Host settings · namespaces'))
  console.log('HOST_FIELDS', clean.includes('Settings · native-tui'))
  console.log('SAVED_NOTICE', clean.includes('Saved TUI settings'))
  try {
    const patch = readFileSync(home + '/profiles/tui/cordis.patch.yml', 'utf8')
    const match = patch.match(/^\s*thinkingDisplay:\s*(\S+)/m)
    console.log('PATCH_THINKING', match?.[1] ?? 'missing')
  }
  catch (error) {
    console.log('PATCH_READ_ERROR', String(error))
  }
  console.log('--- TAIL ---')
  console.log(clean.slice(-8000))
  console.log('--- STDERR ---')
  console.log(err.slice(-3000))
  process.exit(0)
})
