/**
 * Chat transport and SSE -> DSH StreamChunk translation.
 *
 * The outbound body comes from wire.ts. This module owns the two things the
 * generic shape cannot express: the international endpoint's 404/405 fallback
 * (/console -> /v2), and the mapping of OpenAI streaming deltas onto the
 * harness chunk vocabulary (block start/delta/end, usage, finish).
 *
 * @module dsh-native-tui/codebuddy/stream
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { classifyFailure, gatewayCodeOf, hintForGatewayError, redact } from './errors.js'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, type CodeBuddyProfile } from './profiles.js'
import type { SseFrame } from './sse.js'
import { decodeSse } from './sse.js'

/** Path appended to a profile's chat base URL. */
const CHAT_PATH = '/chat/completions'

/** One streaming chat request. */
export interface ChatStreamOptions {
  /** Deployment to call. */
  readonly profile: CodeBuddyProfile
  /** Model id being requested. */
  readonly model: string
  /** Body from wire.ts. */
  readonly payload: Record<string, unknown>
  /** Bearer token to send. */
  readonly access: string
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /**
   * Rotate the credential and return a fresh token when the gateway rejects
   * the supplied one. Called at most once per request.
   */
  readonly reauthorize?: () => Promise<string>
  /** Idle budget override; defaults to {@link DEFAULT_STREAM_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number
}

/** Harness failure code for one classified upstream failure. */
function failureCodeOf(kind: ReturnType<typeof classifyFailure>): string {
  switch (kind) {
    case 'auth': return 'AUTH'
    case 'quota': return 'QUOTA'
    case 'rate_limit': return 'RATE_LIMIT'
    case 'no_such_model': return 'NO_SUCH_MODEL'
    case 'bad_request': return 'BAD_REQUEST'
    case 'unavailable': return 'UNAVAILABLE'
    case 'transport': return 'TRANSPORT'
    case 'incomplete_stream': return 'INCOMPLETE_STREAM'
    default: return 'UPSTREAM_ERROR'
  }
}

/** Append the actionable hint, when the classifier has one. */
function withHint(message: string): string {
  const hint = hintForGatewayError(message)
  return hint === undefined || message.includes(hint) ? message : message + '\n\n' + hint
}

/** One failure for an in-band error object or a non-2xx body. */
function upstreamError(route: string, status: number, text: string, businessCode?: number): LlmError {
  const kind = classifyFailure(status, text)
  const code = businessCode ?? gatewayCodeOf(parseJson(text))
  const detail = errorMessageOf(parseJson(text)) ?? redact(text.slice(0, 300))
  const label = status === 0 ? route : route + ' HTTP ' + String(status)
  return new LlmError(
    withHint(label + ' (code ' + String(code ?? '?') + '): ' + detail),
    failureCodeOf(kind),
    status === 0 ? {} : { status },
  )
}

/** Parse a body once, tolerating empty and non-JSON responses. */
function parseJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

/** The human-readable message of a gateway error body. */
function errorMessageOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as { msg?: unknown; message?: unknown; error?: unknown }
  const nested = record.error !== null && typeof record.error === 'object'
    ? (record.error as { message?: unknown }).message
    : record.error
  const message = typeof record.msg === 'string'
    ? record.msg
    : typeof record.message === 'string' ? record.message : nested
  return typeof message === 'string' && message !== '' ? redact(message) : undefined
}

/** POST one chat body to the first base URL that routes it. */
async function postChat(
  profile: CodeBuddyProfile,
  access: string,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const primary = profile.chatBaseUrls[0]
  if (primary === undefined) throw new LlmError(profile.id + ': no chat endpoint configured', 'INVALID_CONFIG')
  const body = JSON.stringify(payload)
  const send = (base: string): Promise<Response> => fetch(base + CHAT_PATH, {
    method: 'POST',
    headers: {
      ...profile.headers(access),
      'Content-Type': 'application/json',
      ...(profile.chatExtraHeaders ?? {}),
    },
    body,
    ...(signal === undefined ? {} : { signal }),
  })
  const first = await send(primary)
  const fallback = profile.chatBaseUrls[1]
  // Only "the gateway has no route here" replays the body; a status that means
  // the request was accepted must never be resent.
  if (fallback === undefined || (first.status !== 404 && first.status !== 405)) return first
  try {
    await first.body?.cancel()
  }
  catch {
    // Releasing the discarded response is best effort.
  }
  return send(fallback)
}

/**
 * Resolve one awaited step, or fail with `TIMEOUT` once it outlasts the idle
 * budget. The abort fires after the rejection so the abandoned step still
 * releases its socket, and so this call's outcome cannot be mistaken for the
 * transport error the abort produces.
 * @param step - the pending request or frame read.
 * @param timeoutMs - idle budget for this step.
 * @param idle - controller aborted when the budget expires.
 * @param label - error text naming the route and budget.
 * @returns the step's value.
 * @throws {LlmError} with code `TIMEOUT` when the budget expires.
 */
