/**
 * Real-Host check that the terminal offers the same manual skill invocation as
 * the Web editor:
 *
 *   1. typing "/" lists user-invocable skills from ctx.skills
 *   2. submitting /skill-name is a prompt, not an unknown command
 *   3. dsh-tool-skill reads the /name gesture and injects the skill body
 *
 * The check writes its own fixture skill under $DSH_HOME/skills, so it only
 * needs this repo's build installed in the target home:
 *   pnpm pack --pack-destination .tmp
 *   DSH_HOME=/tmp/dsh-native-tui-skill-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
 *
 * Run with:
 *   DSH_HOME=/tmp/dsh-native-tui-skill-home node scripts/fake-tty-skill.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-skill-home'
const skillDir = join(home, 'skills', 'smoke-skill')
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), [
  '---',
  'name: smoke-skill',
  'description: TUI slash-menu smoke skill.',
  '---',
  '',
  'SMOKE_SKILL_BODY',
  '',
].join('\n'))

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })

const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let typed = false
let applied = false
const tick = setInterval(() => {
  const text = strip(out)
  if (!typed && text.includes('enter send')) {
    typed = true
    try { child.stdin.write('/smoke') } catch {}
  }
  else if (typed && !applied && text.includes('smoke-skill')) {
    applied = true
    // First Enter applies the menu item, the second submits the prompt.
    try { child.stdin.write('\r') } catch {}
    setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 600)
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 6000)
  }
}, 300)

const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 25000)
child.on('exit', (code) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const checks = [
    ['slash menu lists the skill', text.includes('smoke-skill')],
    ['/skill-name is not an unknown command', !text.includes('Unknown command')],
    ['host injected the skill body', text.includes('SMOKE_SKILL_BODY')],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + ' ' + label)
  console.log('EXIT ' + String(code) + ' typed=' + String(typed) + ' applied=' + String(applied))
  if (failed.length > 0) {
    console.log(text.slice(-5000))
    console.log('--- STDERR ---')
    console.log(err.slice(-2000))
  }
  console.log(failed.length === 0 ? 'OK manual skill invocation verified' : 'FAILED ' + String(failed.length) + ' check(s)')
  process.exit(failed.length === 0 ? 0 : 1)
})
