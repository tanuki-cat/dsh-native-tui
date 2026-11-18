/**
 * Real-Host check that Escape cancels the `/` command in flight.
 *
 * `/provider edit <route>` fetches the route's model list; the probe points that
 * route at a local server that accepts the request and never answers, so the
 * command is still running when the TUI answers Escape. The transcript must
 * report a cancelled command rather than a discovery failure, and the terminal
 * must be usable again immediately.
 *
 * One-time setup (installs this repo's current build into a scratch home):
 *   DSH_HOME=/tmp/dsh-native-tui-cancel-home dsh plugin --profile tui add <repo>
 *
 * Run with:
 *   DSH_HOME=/tmp/dsh-native-tui-cancel-home node scripts/fake-tty-command-cancel.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-cancel-home'
const profile = join(home, 'profiles', 'tui')

if (!existsSync(join(profile, 'node_modules', 'dsh-native-tui'))) {
  console.error('Install this build into ' + home + ' first:')
  console.error('  DSH_HOME=' + home + ' dsh plugin --profile tui add ' + repo)
  process.exit(2)
}

// Accept the discovery request and never answer: the command stays in flight
// until Escape, whatever the machine's network does with a blackhole address.
const server = createServer((request) => { request.resume() })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          slow:
            api: openai-completions
            baseURL: http://127.0.0.1:${port}/v1
            apiKeyEnv: SLOW_API_KEY
            models:
              - id: slow-model
                name: slow-model
                contextWindow: 128000
                maxTokens: 4096
    - id: native-tui
      name: dsh-native-tui
      config:
        agentPreset: standard
`)

const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const child = spawn(process.execPath, [join(repo, 'scripts', 'fake-tty-entry.mjs'), '--profile', 'tui'], {
  cwd: repo,
  env: {
    ...process.env,
    DSH_HOME: home,
    SLOW_API_KEY: 'dummy',
    COLUMNS: '120',
    LINES: '36',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', data => { out += String(data) })
const send = data => { try { child.stdin.write(data) } catch {} }
let phase = 'editor'
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 'editor' && text.includes('enter send')) {
    phase = 'menu'
    send('/provider edit slow\r')
    return
  }
  if (phase === 'menu' && text.includes('Fetch available models')) {
    phase = 'fetching'
    send('\r')
    // The request is already hanging; Escape has to cancel it well before the
    // command's own timeout would.
    setTimeout(() => { phase = 'cancelled'; send('\x1b') }, 1_200)
    return
  }
  if (phase === 'cancelled' && text.includes('Model discovery cancelled.')) {
    phase = 'done'
    setTimeout(() => send('\x04'), 400)
  }
}, 120)

const hard = setTimeout(() => {
  clearInterval(tick)
  try { child.kill('SIGTERM') } catch {}
}, 20_000)

await new Promise(resolve => child.on('exit', resolve))
clearInterval(tick)
clearTimeout(hard)
server.close()

const final = strip(out)
const ok = final.includes('Model discovery cancelled.') && !final.includes('Could not fetch models for slow')
console.log(ok && phase === 'done' ? 'PASS Escape cancelled the running command' : 'FAIL phase=' + phase + ' verified=' + String(ok))
console.log(ok ? 'OK command cancellation verified' : 'FAIL final transcript did not report a cancellation')
console.log(final.slice(-2000))
process.exit(ok ? 0 : 1)
