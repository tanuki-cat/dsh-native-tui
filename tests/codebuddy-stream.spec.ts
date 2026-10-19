import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildChatPayload } from '../src/codebuddy/wire.js'
import { decodeSse, type SseFrame } from '../src/codebuddy/sse.js'
import { streamChat, toStreamChunks } from '../src/codebuddy/stream.js'
import { cnProfile, enProfile } from '../src/codebuddy/profiles.js'

afterEach(() => { vi.unstubAllGlobals() })

/** Build one request body from a loose message list. */
function optionsOf(overrides: Record<string, unknown>): GenerateOptions {
  return { provider: 'codebuddy', model: 'chat-a', messages: [], ...overrides } as unknown as GenerateOptions
}

/** One normalized image reference: 4096x2048, so the pixel budget must shrink it. */
const imageRef = {
  attachmentId: 'sha256:0123456789abcdef',
  mediaType: 'image/png',
  bytes: 4096,
  width: 4096,
  height: 2048,
} as unknown as Extract<ContentBlock, { type: 'image' }>['attachment']

/** Encode text chunks as one byte stream. */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Collect decoded frames. */
async function framesOf(chunks: readonly string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of decodeSse(streamOf(chunks))) frames.push(frame)
  return frames
}

/** Feed the translator from raw SSE data payloads. */
async function* payloadsOf(payloads: readonly string[]): AsyncGenerator<SseFrame> {
  for (const data of payloads) yield { data }
}

/** Collect every chunk the translator emits. */
async function chunksOf(payloads: readonly string[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of toStreamChunks(payloadsOf(payloads), 'chat-a')) chunks.push(chunk)
  return chunks
}

