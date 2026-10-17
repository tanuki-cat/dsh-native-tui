import { spawn } from 'node:child_process'
const serverPath = new URL('./fake-mcp-stdio.mjs', import.meta.url).pathname
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-mcp-home', COLUMNS: '400', LINES: '60', FAKE_TTY_COLUMNS: '400', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
let replaced = false
let listTicks = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) { phase = 1; try { child.stdin.write('/mcp add\r') } catch {} }
  else if (phase === 1 && text.includes('MCP server name')) { phase = 2; try { child.stdin.write('demo\r') } catch {} }
  else if (phase === 2 && !replaced && text.includes('already exists')) { replaced = true; try { child.stdin.write('\r') } catch {} }
  else if (phase === 2 && text.includes('MCP transport')) { phase = 3; try { child.stdin.write('\r') } catch {} }
  else if (phase === 3 && text.includes('MCP command')) { phase = 4; try { child.stdin.write(process.execPath + '\r') } catch {} }
  else if (phase === 4 && text.includes('MCP arguments')) { phase = 5; try { child.stdin.write(serverPath + '\r') } catch {} }
  else if (phase === 5 && text.includes('MCP environment JSON')) { phase = 6; setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 900) }
  else if (phase === 6 && text.includes('MCP server saved: demo')) { phase = 7 }
  else if (phase === 7) {
    listTicks += 1
    if (listTicks === 1 || listTicks % 4 === 0) { try { child.stdin.write('/mcp list\r') } catch {} }
    if (text.includes('demo  stdio  /') && text.includes('connected')) {
      phase = 8
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 1200)
    }
  }
}, 450)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 60000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-20000))
  console.log('--- STDERR ---')
  console.log(err.slice(-4000))
  process.exit(0)
})
