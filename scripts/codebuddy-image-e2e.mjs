/**
 * End-to-end proof that CodeBuddy models declare their real input modalities
 * and that a declared image reaches the model.
 *
 * Drives the compiled adapter on a real Cordis context with the real credential
 * store, then checks:
 *   1. the catalogue's per-model modality claim (no attachment service needed),
 *   2. a user-message image answered correctly,
 *   3. a tool-result image answered correctly,
 *   4. an unreadable image degrading to placeholder text with a diagnostic,
 *   5. an image in an unsupported role being refused.
 *
 * Needs a signed-in CodeBuddy account in the DSH home. Checks 2-3 skip (rather
 * than fail) when no credential is stored, so an offline run still verifies
 * the catalogue mapping.
 *
 * Setup:
 *   pnpm build
 * Run with:
 *   node scripts/codebuddy-image-e2e.mjs [--profile <dsh-home>]
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'
import { CodeBuddyAdapter } from '../dist/codebuddy/adapter.js'
import { buildChatPayload } from '../dist/codebuddy/wire.js'
import { cnProfile } from '../dist/codebuddy/profiles.js'

const home = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : process.env.DSH_HOME ?? homedir() + '/.dsh'

/** A 64x64 two-tone PNG: red above, green below. */
function twoTonePng() {
  const width = 64
  const height = 64
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3
      if (y < height / 2) {
        raw[at] = 230
      }
      else {
        raw[at + 1] = 200
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The stored grant for one record key, read from the credential file.
 *
 * The file is YAML, but only this probe's one record matters and its scalar
 * fields are flat, so the block is read directly instead of adding a parser.
 */
async function grantOf(scope) {
  let text
  try {
    text = await readFile(home + '/.credentials.yaml', 'utf8')
  }
  catch {
    return undefined
  }
  const marker = '\n  ' + scope + ':\n'
  const start = text.indexOf(marker)
  if (start < 0) return undefined
  const rest = text.slice(start + marker.length)
  const next = rest.search(/\n  [a-z]/u)
  const block = next < 0 ? rest : rest.slice(0, next)
  const access = /\n\s*access:\s*(\S+)/u.exec(block)?.[1]
  const refresh = /\n\s*refresh:\s*(\S+)/u.exec(block)?.[1]
  const expires = Number(/\n\s*expires:\s*(\d+)/u.exec(block)?.[1])
  if (access === undefined || refresh === undefined) return undefined
  return { access, refresh, expires: Number.isFinite(expires) ? expires : 0 }
}

/** A read-only credential seam over the stored grant. */
function storeOf(grant) {
  const record = grant === undefined ? undefined : { kind: 'grant', payload: grant }
  return {
    async readRecord() { return record },
    async modifyRecord(_key, mutate) { return mutate(record) },
    async deleteRecord() {},
  }
}

const png = twoTonePng()
const attachment = {
  attachmentId: 'sha256:' + Buffer.from(png).toString('hex').slice(0, 16),
  mediaType: 'image/png',
  bytes: png.byteLength,
  width: 64,
  height: 64,
}
const broken = { ...attachment, attachmentId: 'sha256:deadbeefdeadbeef' }

/** Hands back the real PNG bytes, and fails for the broken reference. */
const attachments = {
  async readImageRequest(ref) {
    if (ref.attachmentId === broken.attachmentId) throw new Error('simulated store failure')
    return { data: new Uint8Array(png), mediaType: 'image/png' }
  },
}

let failures = 0
let skipped = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === '' ? '' : ' — ' + detail))
  if (!ok) failures += 1
}
const skip = (name, why) => {
  console.log('SKIP ' + name + ' — ' + why)
  skipped += 1
}

const grant = await grantOf('codebuddy/codebuddy')
const diagnostics = []
const adapter = new CodeBuddyAdapter({
  store: () => storeOf(grant),
  resolveAttachments: () => attachments,
  onDiagnostic: message => diagnostics.push(message),
})

