import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Real-Host check that the text field staged by the guided page applies the
// header title immediately after save, and lands in the profile patch.
// Uses the same isolated /tmp/dsh-settings-probe profile as the guided probe.

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
let saveOutput = ''
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    write('/settings\r')
  }
  else if (phase === 1 && text.includes('TUI settings')) {
    phase = 2
    write('header')
  }
  else if (phase === 2 && text.includes('Header title') && text.includes('(1/')) {
    phase = 3
    write('\r')
  }
  else if (phase === 3 && text.includes('Header title') && text.includes('DeepSeek Harness')) {
    phase = 4
    setTimeout(() => write('\x15'), 200)
    setTimeout(() => write('Probe Title'), 400)
    setTimeout(() => write('\r'), 700)
  }
  else if (phase === 4 && text.includes('1 pending change')) {
    phase = 5
    // Clear the active search filter, then search for the save row.
    for (let index = 0; index < 6; index += 1) {
      setTimeout(() => write('\x7f'), 200 + index * 100)
    }
    setTimeout(() => write('save'), 1000)
    setTimeout(() => write('\r'), 1500)
  }
  else if (phase === 5 && text.includes('Save TUI settings')) {
    phase = 6
    write('\r')
  }
  else if (phase === 6 && text.includes('Save TUI settings')) {
    phase = 7
    write('\r')
  }
  else if (phase === 7 && text.includes('Saved TUI settings')) {
    phase = 9
    saveOutput = text.slice(Math.max(0, text.indexOf('Saved TUI settings') - 2000))
    setTimeout(() => write('\x04'), 800)
    phase = 10
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 60000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = strip(out)
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('SAVED_NOTICE', clean.includes('Saved TUI settings: title (live)'))
  console.log('HEADER_LIVE', saveOutput.includes('Probe Title'))
  try {
    const patch = readFileSync(home + '/profiles/tui/cordis.patch.yml', 'utf8')
    const match = patch.match(/^\s*title:\s*(.+)$/m)
    console.log('PATCH_TITLE', JSON.stringify(match?.[1] ?? 'missing'))
  }
  catch (error) {
    console.log('PATCH_READ_ERROR', String(error))
  }
  console.log('--- SAVE WINDOW ---')
  console.log(saveOutput.slice(-2500))
  console.log('--- TAIL ---')
  console.log(clean.slice(-6000))
  console.log('--- STDERR ---')
  console.log(err.slice(-2000))
  process.exit(0)
})
