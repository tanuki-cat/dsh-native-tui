import { spawn } from 'node:child_process'

// Real-Host regression for the spacious layout: inset transcript, three-line
// header, split status block, and the prompt footer.
// Prepare the isolated profile once:
//   cp -R ~/.dsh/profiles/tui /tmp/dsh-layout-probe/profiles/tui
//   cp -R dist cordis.patch.yml presets package.json \
//     /tmp/dsh-layout-probe/profiles/tui/node_modules/dsh-native-tui/

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: '/tmp/dsh-layout-probe',
    COLUMNS: '110',
    LINES: '36',
    FAKE_TTY_COLUMNS: '110',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\]8;;/g, '')
const write = text => { try { child.stdin.write(text) } catch {} }
let phase = 0
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    write('/help\r')
  }
  else if (phase === 1 && text.includes('Local commands')) {
    phase = 2
    setTimeout(() => write('\x04'), 800)
  }
}, 300)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = strip(out)
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('HEADER_TITLE', clean.includes('◆ DeepSeek Harness'))
  console.log('HEADER_FLUSH', /^native-tui-/m.test(clean))
  console.log('STATUS_FLUSH', /^● idle/m.test(clean))
  console.log('STATUS_MODEL', /● idle\s{3}model \S+/.test(clean))
  console.log('STATUS_THINK', /think (?:default|[a-z]+)/.test(clean))
  console.log('TRANSCRIPT_FLUSH', /^i Local commands:/m.test(clean))
  console.log('FOOTER_USAGE', /^↳ \d+ turns/m.test(clean))
  console.log('FOOTER_CONTEXT', /^ {2}ctx /m.test(clean))
  console.log('RULE_FULL_BLEED', /^─{10}/m.test(clean))
  console.log('--- TAIL ---')
  console.log(clean.slice(-5000))
  console.log('--- STDERR ---')
  console.log(err.slice(-2000))
  process.exit(0)
})
