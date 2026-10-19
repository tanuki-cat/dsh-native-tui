/**
 * Real-Host check for the reasoning subcommand completion.
 *
 * Verifies that `/reasoning` lists `/reasoning map`, selecting it opens the
 * map editor, and bare `/reasoning` + Enter still opens the effort selector
 * (the `keepExactSubmit` path).
 *
 * Setup:
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-reasoning-map-probe-home
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-reasoning-map-probe-home node scripts/fake-tty-reasoning-autocomplete.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-reasoning-map-probe-home'
if (!existsSync(home + '/profiles/tui')) {
  console.error('Install a TUI profile at ' + home + ' first (or copy the reasoning probe home).')
  process.exit(2)
}

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let phase = 'start'
let suggestionSeen = false
let mapOpened = false
let selectorOpened = false
let typedMapOpened = false
let spaceMapOpened = false
let mapTitleBaseline = 0
const countMapTitles = text => (text.match(/Reasoning map · mock\/mock-model/g) ?? []).length
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 'start' && text.includes('enter send')) {
    phase = 'model'
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
    phase = 'suggest'
    try { child.stdin.write('/reasoning') } catch {}
  }
  else if (phase === 'suggest' && text.includes('/reasoning map')) {
    suggestionSeen = true
    phase = 'open-map'
    setTimeout(() => { try { child.stdin.write('\x1b[B\r') } catch {} }, 200)
  }
  else if (phase === 'open-map' && text.includes('Reasoning map · mock/mock-model')) {
    mapOpened = true
    mapTitleBaseline = countMapTitles(text)
    phase = 'close-map'
    setTimeout(() => { try { child.stdin.write('\x1b') } catch {} }, 300)
  }
  else if (phase === 'close-map') {
    phase = 'bare'
    setTimeout(() => { try { child.stdin.write('/reasoning\r') } catch {} }, 400)
  }
  else if (phase === 'bare' && text.includes('Reasoning effort (current:')) {
    selectorOpened = true
    phase = 'close-selector'
    setTimeout(() => { try { child.stdin.write('\x1b') } catch {} }, 200)
  }
  else if (phase === 'close-selector') {
    phase = 'typed-map'
    setTimeout(() => { try { child.stdin.write('/reasoning map') } catch {} }, 400)
  }
  else if (phase === 'typed-map') {
    phase = 'typed-enter'
    setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 500)
  }
  else if (phase === 'typed-enter' && countMapTitles(text) > mapTitleBaseline) {
    typedMapOpened = true
    mapTitleBaseline = countMapTitles(text)
    phase = 'close-typed'
    setTimeout(() => { try { child.stdin.write('\x1b') } catch {} }, 200)
  }
  else if (phase === 'close-typed') {
    phase = 'space-map'
    setTimeout(() => { try { child.stdin.write('/reasoning ') } catch {} }, 400)
  }
  else if (phase === 'space-map') {
    phase = 'space-enter'
    setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 500)
  }
  else if (phase === 'space-enter' && countMapTitles(text) > mapTitleBaseline) {
    spaceMapOpened = true
    phase = 'done'
    setTimeout(() => { try { child.stdin.write('\x1b') } catch {} }, 200)
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 600)
  }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const pass = suggestionSeen && mapOpened && selectorOpened && typedMapOpened && spaceMapOpened
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('suggestionSeen', suggestionSeen, 'mapOpened', mapOpened, 'selectorOpened', selectorOpened, 'typedMapOpened', typedMapOpened, 'spaceMapOpened', spaceMapOpened)
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-12000))
    console.log('--- stderr tail ---')
    console.log(err.slice(-3000))
  }
  process.exit(pass ? 0 : 1)
})
