import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
mkdirSync('.tmp', { recursive: true })
const workspace = mkdtempSync(resolve('.tmp/session-drafts-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-native-tui-drafts-'))
const prompts = []
const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const title = body.includes('Create a concise title')
    if (!title) prompts.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'drafts-probe', object: 'chat.completion.chunk', created: 1, model: 'mock-model' }
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    send({ role: 'assistant' })
    send({ content: title ? 'Drafts probe' : 'DRAFT BASE DONE' })
    send({}, 'stop')
    res.end('data: [DONE]\n\n')
  })
})
let child, out = '', err = '', lastInputOffset = 0
const waiters = new Set()
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b_[^\x07]*\x07/g, '')
function waitFor(needle, offset = 0) {
  const check = () => {
    const text = strip(out.slice(offset))
    return typeof needle === 'string' ? text.includes(needle) : needle.test(text)
  }
  if (check()) return Promise.resolve(strip(out.slice(offset)))
  return new Promise((yes, no) => {
    const finish = error => { clearTimeout(timer); waiters.delete(visit); error ? no(error) : yes(strip(out.slice(offset))) }
    const visit = () => { if (check()) finish() }
    const timer = setTimeout(() => { finish(new Error('Timed out waiting for ' + needle)) }, 20000)
    waiters.add(visit)
  })
}
async function send(input, needle) {
  const offset = out.length
  lastInputOffset = offset
  child.stdin.write(input)
  return waitFor(needle, offset)
}
async function choose(id) {
  await send('\x1bs', 'Switch session · drafts stay with their session')
  await send(id, 'search: ' + id)
  const frame = await send('\r', 'Switched to ' + id)
  return frame.slice(frame.lastIndexOf('Switched to ' + id))
}
let exitPromise
try {
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const port = server.address().port
  const profile = join(home, 'profiles/tui')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'drafts-probe', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + root },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  symlinkSync(root, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(workspace, 'draft-b.txt'), 'staged with B, never sent')
  writeFileSync(join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 128000
            maxTokens: 4096
- id: native-tui
  config:
    agentPreset: ptc
    theme: plain
- id: agent-default-model
  config:
    provider: mock
    model: mock-model
`)
  child = spawn(process.execPath, [join(root, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], {
    cwd: workspace, env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', FAKE_TTY_COLUMNS: '160', TERM: 'xterm-256color', DSH_NATIVE_TUI_DEBUG: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  exitPromise = new Promise((yes, no) => {
    child.once('error', no)
    child.once('close', (code, signal) => { yes({ code, signal }) })
  })
  child.stdout.on('data', chunk => { out += chunk; for (const visit of [...waiters]) visit() })
  child.stderr.on('data', chunk => { err += chunk })
  await waitFor('enter send')
  const initial = await send('/status\r', /Session: native-tui-[a-z0-9-]+/)
  const baseId = initial.match(/Session: (native-tui-[a-z0-9-]+)/)[1]
  await send('base prompt\r', 'DRAFT BASE DONE')
  await waitFor(' · Ready', out.lastIndexOf('DRAFT BASE DONE'))
  const opened = await send('\x0e', /Switched to native-tui-[a-z0-9-]+/)
  const blankId = opened.match(/Switched to (native-tui-[a-z0-9-]+)/)[1]
  assert.notEqual(blankId, baseId)
  await send('/attach draft-b.txt\r', 'Attached file: draft-b.txt')
  await send('DRAFT_B_UNSENT', 'DRAFT_B_UNSENT')
  const baseFrame = await choose(baseId)
  assert(!baseFrame.includes('DRAFT_B_UNSENT'))
  assert(!baseFrame.includes('attached 1'))
  const restored = await send('\x0e', 'Switched to ' + blankId)
  await waitFor('DRAFT_B_UNSENT', lastInputOffset)
  assert(restored.includes('attached 1'))
  await choose(baseId)
  await send('/preset minimal\r', /[Pp]reset.*minimal/)
  const other = await send('\x0e', /Switched to native-tui-[a-z0-9-]+/)
  const otherId = other.match(/Switched to (native-tui-[a-z0-9-]+)/)[1]
  assert.notEqual(otherId, blankId)
  assert(!other.includes('DRAFT_B_UNSENT'))
  await send('DRAFT_C_UNSENT', 'DRAFT_C_UNSENT')
  const returned = await choose(blankId)
  await waitFor('DRAFT_B_UNSENT', lastInputOffset)
  assert(!returned.includes('DRAFT_C_UNSENT'))
  assert(returned.includes('attached 1'))
  assert(!prompts.some(body => body.includes('DRAFT_B_UNSENT') || body.includes('DRAFT_C_UNSENT')))
  child.stdin.write('\x04')
  const exit = await exitPromise
  assert.deepEqual(exit, { code: 0, signal: null })
  console.log('EXIT', exit.code, exit.signal, 'pass true')
  console.log(JSON.stringify({ draftRestored: true, attachmentsIsolated: true, blankReused: true, presetIsolated: true, unsentDraftsNotSubmitted: true }))
} catch (error) {
  console.error(error)
  console.error('STDOUT TAIL', strip(out).slice(-5000))
  console.error('STDERR TAIL', err.slice(-3000))
  process.exitCode = 1
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (exitPromise) await exitPromise
  server.closeAllConnections()
  await new Promise(yes => { server.close(yes) })
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
