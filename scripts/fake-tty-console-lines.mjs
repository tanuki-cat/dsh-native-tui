import { spawn } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// A Host plugin's console line must not land raw inside the painted frame: it
// would overwrite the prompt or the status row (and stay there, because the next
// differential repaint treats those rows as unchanged). The TUI captures
// `console` for as long as it owns the screen: routine info goes to the opt-in
// debug trace, warnings become transcript notices.
const here = dirname(fileURLToPath(import.meta.url))
const home = '/tmp/dsh-native-tui-console-home'
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root\n[]\n')
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + '\n')
writeFileSync(home + '/profiles/tui/cordis.patch.yml', `- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: standard
`)
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

const inject = pathToFileURL(join(here, 'fake-tty-console-inject.mjs')).href
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    COLUMNS: '120',
    LINES: '36',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DSH_NATIVE_TUI_DEBUG: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import ' + inject].filter(Boolean).join(' '),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const timers = []
timers.push(setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 5500))
timers.push(setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 12000))
child.on('exit', (code, signal) => {
  for (const timer of timers) clearTimeout(timer)
  // Routine info never reaches the screen at all; the warning reaches it only as
  // a painted notice row. A raw plugin write would put either text into a row it
  // does not own, which is exactly the reported "prompt filled with a log line".
  const infoOnScreen = out.includes('model listing from')
  const noticeSeen = out.includes('! [llm-deepseek-account] probe warning line')
  const rawWarnWrite = /(^|[\r\n])\[llm-deepseek-account\] probe warning line/.test(out)
  const promptFilled = /(^|[\r\n])>[^\r\n]*\[llm-deepseek-account\]/.test(out)
  const traced = err.includes('[native-tui] console.info: [llm-deepseek-account] model listing')
  const pass = !infoOnScreen && noticeSeen && !rawWarnWrite && !promptFilled && traced && out.includes('enter send')
  console.log('EXIT', code, signal)
  console.log('INFO_ON_SCREEN', infoOnScreen)
  console.log('WARNING_AS_NOTICE', noticeSeen)
  console.log('RAW_WARNING_WRITE', rawWarnWrite)
  console.log('PROMPT_FILLED', promptFilled)
  console.log('INFO_TRACED', traced)
  console.log('PASS', pass)
  console.log('--- TAIL ---')
  console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-1800))
  console.log('--- STDERR ---')
  console.log(err.slice(-900))
  process.exit(pass ? 0 : 1)
})