// 1. Catalogue mapping. Without a grant the seed list answers instead, which is
//    exactly the text-only fallback this route documents.
if (grant === undefined) {
  skip('catalogue modalities', 'no stored codebuddy credential')
  const seeds = adapter.models('codebuddy')
  check('an unsigned route declares only text', seeds.every(model => model.inputModalities.join() === 'text'))
}
else {
  await adapter.refresh('codebuddy')
  const models = new Map(adapter.models('codebuddy').map(model => [model.id, model]))
  const vision = models.get('deepseek-v4.1-flash')
  check('deepseek-v4.1-flash declares image input', vision?.inputModalities.includes('image') === true,
    JSON.stringify(vision?.inputModalities))
  check('a text-only model stays text-only', models.get('hunyuan-chat')?.inputModalities.join() === 'text',
    JSON.stringify(models.get('hunyuan-chat')?.inputModalities))
  check('resolveModel agrees with the catalogue',
    (await adapter.resolveModel('codebuddy', 'deepseek-v4.1-flash')).inputModalities?.includes('image') === true)
  check('an unlisted model declares only text',
    (await adapter.resolveModel('codebuddy', 'not-in-the-catalogue')).inputModalities?.join() === 'text')
}

/** Drain one stream into its assistant text. */
async function answer(messages) {
  let text = ''
  for await (const chunk of adapter.stream({ provider: 'codebuddy', model: 'deepseek-v4.1-flash', messages })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new Error('stream failed: ' + JSON.stringify(chunk.reason))
    }
  }
  return text.trim()
}

// 2-3. Live image turns.
if (grant === undefined) {
  skip('a user image reaches the model', 'no stored codebuddy credential')
  skip('a tool-result image reaches the model', 'no stored codebuddy credential')
}
else {
  const userAnswer = await answer([{
    role: 'user',
    content: [
      { type: 'text', text: 'Split horizontally. Reply ONLY with the top color and the bottom color, like "red/blue".' },
      { type: 'image', attachment },
    ],
    source: { kind: 'user' },
    id: 'u',
  }])
  check('a user image reaches the model', /red/i.test(userAnswer) && /green/i.test(userAnswer), JSON.stringify(userAnswer))

  const toolAnswer = await answer([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'screenshot', arguments: '{}' }],
      source: { kind: 'model', provider: 'codebuddy', model: 'deepseek-v4.1-flash' },
      id: 'a',
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'screenshot captured' }, { type: 'image', attachment }],
      source: { kind: 'tool', callId: 'call_1' },
      id: 't',
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'What are the two colors? Two words, like "red/blue".' }],
      source: { kind: 'user' },
      id: 'u2',
    },
  ])
  check('a tool-result image reaches the model', /red/i.test(toolAnswer) && /green/i.test(toolAnswer), JSON.stringify(toolAnswer))
}

// 4. Degradation never fails the turn.
const before = diagnostics.length
const degraded = await buildChatPayload({
  provider: 'codebuddy',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'image', attachment: broken }], source: { kind: 'user' }, id: 'u3' }],
}, cnProfile, undefined, { reader: attachments, onDiagnostic: message => diagnostics.push(message) })
const serialized = JSON.stringify(degraded.messages)
check('an unreadable image degrades to placeholder text',
  serialized.includes('image unavailable') && !serialized.includes('image_url'))
check('the degradation is reported', diagnostics.length > before, diagnostics.at(-1) ?? '')

// 5. Role guard.
let refused = false
try {
  await buildChatPayload({
    provider: 'codebuddy',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'system', content: [{ type: 'image', attachment }], source: { kind: 'system-prompt' }, id: 's' }],
  }, cnProfile, undefined, { reader: attachments })
}
catch (error) {
  refused = /user messages and tool results/u.test(String(error))
}
check('an image outside user/tool is refused', refused)

console.log('')
console.log(failures === 0
  ? 'ALL CHECKS PASSED' + (skipped === 0 ? '' : ' (' + String(skipped) + ' skipped)')
  : String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