async function withIdleDeadline<T>(step: Promise<T>, timeoutMs: number, idle: AbortController, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new LlmError(label, 'TIMEOUT'))
      idle.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([step, expired])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Re-arm the idle budget around every frame wait, so a stream that keeps
 * producing frames is never abandoned while it makes progress.
 * @param frames - decoded frames of one response body.
 * @param timeoutMs - idle budget between two frames.
 * @param idle - controller aborted when the budget expires.
 * @param label - error text naming the route and budget.
 * @returns the same frames, in order.
 * @throws {LlmError} with code `TIMEOUT` when no frame arrives in time.
 */
async function* framesWithIdleDeadline(
  frames: AsyncGenerator<SseFrame>,
  timeoutMs: number,
  idle: AbortController,
  label: string,
): AsyncGenerator<SseFrame> {
  const iterator = frames[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await withIdleDeadline(iterator.next(), timeoutMs, idle, label)
      if (step.done === true) return
      yield step.value
    }
  }
  finally {
    // Release the abandoned demand; the read settles once the abort lands.
    const abandoned = iterator.return?.(undefined)
    void abandoned?.catch(() => {})
  }
}

/**
 * Classify one failed chat call. The idle guard aborts the socket without a
 * transport error of its own, so its signal explains the failure first; caller
 * cancellation is only reported when the caller's own signal is aborted.
 * @param profile - deployment being called.
 * @param error - the failure to translate.
 * @param idle - the idle guard's controller.
 * @param idleLabel - the failure text the guard already raised for an idle wait.
 * @param signal - the caller's cancellation signal.
 * @returns the harness failure to throw.
 */
function transportFailure(
  profile: CodeBuddyProfile,
  error: unknown,
  idle: AbortController,
  idleLabel: string,
  signal: AbortSignal | undefined,
): LlmError {
  if (idle.signal.aborted) return new LlmError(idleLabel, 'TIMEOUT', { cause: error })
  if (signal?.aborted === true) return new LlmError(profile.id + ' request aborted by caller', 'ABORTED', { cause: error })
  return new LlmError(
    profile.id + ' unreachable: ' + redact(error instanceof Error ? error.message : String(error)),
    'TRANSPORT',
    { cause: error },
  )
}

/**
 * Stream one chat completion, translating upstream frames into harness chunks.
 * @param options - the request, its credential and its cancellation.
 * @returns raw chunks in stream order.
 * @throws {LlmError} for transport, auth, quota, rate-limit and protocol failures.
 */
export async function* streamChat(options: ChatStreamOptions): AsyncGenerator<StreamChunk> {
  const { profile, signal } = options
  // A connection cut without a FIN leaves the body read pending forever. The
  // idle guard settles that wait as TIMEOUT, which the provider retry policy
  // replays, and aborts the socket so the request is not left open.
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const idle = new AbortController()
  const requestSignal = signal === undefined ? idle.signal : AbortSignal.any([signal, idle.signal])
  const idleLabel = profile.id + ': no frame for ' + String(idleTimeoutMs) + 'ms; request aborted'
  let access = options.access
  let response: Response
  try {
    response = await withIdleDeadline(postChat(profile, access, options.payload, requestSignal), idleTimeoutMs, idle, idleLabel)
    if ((response.status === 401 || response.status === 403) && options.reauthorize !== undefined) {
      try {
        await response.body?.cancel()
      }
      catch {
        // Best effort; the retry below is what matters.
      }
      access = await options.reauthorize()
      response = await withIdleDeadline(postChat(profile, access, options.payload, requestSignal), idleTimeoutMs, idle, idleLabel)
    }
  }
  catch (error) {
    if (error instanceof LlmError) throw error
    throw transportFailure(profile, error, idle, idleLabel, signal)
  }

  if (!response.ok) {
    const text = await response.text()
    throw upstreamError(profile.id, response.status, text)
  }
  if (response.body === null) throw new LlmError(profile.id + ' returned no response body', 'MALFORMED_RESPONSE')
  try {
    yield* toStreamChunks(framesWithIdleDeadline(decodeSse(response.body), idleTimeoutMs, idle, idleLabel), options.model, signal)
  }
  catch (error) {
    if (error instanceof LlmError) throw error
    throw transportFailure(profile, error, idle, idleLabel, signal)
  }
}

/** One content block open while deltas arrive. */
interface OpenBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
  arguments: string
}

