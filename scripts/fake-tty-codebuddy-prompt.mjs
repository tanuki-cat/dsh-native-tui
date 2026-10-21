/**
 * Real-Host check for the guided CodeBuddy system-prompt editor:
 *
 *   1. /codebuddy prompt opens the menu and reports the default source
 *   2. choosing "Add a custom template…" opens the multi-line editor
 *   3. submitting {prompt} saves the volatile config field to the profile patch
 *   4. /codebuddy prompt show reports the custom template
 *   5. /codebuddy prompt reset restores the default, and show reports it again
 *
 * No gateway and no account are needed. The probe resets the disposable
 * profile patch before it starts, so it can run repeatedly.
 *
 * Setup (copy a profile that already has this plugin installed):
 *   pnpm build
 *   pnpm pack --pack-destination .tmp
 *   cp -a /tmp/dsh-native-tui-codebuddy-home /tmp/dsh-native-tui-cb-prompt-home
 *   DSH_HOME=/tmp/dsh-native-tui-cb-prompt-home dsh plugin --profile tui remove dsh-native-tui
 *   DSH_HOME=/tmp/dsh-native-tui-cb-prompt-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-cb-prompt-home node scripts/fake-tty-codebuddy-prompt.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-cb-prompt-home'
if (!home.startsWith('/tmp/dsh-native-tui-')) {
  console.error('Refusing to reset a profile outside a disposable /tmp/dsh-native-tui-* home: ' + home)
  process.exit(2)
}
const profile = join(home, 'profiles', 'tui')
const patch = join(profile, 'cordis.patch.yml')
if (!existsSync(join(profile, 'cordis.yml'))) {
  console.error('Install the tui profile at ' + home + ' first (see the header of this probe).')
  process.exit(2)
}
// Start from the bundle defaults so the menu reports the default source.
writeFileSync(patch, '[]\n')

const child = spawn(process.execPath, [join(repo, 'scripts', 'fake-tty-entry.mjs'), '--profile', 'tui'], {
  cwd: repo,
  env: { ...process.env, DSH_HOME: home, COLUMNS: '120', LINES: '36', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
// A probe write after the child exited must not crash the assertions.
child.stdin.on('error', () => {})
const strip = text => text.replace(/\x1b\][^\x07]*\x07/gu, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '')
const write = text => { if (child.exitCode !== null) return; try { child.stdin.write(text) } catch {} }

let phase = 'start'
let mark = 0
const advance = next => { phase = next; mark = strip(out).length }
const since = () => strip(out).slice(mark)
const seen = {
  completion: false,
  menu: false,
  editor: false,
  saved: false,
  savedKeepsPrompt: false,
  patchHasTemplate: false,
  shownCustom: false,
  reset: false,
  shownDefault: false,
}
let finished = false

const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 'start' && text.includes('enter send')) {
    // Type a prefix first: the subcommand must be discoverable in the menu.
    write('/codebuddy pr')
    advance('completion')
    return
  }
  if (phase === 'completion' && since().includes('prompt [show|reset]')) {
    seen.completion = true
    // Enter applies the insert-only subcommand; the next Enter runs it.
    write('\r')
    advance('completion-applied')
    return
  }
  if (phase === 'completion-applied') {
    write('\r')
    advance('menu')
    return
  }
  if (phase === 'menu' && since().includes('Current: default') && since().includes('Add a custom template')) {
    seen.menu = true
    write('\r')
    advance('editor')
    return
  }
  if (phase === 'editor' && since().includes('Enter saves')) {
    seen.editor = true
    write('\r')
    advance('saved')
    return
  }
  if (phase === 'saved' && since().includes('saved (')) {
    seen.saved = true
    seen.savedKeepsPrompt = since().includes('keeps the harness prompt')
    try {
      seen.patchHasTemplate = readFileSync(patch, 'utf8').includes('{prompt}')
    } catch {}
    write('/codebuddy prompt show\r')
    advance('shown')
    return
  }
  if (phase === 'shown' && since().includes('custom template (')) {
    seen.shownCustom = true
    write('/codebuddy prompt reset\r')
    advance('reset')
    return
  }
  if (phase === 'reset' && since().includes('reset to the default')) {
    seen.reset = true
    write('/codebuddy prompt show\r')
    advance('shown-default')
    return
  }
  if (phase === 'shown-default' && since().includes('CodeBuddy system prompt: default')) {
    seen.shownDefault = true
    finished = true
    setTimeout(() => write('\x04'), 400)
  }
}, 100)

const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 60000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const elapsed = Date.now() - started
  const checks = [
    ['completion lists the prompt subcommand', seen.completion],
    ['menu reports the default source', seen.menu],
    ['custom template opens the multi-line editor', seen.editor],
    ['the template saves through settings', seen.saved],
    ['the saved notice says the harness prompt is kept', seen.savedKeepsPrompt],
    ['the profile patch carries the template', seen.patchHasTemplate],
    ['show reports the custom template', seen.shownCustom],
    ['reset removes the custom template', seen.reset],
    ['show reports the default again', seen.shownDefault],
  ]
  for (const [label, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + ' ' + label)
  console.log('EXIT ' + String(code) + ' signal=' + String(signal) + ' finished=' + String(finished) + ' elapsed=' + String(elapsed) + 'ms')
  const failed = checks.filter(([, ok]) => !ok)
  if (failed.length > 0) {
    console.log(strip(out).slice(-8000))
    console.log('--- STDERR ---')
    console.log(err.slice(-4000))
  }
  console.log(failed.length === 0 && finished && code === 0 ? 'OK guided system prompt verified' : 'FAILED ' + String(failed.length) + ' check(s)')
  process.exit(failed.length === 0 && finished && code === 0 ? 0 : 1)
})
