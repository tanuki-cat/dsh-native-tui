import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildChatPayload } from '../src/codebuddy/wire.js'
import { decodeSse, type SseFrame } from '../src/codebuddy/sse.js'
import { streamChat, toStreamChunks } from '../src/codebuddy/stream.js'
import { cnProfile, enProfile } from '../src/codebuddy/profiles.js'

afterEach(() => { vi.unstubAllGlobals() })

/** Build one request body from a loose message list. */
function optionsOf(overrides: Record<string, unknown>): GenerateOptions {
  return { provider: 'codebuddy', model: 'chat-a', messages: [], ...overrides } as unknown as GenerateOptions
}

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
  it('sends the verified request shape', () => {
    const body = buildChatPayload(optionsOf({
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

  it('serializes tool calls and their results', () => {
    const body = buildChatPayload(optionsOf({
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

  it('pairs reasoning_effort with reasoning_summary and refuses images', () => {
    const on = buildChatPayload(optionsOf({ reasoningEffort: 'high' }), cnProfile)
    expect(on.reasoning_effort).toBe('high')
    expect(on.reasoning_summary).toBe('auto')
    expect(buildChatPayload(optionsOf({ reasoningEffort: 'off' }), cnProfile)).not.toHaveProperty('reasoning_effort')
    expect(() => buildChatPayload(optionsOf({
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { name: 'a.png' } }],
        source: { kind: 'user' },
        id: 'u',
      }],
    }), cnProfile)).toThrowError(/text-only/u)
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
