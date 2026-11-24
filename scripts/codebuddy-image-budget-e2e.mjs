import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CodeBuddyAdapter } from '../dist/codebuddy/adapter.js'

assert(process.env.DSH_CLI_ENTRY, 'Set DSH_CLI_ENTRY to the target CLI lib/bin.js')
const requireCli = createRequire(await realpath(process.env.DSH_CLI_ENTRY))
const requireBase = createRequire(requireCli.resolve('@deepseek-ai/dsh-base/package.json'))
const attachment = requireBase.resolve('@deepseek-ai/dsh-attachment-local')
const requireAttachment = createRequire(attachment)
const { Context } = await import(pathToFileURL(requireAttachment.resolve('@deepseek-ai/cordis')).href)
const { LocalAttachmentStore } = await import(pathToFileURL(attachment).href)
const sharp = requireAttachment('sharp')
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-codebuddy-image-'))
const ctx = new Context()
const store = new LocalAttachmentStore(ctx, { dshHome, normalizedImageMaxBytes: 16 * 1024 * 1024 })
const hash = data => createHash('sha256').update(data).digest('hex')
const fetch = globalThis.fetch

try {
  const raw = { width: 1600, height: 1600, channels: 3 }
  const data = await sharp(randomBytes(raw.width * raw.height * raw.channels), { raw }).png().toBuffer()
  const ref = await store.saveImage({ data, mediaType: 'image/png', name: 'probe.png' })
  const original = await store.readImage(ref)
  assert(original.data.byteLength > 1024 * 1024, 'fixture must exceed the request limit')

  let body
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
  }
  const adapter = new CodeBuddyAdapter({
    store: () => ({ readRecord: async () => ({
      kind: 'grant', payload: { access: 'local-fixture', refresh: 'local-fixture', expires: Date.now() + 86400_000 },
    }) }),
    resolveAttachments: () => store,
  })
  for await (const _chunk of adapter.stream({
    provider: 'codebuddy', model: 'chat-a',
    messages: [{ role: 'user', source: { kind: 'user' }, id: 'probe', content: [{ type: 'image', attachment: ref }] }],
  })) {}

  const content = body?.messages.find(message => message.role === 'user')?.content
  const image = Array.isArray(content) ? content.find(part => part.type === 'image_url') : undefined
  assert(image, 'request must include the image instead of a placeholder')
  const request = Buffer.from(image.image_url.url.split(',')[1], 'base64')
  const metadata = await sharp(request).metadata()
  assert(request.byteLength <= 1024 * 1024)
  assert(metadata.width <= ref.width && metadata.height <= ref.height)
  assert.equal(hash((await store.readImage(ref)).data), hash(original.data))
  console.log(JSON.stringify({ originalBytes: original.data.byteLength, requestBytes: request.byteLength, width: metadata.width, height: metadata.height, evidence: dshHome }))
} finally {
  globalThis.fetch = fetch
  await ctx.fiber.dispose()
}