describe('codebuddy wire serialization', () => {
  it('sends the verified request shape', async () => {
    const body = await buildChatPayload(optionsOf({
      system: 'be brief',
      maxTokens: 128,
      temperature: 0.2,
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' }, id: 's' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, id: 'u' },
        { role: 'developer', content: [{ type: 'tool-removal', toolName: 'read' }], source: { kind: 'user' }, id: 'd' },
      ],
    }), cnProfile)
    expect(body).toEqual({
      model: 'chat-a',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      stream: true,
      max_tokens: 128,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } }],
    })
    expect(body).not.toHaveProperty('store')
    expect(body).not.toHaveProperty('stream_options')
  })

  it('serializes tool calls and their results', async () => {
    const body = await buildChatPayload(optionsOf({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          ],
          source: { kind: 'model', provider: 'codebuddy', model: 'chat-a' },
          id: 'a',
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'contents' }], source: { kind: 'tool', callId: 'call_1' }, id: 't' },
        { role: 'assistant', content: [], source: { kind: 'model', provider: 'codebuddy', model: 'chat-a' }, id: 'empty' },
      ],
    }), cnProfile)
    // The gateways require a leading system message even for a tool-only
    // history, so the empty system prompt is part of the contract here.
    expect(body.messages).toEqual([
      { role: 'system', content: '' },
      { role: 'assistant', content: 'working', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])
  })

  it('pairs reasoning_effort with reasoning_summary', async () => {
    const on = await buildChatPayload(optionsOf({ reasoningEffort: 'high' }), cnProfile)
    expect(on.reasoning_effort).toBe('high')
    expect(on.reasoning_summary).toBe('auto')
    expect(await buildChatPayload(optionsOf({ reasoningEffort: 'off' }), cnProfile)).not.toHaveProperty('reasoning_effort')
  })

  it('sends a user image as a base64 image_url part', async () => {
    const seen: string[] = []
    const body = await buildChatPayload(optionsOf({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what color?' },
          { type: 'image', attachment: imageRef },
        ],
        source: { kind: 'user' },
        id: 'u',
      }],
    }), cnProfile, undefined, {
      reader: {
        async readImageRequest(ref: unknown, target: { width: number; height: number; maxBytes: number }) {
          seen.push(JSON.stringify(target))
          return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
        },
      },
    })
    const messages = body.messages as { role: string; content: unknown }[]
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what color?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.from([1, 2, 3]).toString('base64') } },
      ],
    })
    // The reader is asked for a projected target, not the source dimensions:
    // 4096x2048 shrinks inside the 2048² pixel budget, aspect preserved.
    expect(seen[0]).toBe(JSON.stringify({ width: 2896, height: 1448, maxBytes: 1024 * 1024 }))
  })

  it('sends a tool-result image and keeps text-only content a string', async () => {
    const body = await buildChatPayload(optionsOf({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'shot', arguments: '{}' }],
          source: { kind: 'model', provider: 'codebuddy', model: 'chat-a' },
          id: 'a',
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'captured' }, { type: 'image', attachment: imageRef }],
          source: { kind: 'tool', callId: 'call_1' },
          id: 't',
        },
      ],
    }), cnProfile, undefined, {
      reader: { async readImageRequest() { return { data: new Uint8Array([9]), mediaType: 'image/jpeg' } } },
    })
    const messages = body.messages as { role: string; content: unknown }[]
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'captured' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from([9]).toString('base64') } },
      ],
    })
  })

  it('degrades an unreadable image to placeholder text and reports it', async () => {
    const diagnostics: string[] = []
    const body = await buildChatPayload(optionsOf({
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'user' },
        id: 'u',
      }],
    }), cnProfile, undefined, {
      reader: { async readImageRequest() { throw new Error('store offline') } },
      onDiagnostic: message => { diagnostics.push(message) },
    })
    const messages = body.messages as { role: string; content: unknown }[]
    const content = messages[1]?.content as { type: string; text?: string }[]
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toContain('image unavailable')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('store offline')
  })

  it('names an image the endpoint cannot carry in that role', async () => {
    await expect(buildChatPayload(optionsOf({
      messages: [{
        role: 'system',
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'system-prompt' },
        id: 's',
      }],
    }), cnProfile)).rejects.toThrowError(/user messages and tool results/u)
  })

  it('drops a developer message instead of failing on its image', async () => {
    // The developer message never reaches this endpoint, so its image is not a
    // capability problem and must not fail the turn.
    const body = await buildChatPayload(optionsOf({
      messages: [
        { role: 'developer', content: [{ type: 'image', attachment: imageRef }], source: { kind: 'user' }, id: 'd' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, id: 'u' },
      ],
    }), cnProfile, undefined, {
      reader: { async readImageRequest() { throw new Error('must not read a dropped message') } },
    })
    const messages = body.messages as { role: string }[]
    expect(messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('does not send bytes for an image the host marked offloaded', async () => {
    const reads: string[] = []
    const body = await buildChatPayload(optionsOf({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'older image' },
          { type: 'image', attachment: imageRef, offloaded: true },
        ],
        source: { kind: 'user' },
        id: 'u',
      }],
    }), cnProfile, undefined, {
      reader: {
        async readImageRequest(ref: { attachmentId: string }) {
          reads.push(ref.attachmentId)
          return { data: new Uint8Array([1]), mediaType: 'image/png' }
        },
      },
    })
    expect(reads).toEqual([])
    const messages = body.messages as { role: string; content: unknown }[]
    const content = messages[1]?.content as { type: string; text?: string }[]
    expect(content.map(part => part.type)).toEqual(['text', 'text'])
    expect(content[0]?.text).toBe('older image')
    // The host's own placeholder, not this route's "unavailable" wording.
    expect(content[1]?.text).toContain('sha256:')
    expect(JSON.stringify(body)).not.toContain('image_url')
  })

  it('reads one attachment once however many messages cite it', async () => {
    const reads: string[] = []
    const reader = {
      async readImageRequest(ref: { attachmentId: string }) {
        reads.push(ref.attachmentId)
        return { data: new Uint8Array([1]), mediaType: 'image/png' }
      },
    }
    const body = await buildChatPayload(optionsOf({
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: imageRef }], source: { kind: 'user' }, id: 'u1' },
        { role: 'user', content: [{ type: 'text', text: 'again' }, { type: 'image', attachment: imageRef }], source: { kind: 'user' }, id: 'u2' },
      ],
    }), cnProfile, undefined, { reader })
    expect(reads).toEqual([imageRef.attachmentId])
    const messages = body.messages as { role: string; content: unknown }[]
    expect(JSON.stringify(messages[1])).toContain('image_url')
    expect(JSON.stringify(messages[2])).toContain('image_url')
  })

  it('pairs each prepared image with its own attachment', async () => {
    // Two distinct attachments read concurrently. If the reads were zipped by
    // position instead of by reference, each message would carry the other
    // image's bytes — a wrong answer with nothing to point at in the body.
    const first = { ...imageRef, attachmentId: 'sha256:' + '1'.repeat(56) }
    const second = { ...imageRef, attachmentId: 'sha256:' + '2'.repeat(56) }
    const body = await buildChatPayload(optionsOf({
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: first }], source: { kind: 'user' }, id: 'u1' },
        { role: 'user', content: [{ type: 'image', attachment: second }], source: { kind: 'user' }, id: 'u2' },
      ],
    }), cnProfile, undefined, {
      reader: {
        async readImageRequest(ref: { attachmentId: string }) {
          // The later reference resolves first, so completion order differs from
          // request order: only identity, not position, can pair them correctly.
          if (ref.attachmentId === first.attachmentId) await new Promise(resolve => setTimeout(resolve, 5))
          // Distinct lengths, so the two data URIs cannot be confused by a
          // substring match: three bytes versus one.
          const data = ref.attachmentId === first.attachmentId ? new Uint8Array([0x11, 0x11, 0x11]) : new Uint8Array([0x22])
          return { data, mediaType: 'image/png' }
        },
      },
    })
    const messages = body.messages as { content: { image_url?: { url: string } }[] }[]
    expect(messages[1]?.content[0]?.image_url?.url).toContain(Buffer.from([0x11, 0x11, 0x11]).toString('base64'))
    expect(messages[2]?.content[0]?.image_url?.url).toContain(Buffer.from([0x22]).toString('base64'))
    expect(messages[2]?.content[0]?.image_url?.url).not.toContain(Buffer.from([0x11, 0x11, 0x11]).toString('base64'))
  })

  it('fails with IMAGE_OFFLOAD_REQUIRED when retained images exceed the inline budget', async () => {
    // Two images at 12 MiB encoded each clear the 20 MiB inline budget only by
    // offloading the oldest occurrence first.
    const big = { ...imageRef, bytes: 12 * 1024 * 1024 }
    const body = () => buildChatPayload(optionsOf({
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:first' } }], source: { kind: 'user' }, id: 'u1' },
        { role: 'user', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:second' } }], source: { kind: 'user' }, id: 'u2' },
      ],
    }), cnProfile, undefined, {
      reader: {
        async readImageRequest(ref: { attachmentId: string }) {
          return { data: new Uint8Array(big.bytes), mediaType: 'image/png' }
        },
      },
    })
    await expect(body()).rejects.toMatchObject({
      code: 'IMAGE_OFFLOAD_REQUIRED',
      failure: { offloadImages: 1 },
    })

    // Offloading the oldest occurrence brings the same request back in budget.
    const fits = await buildChatPayload(optionsOf({
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:first' }, offloaded: true }], source: { kind: 'user' }, id: 'u1' },
        { role: 'user', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:second' } }], source: { kind: 'user' }, id: 'u2' },
      ],
    }), cnProfile, undefined, {
      reader: { async readImageRequest() { return { data: new Uint8Array(big.bytes), mediaType: 'image/png' } } },
    })
    const fitsMessages = fits.messages as { content: { type: string }[] }[]
    // One image part survives; the offloaded occurrence is placeholder text.
    expect(fitsMessages[1]?.content.map(part => part.type)).toEqual(['text'])
    expect(fitsMessages[2]?.content.map(part => part.type)).toEqual(['image_url'])
  })

  it('prices only the messages it actually sends', async () => {
    const big = { ...imageRef, bytes: 12 * 1024 * 1024 }
    const reader = { async readImageRequest() { return { data: new Uint8Array(big.bytes), mediaType: 'image/png' } } }
    // A dropped developer image must not consume the inline budget: only one
    // image is posted, so the request fits.
    const body = await buildChatPayload(optionsOf({
      messages: [
        { role: 'developer', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:dev' } }], source: { kind: 'user' }, id: 'd' },
        { role: 'user', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:user' } }], source: { kind: 'user' }, id: 'u' },
      ],
    }), cnProfile, undefined, { reader })
    const messages = body.messages as { role: string; content: { type: string }[] }[]
    expect(messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(messages[1]?.content.map(part => part.type)).toEqual(['image_url'])
  })

  it('reports an unsupported image role before pricing it', async () => {
    const big = { ...imageRef, bytes: 12 * 1024 * 1024 }
    // Two assistant images would blow the budget, but the role is unsendable:
    // naming that is the actionable failure, not an offload request.
    await expect(buildChatPayload(optionsOf({
      messages: [
        { role: 'assistant', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:a1' } }], source: { kind: 'model', provider: 'codebuddy', model: 'chat-a' }, id: 'a1' },
        { role: 'assistant', content: [{ type: 'image', attachment: { ...big, attachmentId: 'sha256:a2' } }], source: { kind: 'model', provider: 'codebuddy', model: 'chat-a' }, id: 'a2' },
      ],
    }), cnProfile, undefined, { reader: { async readImageRequest() { return { data: new Uint8Array(big.bytes), mediaType: 'image/png' } } } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('overlaps the reads of distinct images', async () => {
    let concurrent = 0
    let peak = 0
    const attachments = ['sha256:a', 'sha256:b', 'sha256:c', 'sha256:d'].map(attachmentId => ({
      ...imageRef,
      attachmentId,
    }))
    const body = await buildChatPayload(optionsOf({
      messages: attachments.map((attachment, index) => ({
        role: 'user' as const,
        content: [{ type: 'image' as const, attachment }],
        source: { kind: 'user' as const },
        id: 'u' + String(index),
      })),
    }), cnProfile, undefined, {
      reader: {
        async readImageRequest() {
          concurrent += 1
          peak = Math.max(peak, concurrent)
          await new Promise(resolve => setTimeout(resolve, 10))
          concurrent -= 1
          return { data: new Uint8Array([1]), mediaType: 'image/png' }
        },
      },
    })
    expect(peak).toBeGreaterThan(1)
    expect(body.messages).toHaveLength(5)
  })
})

describe('codebuddy sse decoding', () => {
  it('decodes split, multi-line, comment and CRLF frames', async () => {
    const frames = await framesOf([
      ': heartbeat\n\n',
      'data: {"a":',
      '1}\n\ndata: line one\ndata: line two\n\n',
      'data: [DONE]',
    ])
    expect(frames).toEqual([
      { data: '{"a":1}' },
      { data: 'line one\nline two' },
      // A tail without its blank-line terminator is still one frame.
      { data: '[DONE]' },
    ])
  })
})

describe('codebuddy stream translation', () => {
  it('emits text blocks and a terminal finish', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ choices: [{ delta: { content: 'He' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'He' },
      { type: 'text-delta', index: 0, text: 'llo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('keeps reasoning and text in separate blocks', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles tool call fragments and usage', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    ])
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' } })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('treats [DONE] as the terminal frame', async () => {
    const chunks = await chunksOf([
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
      '[DONE]',
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('refuses an unterminated or empty stream', async () => {
    await expect(chunksOf([JSON.stringify({ choices: [{ delta: { content: 'half' } }] })]))
      .rejects.toMatchObject({ code: 'INCOMPLETE_STREAM' })
    await expect(chunksOf([JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })]))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunksOf([JSON.stringify({ code: 11102, msg: 'gone' })]))
      .rejects.toMatchObject({ code: 'NO_SUCH_MODEL' })
  })
})

describe('codebuddy chat transport', () => {
  const sse = (payloads: readonly string[]): Response => new Response(
    streamOf(payloads.map(data => 'data: ' + data + '\n\n')),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

  it('falls back from /console only on 404/405', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      if (seen.length === 1) return new Response('', { status: 404 })
      return sse([JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })])
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of streamChat({
      profile: enProfile,
      model: 'chat-a',
      payload: { model: 'chat-a', messages: [], stream: true },
      access: 'token',
    })) chunks.push(chunk)
    expect(seen[0]).toBe('https://www.workbuddy.ai/console/chat/completions')
    expect(seen[1]).toBe('https://www.workbuddy.ai/v2/chat/completions')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('rotates once on 401 and retries with the fresh token', async () => {
    const tokens: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      calls += 1
      tokens.push(init.headers.Authorization ?? '')
      if (calls === 1) return new Response('{}', { status: 401 })
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of streamChat({
      profile: cnProfile,
      model: 'chat-a',
      payload: { model: 'chat-a', messages: [], stream: true },
      access: 'stale',
      reauthorize: async () => 'fresh',
    })) chunks.push(chunk)
    expect(tokens).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('aborts a stream that stops producing frames and reports TIMEOUT', async () => {
    let aborted = false
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => {
      init.signal?.addEventListener('abort', () => { aborted = true })
      // A body that never produces a frame and never closes: the reader stays
      // pending until the idle guard settles the wait.
      return new Response(new ReadableStream({ start() { /* stalled */ } }), { status: 200 })
    })
    await expect((async () => {
      for await (const _chunk of streamChat({
        profile: cnProfile,
        model: 'chat-a',
        payload: { model: 'chat-a', messages: [], stream: true },
        access: 'token',
        idleTimeoutMs: 20,
      })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(aborted).toBe(true)
  })

  it('re-arms the idle budget while frames keep arriving', async () => {
    const encoder = new TextEncoder()
    const frames = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'He' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }) + '\n\n',
    ]
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      async start(controller) {
        for (const frame of frames) {
          await new Promise(resolve => setTimeout(resolve, 200))
          controller.enqueue(encoder.encode(frame))
        }
        controller.close()
      },
    }), { status: 200 }))
    const chunks: StreamChunk[] = []
    // Two 200ms gaps exceed the 300ms budget in total but never in one gap, so
    // this only completes when every frame re-arms the deadline.
    for await (const chunk of streamChat({
      profile: cnProfile,
      model: 'chat-a',
      payload: { model: 'chat-a', messages: [], stream: true },
      access: 'token',
      idleTimeoutMs: 300,
    })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'llo' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('classifies a rejected request without a retry callback', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 11133 }), { status: 400 }))
    await expect((async () => {
      for await (const _chunk of streamChat({
        profile: cnProfile,
        model: 'chat-a',
        payload: { model: 'chat-a', messages: [], stream: true },
        access: 'token',
      })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
