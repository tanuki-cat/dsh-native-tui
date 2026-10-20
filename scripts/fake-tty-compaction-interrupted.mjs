/**
 * Real-Host check for a compaction that a crashed process left open.
 *
 * A crash between `compaction/start` and `compaction/end` keeps the durable
 * compaction lock. Resuming appends `turn/end{interrupted}` and then
 * `session/end-seed`, which is what releases that lock, so the card must read
 * as interrupted rather than "still compacting" or "compaction failed".
 *
 * The crash tail is appended to an existing probe session so every event keeps
 * the exact shape the Host writes.
 *
 * Setup:
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-compaction-interrupted-home
 *   cp -a /tmp/dsh-native-tui-reasoning-home/sessions/. \
 *     /tmp/dsh-native-tui-compaction-interrupted-home/sessions/
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-compaction-interrupted-home node scripts/fake-tty-compaction-interrupted.mjs
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-compaction-interrupted-home'
if (!home.startsWith('/tmp/dsh-native-tui-')) {
  console.error('Refusing to rewrite a profile outside a disposable /tmp/dsh-native-tui-* home: ' + home)
  process.exit(2)
}
const profile = join(home, 'profiles', 'tui')
if (!existsSync(profile)) {
  if (!existsSync('/tmp/dsh-native-tui-reasoning-home')) {
    console.error('Install a TUI profile at ' + home + ' first (or copy the reasoning probe home).')
    process.exit(2)
  }
  cpSync('/tmp/dsh-native-tui-reasoning-home', home, { recursive: true })
}

const ZSTD_MAGIC = 0xFD2FB528

/** Split one concatenated-frame artifact into its JSONL records. */
function readSession(file) {
  const raw = readFileSync(file)
  const starts = []
  for (let offset = 0; offset + 4 <= raw.length; offset += 1) {
    if (raw.readUInt32LE(offset) === ZSTD_MAGIC) starts.push(offset)
  }
  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : raw.length
    try { text += zstdDecompressSync(raw.subarray(starts[index], end)).toString('utf8') } catch {}
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Compress each record as its own frame, matching the persistence backend. */
function writeSession(file, events) {
  const frames = events.map(event => zstdCompressSync(
    Buffer.from(JSON.stringify(event) + '\n', 'utf8'),
    { params: { [constants.ZSTD_c_checksumFlag]: 1 } },
  ))
  writeFileSync(file, Buffer.concat(frames))
}

const id = 'native-tui-00000000-0000-4000-8000-00000000c0de'
const projects = join(home, 'sessions', '--Users-wangzy-WorkSpace-WebStormProjects-dsh-native-tui--')
// Derive from a balanced session: this probe's own output ends inside an open
// turn, so reusing it would append a second turn/start and fail validation.
let source
for (const entry of existsSync(projects) ? readdirSync(projects) : []) {
  if (entry === id) continue
  const candidate = join(projects, entry, 'session.v4.jsonl.zstd')
  if (!existsSync(candidate)) continue
  try {
    const events = readSession(candidate)
    if (events.at(-1)?.type === 'turn/end') { source = candidate; break }
  }
  catch {
    // A torn or foreign log is not a usable event-shape source.
  }
}
if (source === undefined) {
  console.error('No balanced source session; run scripts/fake-tty-reasoning-stream.mjs against this home first.')
  process.exit(2)
}

const dir = join(projects, id)
mkdirSync(dir, { recursive: true })
const [header, ...body] = readSession(source)
const last = body.at(-1)
const nextTurn = (last.data.turn ?? 0) + 1
const now = Date.now()
body.push({ type: 'turn/start', seq: last.seq + 1, time: now - 5_000, data: { turn: nextTurn } })
body.push({
  type: 'compaction/start',
  seq: last.seq + 2,
  time: now - 4_000,
  data: { compactionId: '11111111-2222-4333-8444-555555555555', turn: nextTurn },
})
const log = join(dir, 'session.v4.jsonl.zstd')
writeSession(log, [{ ...header, id }, ...body])

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui', '--resume', id], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, COLUMNS: '110', LINES: '34', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
let loaded = false
const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (!loaded && text.includes('enter send')) {
    loaded = true
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 800)
  }
}, 100)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20_000)

function strip(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const interrupted = text.includes('⚠ interrupted')
  const running = text.includes('⟳ compacting…')
  const failed = text.includes('✕ failed')
  const turnNotice = text.includes('Turn interrupted before it finished')
  const pass = interrupted && !running && !failed && turnNotice
  console.log('EXIT', code, signal, 'loaded', loaded, 'after', Date.now() - started, 'ms')
  console.log('cardInterrupted', interrupted, 'cardRunning', running, 'cardFailed', failed, 'turnNotice', turnNotice)
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-8000))
    console.log('--- stderr tail ---')
    console.log(err.slice(-4000))
  }
  process.exit(pass ? 0 : 1)
})