/** Map one OpenAI finish reason onto the harness vocabulary. */
function mapFinishReason(reason: string): FinishReason {
  if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Map one OpenAI usage object; undefined when it carries nothing usable. */
function usageOf(raw: unknown): TokenUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown }
    completion_tokens_details?: { reasoning_tokens?: unknown }
  }
  const prompt = Number(record.prompt_tokens)
  const completion = Number(record.completion_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return undefined
  const cached = Number(record.prompt_tokens_details?.cached_tokens)
  const reasoning = Number(record.completion_tokens_details?.reasoning_tokens)
  const cachedTokens = Number.isFinite(cached) && cached > 0 ? cached : 0
  const total = Number(record.total_tokens)
  return {
    inputTokens: Math.max(0, (Number.isFinite(prompt) ? prompt : 0) - cachedTokens),
    outputTokens: Number.isFinite(completion) ? completion : 0,
    ...(Number.isFinite(total) ? { totalTokens: total } : {}),
    ...(cachedTokens === 0 ? {} : { cacheReadTokens: cachedTokens }),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * Translate decoded SSE frames into harness chunks.
 *
 * Block indexes are allocated in first-seen order across text, reasoning and
 * tool calls, so interleaved deltas correlate without colliding.
 * @param frames - decoded SSE frames.
 * @param model - model id, for diagnostics.
 * @param signal - caller cancellation.
 * @returns raw chunks in stream order.
 */
export async function* toStreamChunks(
  frames: AsyncIterable<SseFrame>,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  let sawTerminal = false
  let usage: TokenUsage | undefined

  for await (const frame of frames) {
    if (signal?.aborted === true) throw new LlmError(model + ' request aborted by caller', 'ABORTED')
    const data = frame.data.trim()
    if (data === '') continue
    if (data === '[DONE]') {
      sawTerminal = true
      break
    }
    const parsed = parseJson(data)
    if (parsed === null || typeof parsed !== 'object') continue
    const body = parsed as Record<string, unknown>
    const code = gatewayCodeOf(body)
    const choices = body.choices
    if (body.error !== undefined || (code !== undefined && code !== 0 && !Array.isArray(choices))) {
      throw upstreamError(model, 0, data, code)
    }
    if (body.usage !== undefined) usage = usageOf(body.usage) ?? usage
    if (!Array.isArray(choices) || choices.length === 0) continue
    const choice = choices[0]
    if (choice === null || typeof choice !== 'object') continue
    const record = choice as Record<string, unknown>
    const delta = record.delta
    if (delta !== null && typeof delta === 'object') {
      const fields = delta as Record<string, unknown>
      const content = fields.content
      if (typeof content === 'string' && content !== '') {
        if (textBlock === undefined) {
          textBlock = { index: nextIndex++, type: 'text', text: '', arguments: '' }
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      const reasoning = typeof fields.reasoning_content === 'string'
        ? fields.reasoning_content
        : typeof fields.reasoning === 'string' ? fields.reasoning : ''
      if (reasoning !== '') {
        if (reasoningBlock === undefined) {
          reasoningBlock = { index: nextIndex++, type: 'reasoning', text: '', arguments: '' }
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const calls = fields.tool_calls
      if (Array.isArray(calls)) {
        for (const raw of calls) {
          if (raw === null || typeof raw !== 'object') continue
          const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }
          const callIndex = typeof call.index === 'number' ? call.index : toolBlocks.size
          let block = toolBlocks.get(callIndex)
          if (block === undefined) {
            block = { index: nextIndex++, type: 'tool-call', text: '', arguments: '' }
            toolBlocks.set(callIndex, block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          if (typeof call.id === 'string' && call.id !== '') block.id = call.id
          if (typeof call.function?.name === 'string' && call.function.name !== '') block.name = call.function.name
          const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          block.arguments += argumentsDelta
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(block.id ?? 'call_' + String(callIndex)),
            ...(block.name === undefined ? {} : { name: block.name }),
            argumentsDelta,
          }
        }
      }
    }
    const reason = record.finish_reason
    if (typeof reason === 'string' && reason !== '') {
      sawTerminal = true
      if (textBlock === undefined && reasoningBlock === undefined && toolBlocks.size === 0) {
        throw new LlmError(model + ': upstream returned a completion with no content', 'EMPTY_RESPONSE')
      }
      yield* closeBlocks(textBlock, reasoningBlock, toolBlocks, model)
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: mapFinishReason(reason) }
      return
    }
  }

  if (!sawTerminal) {
    throw new LlmError(model + ': upstream stream ended without a finish frame (code could not be resumed)', 'INCOMPLETE_STREAM')
  }
  if (textBlock === undefined && reasoningBlock === undefined && toolBlocks.size === 0) {
    throw new LlmError(model + ': upstream returned a completion with no content', 'EMPTY_RESPONSE')
  }
  yield* closeBlocks(textBlock, reasoningBlock, toolBlocks, model)
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Close every open block, in allocation order, as one chunk list. */
function* closeBlocks(
  textBlock: OpenBlock | undefined,
  reasoningBlock: OpenBlock | undefined,
  toolBlocks: ReadonlyMap<number, OpenBlock>,
  model: string,
): Generator<StreamChunk> {
  const blocks: OpenBlock[] = []
  if (textBlock !== undefined) blocks.push(textBlock)
  if (reasoningBlock !== undefined) blocks.push(reasoningBlock)
  blocks.push(...toolBlocks.values())
  blocks.sort((left, right) => left.index - right.index)
  for (const block of blocks) {
    if (block.type === 'text') {
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      continue
    }
    if (block.type === 'reasoning') {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      continue
    }
    if (block.name === undefined) {
      throw new LlmError(model + ': upstream streamed a tool call without a name', 'MALFORMED_RESPONSE')
    }
    yield {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.id ?? 'call_' + String(block.index)),
        name: block.name,
        arguments: block.arguments,
      },
    }
  }
}
